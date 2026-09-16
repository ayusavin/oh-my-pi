/**
 * End-to-end geometry of grouped parent-row clicks: raw SGR bytes travel
 * through InputController, Composer's published spans, and the transcript
 * component that owns the clicked parent.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Text } from "@oh-my-pi/pi-tui";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	Composer,
	routeViewportClickAction,
	routeViewportClickOwner,
	type ViewportClickSpan,
} from "@oh-my-pi/pi-coding-agent/modes/composer";
import { CompactToolCallComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-call-compact";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

describe("compact row click span routing", () => {
	it("returns an owner only for rows inside its span", () => {
		const owner = new Text("owner");
		const spans: ViewportClickSpan[] = [{ start: 2, end: 4, candidates: () => [], owner }];

		expect(routeViewportClickOwner(spans, 3)).toBe(owner);
		expect(routeViewportClickOwner(spans, 4)).toBeUndefined();
	});

	it("routes an action without a span owner", () => {
		let hitLocal = -1;
		const spans: ViewportClickSpan[] = [
			{
				start: 2,
				end: 4,
				candidates: () => [],
				action: local => {
					hitLocal = local;
				},
			},
		];

		routeViewportClickAction(spans, 3)!(99);
		expect(hitLocal).toBe(1);
	});
});

describe("compact row click geometry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-compact-click-e2e-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		settings.set("tui.mouse", true);
		settings.set("display.toolCalls", "grouped");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = new VirtualTerminal(40, 32);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: term }),
		);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function addGroup(
		toolName: string,
		label: string,
		firstArgs: Record<string, unknown>,
		secondArgs: Record<string, unknown>,
		outputPrefix: string | undefined,
		sealed: boolean,
	): CompactToolCallComponent {
		const group = new CompactToolCallComponent();
		const prefix = `${toolName}-${mode.chatContainer.children.length}`;
		group.addCall(`${prefix}-1`, toolName, label, firstArgs, undefined);
		group.addCall(`${prefix}-2`, toolName, label, secondArgs, undefined);
		if (outputPrefix !== undefined) {
			group.updateResult(
				{ content: [{ type: "text", text: `${outputPrefix} out one` }], isError: false },
				false,
				`${prefix}-1`,
			);
			group.updateResult(
				{ content: [{ type: "text", text: `${outputPrefix} out two` }], isError: false },
				false,
				`${prefix}-2`,
			);
		}
		if (sealed) group.seal();
		mode.chatContainer.addChild(group);
		return group;
	}

	async function commitGroup(group: CompactToolCallComponent): Promise<CompactToolCallComponent[]> {
		const fillers: CompactToolCallComponent[] = [];
		for (let index = 0; index < 40; index++) {
			const filler = addGroup(
				"bash",
				"Bash",
				{ command: `echo filler-${index}-one` },
				{ command: `echo filler-${index}-two` },
				undefined,
				true,
			);
			fillers.push(filler);
			mode.ui.requestRender();
			await term.waitForRender();
			if (!mode.chatContainer.canRemoveBlock(group)) return fillers;
		}
		throw new Error(`Expected group ${group.render(40).join("\n")} to enter committed history`);
	}

	async function revealCommittedGroup(
		group: CompactToolCallComponent,
		fillers: readonly CompactToolCallComponent[],
	): Promise<number> {
		for (const filler of fillers) {
			if (mode.chatContainer.canRemoveBlock(filler)) mode.chatContainer.removeChild(filler);
		}
		const target = group.historyRowTarget(0);
		if (target === undefined) throw new Error("Expected a compact parent target");
		mode.chatContainer.resetStableEmission();
		mode.ui.resetDisplay();
		await term.waitForRender(() => {
			const mutable = mode.ui.getMutableViewport();
			for (let row = 0; row < mutable.top; row++) {
				if (mode.ui.historyRowTarget(row) === target) return true;
			}
			return false;
		});
		const mutable = mode.ui.getMutableViewport();
		for (let row = 0; row < mutable.top; row++) {
			if (mode.ui.historyRowTarget(row) === target) return row;
		}
		throw new Error("Expected committed parent target to remain on screen");
	}

	it("expands and collapses every card from the same live parent row", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const group = addGroup(
			"grep",
			"Grep",
			{ pattern: "alpha", path: "src/alpha" },
			{ pattern: "beta", path: "src/beta" },
			"grep",
			false,
		);
		mode.ui.requestRender();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("2 searches")));

		expect(group.render(120)).toHaveLength(1);
		const parentRow = plainRows(term.getViewport()).findIndex(row => row.includes("2 searches"));
		expect(parentRow).toBeGreaterThanOrEqual(0);
		term.sendInput(`\x1b[<35;2;${parentRow + 1}M`);
		await term.waitForRender(() => term.getViewportRowUnderlineColumns(parentRow).length > 0);

		term.sendInput(`\x1b[<0;1;${parentRow + 1}M`);
		await term.waitForRender(() => {
			const rows = plainRows(term.getViewport());
			return rows.some(row => row.includes("grep out one")) && rows.some(row => row.includes("grep out two"));
		});

		const expandedParentRow = plainRows(term.getViewport()).findIndex(row => row.includes("2 searches"));
		expect(expandedParentRow).toBeGreaterThanOrEqual(0);
		term.sendInput(`\x1b[<0;1;${expandedParentRow + 1}M`);
		await term.waitForRender(() => !plainRows(term.getViewport()).some(row => row.includes("grep out one")));
		expect(group.render(120)).toHaveLength(1);
	});

	it("toggles a visible committed group by resetting and replaying the transcript", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const group = addGroup(
			"grep",
			"Grep",
			{ pattern: "committed-one", path: "src" },
			{ pattern: "committed-two", path: "src" },
			"committed",
			true,
		);
		const parentRow = await revealCommittedGroup(group, await commitGroup(group));
		expect(group.render(120)).toHaveLength(1);

		term.sendInput(`\x1b[<0;1;${parentRow + 1}M`);
		await term.waitForRender(() => {
			const rows = plainRows(term.getViewport());
			return (
				rows.some(row => row.includes("committed out one")) && rows.some(row => row.includes("committed out two"))
			);
		});

		expect(group.render(120).length).toBeGreaterThan(1);
	});

	it("leaves committed card and non-group rows inert", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		mode.chatContainer.addChild(new Text("committed non-group row"));
		const group = addGroup(
			"grep",
			"Grep",
			{ pattern: "inert-one", path: "src" },
			{ pattern: "inert-two", path: "src" },
			"inert",
			true,
		);
		await revealCommittedGroup(group, await commitGroup(group));

		group.setExpanded(true);
		mode.chatContainer.resetStableEmission();
		mode.ui.resetDisplay();
		await term.waitForRender(() => {
			const rows = plainRows(term.getViewport());
			return (
				rows.some(row => row.includes("inert out one")) && rows.some(row => row.includes("committed non-group row"))
			);
		});

		const rows = plainRows(term.getViewport());
		const cardRow = rows.findIndex(row => row.includes("inert out one"));
		const nonGroupRow = rows.findIndex(row => row.includes("committed non-group row"));
		expect(cardRow).toBeGreaterThanOrEqual(0);
		expect(nonGroupRow).toBeGreaterThanOrEqual(0);
		const mutable = mode.ui.getMutableViewport();
		expect(cardRow).toBeLessThan(mutable.top);
		expect(nonGroupRow).toBeLessThan(mutable.top);
		expect(mode.ui.historyRowTarget(cardRow)).toBeUndefined();
		expect(mode.ui.historyRowTarget(nonGroupRow)).toBeUndefined();

		const expandedRows = group.render(120);
		term.sendInput(`\x1b[<0;1;${cardRow + 1}M`);
		await term.waitForRender();
		expect(group.render(120)).toEqual(expandedRows);
		term.sendInput(`\x1b[<0;1;${nonGroupRow + 1}M`);
		await term.waitForRender();
		expect(group.render(120)).toEqual(expandedRows);
	});

	it("toggles a group from a wrapped physical parent segment", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const group = addGroup(
			"custom_parent",
			"Long Custom Parent Interaction Tool",
			{ input: "first" },
			{ input: "second" },
			"wrapped",
			false,
		);
		mode.ui.requestRender();
		const parentSegments = plainRows(group.render(40));
		expect(parentSegments.length).toBeGreaterThan(1);
		const continuation = parentSegments.at(-1)!;
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes(continuation)));

		const continuationRow = plainRows(term.getViewport()).findIndex(row => row.includes(continuation));
		expect(continuationRow).toBeGreaterThanOrEqual(0);
		term.sendInput(`\x1b[<35;2;${continuationRow + 1}M`);
		await term.waitForRender(() => term.getViewportRowUnderlineColumns(continuationRow).length > 0);

		term.sendInput(`\x1b[<0;1;${continuationRow + 1}M`);
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("wrapped out one")));
	});

	it("keeps a live grouped parent clickable above an expanded logs result", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const earlyLine = "EARLY_CHILD_SCREEN_LINE";
		const tailLine = "LATE_CHILD_SCREEN_LINE";
		const terminalRows = Array.from({ length: 80 }, (_, index) =>
			index === 0 ? earlyLine : index === 79 ? tailLine : `CHILD_SCREEN_LINE_${index.toString().padStart(2, "0")}`,
		);
		const group = new CompactToolCallComponent();
		group.addCall("hub-logs-short", "hub", "Hub", { op: "logs", name: "child-screen" }, undefined);
		group.addCall("hub-logs-tall", "hub", "Hub", { op: "logs", name: "child-screen" }, undefined);
		group.updateResult(
			{
				content: [{ type: "text", text: "SHORT_CHILD_SCREEN_LINE" }],
				details: {
					op: "logs",
					state: "exited",
					cursor: 1,
					terminalRows: ["SHORT_CHILD_SCREEN_LINE"],
				},
				isError: false,
			},
			false,
			"hub-logs-short",
		);
		group.updateResult(
			{
				content: [{ type: "text", text: terminalRows.join("\n") }],
				details: { op: "logs", state: "exited", cursor: terminalRows.length, terminalRows },
				isError: false,
			},
			false,
			"hub-logs-tall",
		);
		mode.chatContainer.addChild(group);
		mode.ui.requestRender();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("2 hub calls")));

		const parentRow = plainRows(term.getViewport()).findIndex(row => row.includes("2 hub calls"));
		expect(parentRow).toBeGreaterThanOrEqual(0);
		term.sendInput(`\x1b[<0;1;${parentRow + 1}M`);
		await term.waitForRender(() => {
			const rows = plainRows(term.getViewport());
			return (
				rows.some(row => row.includes("2 hub calls")) &&
				rows.some(row => row.includes(tailLine)) &&
				!rows.some(row => row.includes(earlyLine))
			);
		});

		const expandedRows = plainRows(term.getViewport());
		expect(expandedRows.some(row => row.includes("2 hub calls"))).toBe(true);
		expect(expandedRows.some(row => row.includes(tailLine))).toBe(true);
		expect(expandedRows.some(row => row.includes(earlyLine))).toBe(false);
		const expandedParentRow = expandedRows.findIndex(row => row.includes("2 hub calls"));
		expect(expandedParentRow).toBeGreaterThanOrEqual(0);
		term.sendInput(`\x1b[<0;1;${expandedParentRow + 1}M`);
		await term.waitForRender(() => {
			const rows = plainRows(term.getViewport());
			return (
				rows.filter(row => row.includes("2 hub calls")).length === 1 &&
				!rows.some(row => row.includes(tailLine)) &&
				!rows.some(row => row.includes("detail rows omitted"))
			);
		});

		const collapsedRows = plainRows(term.getViewport());
		expect(collapsedRows.filter(row => row.includes("2 hub calls"))).toHaveLength(1);
		expect(collapsedRows.some(row => row.includes(tailLine))).toBe(false);
		expect(collapsedRows.some(row => row.includes("detail rows omitted"))).toBe(false);
	});

	it("reports exact omitted detail rows within its allocation", () => {
		const group = new CompactToolCallComponent();
		const terminalRows = Array.from({ length: 8 }, (_, index) => `DETAIL_ROW_${index}`);
		group.addCall("hub-logs-one", "hub", "Hub", { op: "logs", name: "child-screen" }, undefined);
		group.addCall("hub-logs-two", "hub", "Hub", { op: "logs", name: "child-screen" }, undefined);
		for (const toolCallId of ["hub-logs-one", "hub-logs-two"]) {
			group.updateResult(
				{
					content: [{ type: "text", text: terminalRows.join("\n") }],
					details: { op: "logs", state: "exited", cursor: terminalRows.length, terminalRows },
					isError: false,
				},
				false,
				toolCallId,
			);
		}

		const collapsedParentRows = plainRows(group.render(120));
		group.setExpanded(true);
		const fullRows = plainRows(group.render(120));
		const parentRowCount = collapsedParentRows.length;
		const detailRows = fullRows.slice(parentRowCount);
		const allocation = parentRowCount + 3;
		group.setTranscriptAllocation(allocation, { tick: 0, now: 0 });
		const clippedRows = plainRows(group.render(120));

		expect(clippedRows.length).toBeLessThanOrEqual(allocation);
		expect(clippedRows.slice(0, parentRowCount)).toEqual(fullRows.slice(0, parentRowCount));
		expect(clippedRows[parentRowCount]).toContain(`… ${detailRows.length - 2} detail rows omitted`);
		expect(clippedRows.slice(parentRowCount + 1)).toEqual(detailRows.slice(-2));
	});
});
