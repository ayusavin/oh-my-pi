import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	COMPOSER_DEFAULTS,
	Composer,
	resolveHistoryRowTarget,
	routeViewportClickAction,
	routeViewportClickOwner,
	type ViewportClickSpan,
} from "@oh-my-pi/pi-coding-agent/modes/composer";
import { CompactToolCallComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-call-compact";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Text } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

function settledCompactRow(id: string, command: string): CompactToolCallComponent {
	const row = new CompactToolCallComponent();
	row.addCall(id, "bash", "Bash", { command, i: "Inspect source" }, undefined);
	row.updateResult({ content: [{ type: "text", text: `${id} output` }], isError: false }, false, id);
	return row;
}

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

function expandedHubLogRow(): CompactToolCallComponent {
	const row = new CompactToolCallComponent();
	row.addCall("hub-log", "hub", "Hub", { op: "logs", name: "worker" }, undefined);
	row.updateResult(
		{
			content: [{ type: "text", text: "LOG-HEAD: worker started\nLOG-TAIL: worker stopped" }],
			details: {
				op: "logs",
				state: "running",
				cursor: 17,
				terminalRows: [
					"LOG-HEAD: worker started",
					"LOG-ONE: preparing",
					"LOG-TWO: processing",
					"LOG-THREE: writing",
					"LOG-FOUR: verifying",
					"LOG-TAIL: worker stopped",
				],
			},
			isError: false,
		},
		false,
		"hub-log",
	);
	row.setExpanded(true);
	return row;
}

describe("compact row click span routing", () => {
	it("returns an owner only for rows inside its span", () => {
		const owner = new Text("owner");
		const spans: ViewportClickSpan[] = [{ start: 2, end: 4, candidates: () => [], owner }];

		expect(routeViewportClickOwner(spans, 3)).toBe(owner);
		expect(routeViewportClickOwner(spans, 4)).toBeUndefined();
	});

	it("routes an action with its span-local row", () => {
		let local = -1;
		const spans: ViewportClickSpan[] = [{ start: 2, end: 4, candidates: () => [], action: row => (local = row) }];

		expect(routeViewportClickOwner(spans, 3)).toBeUndefined();
		routeViewportClickAction(spans, 3)!(99);
		expect(local).toBe(1);
	});

	it("keeps an owner with its span-local action", () => {
		const owner = new Text("owner");
		let local = -1;
		const spans: ViewportClickSpan[] = [
			{ start: 2, end: 4, candidates: () => [], owner, action: row => (local = row) },
		];

		expect(routeViewportClickOwner(spans, 3)).toBe(owner);
		routeViewportClickAction(spans, 3)!(99);
		expect(local).toBe(1);
	});
});

describe("compact row click geometry", () => {
	beforeAll(() => {
		initTheme();
	});

	it("expands only the clicked compact call through a real Composer frame", () => {
		const terminal = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const first = settledCompactRow("call-1", "echo one");
			const second = settledCompactRow("call-2", "echo two");
			transcript.addChild(first);
			transcript.addChild(second);
			composer.setRuntimeChildren([transcript]);

			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const firstRow = frame.viewport.findIndex(line => Bun.stripANSI(line).includes("Bash(echo one)"));
			expect(firstRow).toBeGreaterThanOrEqual(0);
			composer.viewportClickAction(firstRow)!(firstRow);

			const expanded = Bun.stripANSI(composer.renderFrame({ columns: 80, rows: 24 }).viewport.join("\n"));
			expect(expanded).toContain("call-1 output");
			expect(expanded).toContain("Bash(echo two)");
			expect(expanded).not.toContain("call-2 output");
		} finally {
			composer.stop();
		}
	});

	it("lets global Verbose expansion override a local collapsed row", () => {
		const row = settledCompactRow("call-1", "echo one");
		row.getViewportClickAction()!(0);
		row.getViewportClickAction()!(0);
		expect(Bun.stripANSI(row.render(120).join("\n"))).not.toContain("call-1 output");

		row.setExpanded(true);
		expect(Bun.stripANSI(row.render(120).join("\n"))).toContain("call-1 output");
	});
});

describe("compact row viewport and history coverage", () => {
	beforeAll(() => {
		initTheme();
	});

	it("gives only compact parent rows live actions and leaves full-card detail rows inert", () => {
		const terminal = new VirtualTerminal(120, 24);
		const composer = new Composer({ terminal, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const row = expandedHubLogRow();
			transcript.addChild(row);
			composer.setRuntimeChildren([transcript]);

			const frame = composer.renderFrame({ columns: 120, rows: 24 });
			const parentRow = frame.viewport.findIndex(line => Bun.stripANSI(line).includes("Hub(logs worker)"));
			const detailRow = frame.viewport.findIndex(line => Bun.stripANSI(line).includes("LOG-TAIL: worker stopped"));
			expect(parentRow).toBeGreaterThanOrEqual(0);
			expect(detailRow).toBeGreaterThan(parentRow);

			expect(composer.viewportClickOwner(parentRow)).toBe(row);
			expect(composer.viewportClickCandidates(parentRow)).toHaveLength(1);
			expect(composer.viewportClickAction(parentRow)).toBeDefined();
			expect(composer.viewportClickOwner(detailRow)).toBe(row);
			expect(composer.viewportClickCandidates(detailRow)).toEqual([]);
			const detailAction = composer.viewportClickAction(detailRow);
			const detailBefore = Bun.stripANSI(row.render(120).join("\n"));
			detailAction?.(detailRow);
			expect(Bun.stripANSI(row.render(120).join("\n"))).toBe(detailBefore);
		} finally {
			composer.stop();
		}
	});

	it("maps every wrapped compact parent row to its sole history target", () => {
		const row = new CompactToolCallComponent();
		row.addCall(
			"standalone-wrapped",
			"bash",
			"Bash",
			{ command: "echo standalone-header" },
			undefined,
			"Inspect source continuation-marker",
		);
		row.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false, "standalone-wrapped");
		const rows = plainRows(row.render(40));
		const headerRow = rows.findIndex(line => line.toLowerCase().includes("bash(echo standalone-header"));
		const continuationRow = rows.findIndex(
			(line, index) => index > headerRow && line.includes("continuation-marker"),
		);
		expect(headerRow).toBeGreaterThanOrEqual(0);
		expect(continuationRow).toBeGreaterThan(headerRow);

		const headerTarget = row.historyRowTarget(headerRow);
		const continuationTarget = row.historyRowTarget(continuationRow);
		expect(headerTarget).toBeDefined();
		expect(continuationTarget).toBe(headerTarget);
		expect(resolveHistoryRowTarget(headerTarget!)).toBe(row);
		expect(row.getClickFocusAgentIds(headerRow)).toHaveLength(1);
		expect(row.getClickFocusAgentIds(continuationRow)).toHaveLength(1);
	});

	it("keeps an expanded compact parent visible under transcript pressure", () => {
		const row = expandedHubLogRow();
		const parent = plainRows(row.render(120))[0];
		const transcript = new TranscriptContainer();
		transcript.addChild(row);

		const clipped = plainRows(transcript.renderViewport(120, 2, { now: 0, tick: 0 }));
		expect(clipped).toHaveLength(2);
		expect(clipped[0]).toBe(parent);
		expect(clipped[1]).toContain("detail row");
		expect(row.getViewportClickAction()).toBeDefined();
		expect(row.getClickFocusAgentIds(0)).toHaveLength(1);
		expect(row.getClickFocusAgentIds(1)).toEqual([]);
	});

	it("retains the parent, exact omission indicator, and detail tail under full-card allocation", () => {
		const row = expandedHubLogRow();
		row.setExpanded(false);
		const parentRows = plainRows(row.render(120)).length;
		row.setExpanded(true);
		const full = plainRows(row.render(120));
		const parent = full.slice(0, parentRows);
		const details = full.slice(parentRows);
		const visibleTailRows = 3;
		const allocation = parentRows + visibleTailRows + 1;
		expect(details.length).toBeGreaterThan(visibleTailRows);

		row.setTranscriptAllocation(allocation, { now: 0, tick: 0 });
		const clipped = plainRows(row.render(120));
		const omittedDetails = details.length - visibleTailRows;
		const omissionLabel = `… ${omittedDetails} detail row${omittedDetails === 1 ? "" : "s"} omitted`;

		expect(clipped).toHaveLength(allocation);
		expect(clipped.slice(0, parent.length)).toEqual(parent);
		expect(clipped[parent.length]).toContain(omissionLabel);
		expect(clipped.slice(parent.length + 1)).toEqual(full.slice(-visibleTailRows));
		expect(clipped.join("\n")).toContain("LOG-TAIL: worker stopped");
	});
});

describe("compact row InputController integration", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: VirtualTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-compact-click-e2e-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		settings.set("display.toolCalls", "compact");
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
		terminal = new VirtualTerminal(120, 32);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal }),
		);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function startInteractiveMode(): Promise<void> {
		settings.set("tui.mouse", true);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await terminal.waitForRender();
	}

	it("opens only a clicked live compact parent through InputController SGR input, then collapses it", async () => {
		await startInteractiveMode();
		const first = settledCompactRow("live-1", "echo first");
		const second = settledCompactRow("live-2", "echo second");
		const pending = new CompactToolCallComponent();
		pending.addCall("live-pending", "bash", "Bash", { command: "echo still-running" }, undefined);
		const pendingCollapsedRows = plainRows(pending.render(120)).length;
		mode.chatContainer.addChild(first);
		mode.chatContainer.addChild(second);
		mode.chatContainer.addChild(pending);
		mode.ui.requestRender();
		await terminal.waitForRender(() => {
			const viewport = plainRows(terminal.getViewport()).join("\n");
			return (
				viewport.includes("Bash(echo first)") &&
				viewport.includes("Bash(echo second)") &&
				viewport.includes("Bash(echo still-running)")
			);
		});

		const firstRow = plainRows(terminal.getViewport()).findIndex(line => line.includes("Bash(echo first)"));
		expect(firstRow).toBeGreaterThanOrEqual(0);
		expect(mode.resolveViewportClickOwner(firstRow - mode.ui.getMutableViewport().top)).toBe(first);
		terminal.sendInput(`\x1b[<0;1;${firstRow + 1}M`);
		await terminal.waitForRender(() =>
			plainRows(terminal.getViewport()).some(line => line.includes("live-1 output")),
		);

		const opened = plainRows(terminal.getViewport()).join("\n");
		expect(opened).toContain("live-1 output");
		expect(opened).toContain("Bash(echo second)");
		expect(opened).not.toContain("live-2 output");
		const openedParentRow = plainRows(terminal.getViewport()).findIndex(line => line.includes("Bash(echo first)"));
		expect(openedParentRow).toBeGreaterThanOrEqual(0);
		terminal.sendInput(`\x1b[<0;1;${openedParentRow + 1}M`);
		await terminal.waitForRender(
			() => !plainRows(terminal.getViewport()).some(line => line.includes("live-1 output")),
		);

		const pendingRow = plainRows(terminal.getViewport()).findIndex(line => line.includes("Bash(echo still-running)"));
		expect(pendingRow).toBeGreaterThanOrEqual(0);
		terminal.sendInput(`\x1b[<0;1;${pendingRow + 1}M`);
		await terminal.waitForRender();
		expect(plainRows(pending.render(120)).length).toBeGreaterThan(pendingCollapsedRows);
	});

	it("underlines a hovered compact parent and clears the affordance off target", async () => {
		await startInteractiveMode();
		const row = settledCompactRow("hovered", "echo hover");
		mode.chatContainer.addChild(row);
		mode.ui.requestRender();
		await terminal.waitForRender(() =>
			plainRows(terminal.getViewport()).some(line => line.includes("Bash(echo hover)")),
		);

		const parentRow = plainRows(terminal.getViewport()).findIndex(line => line.includes("Bash(echo hover)"));
		expect(parentRow).toBeGreaterThanOrEqual(0);
		expect(terminal.getViewportRowUnderlineColumns(parentRow)).toHaveLength(0);
		terminal.sendInput(`\x1b[<35;2;${parentRow + 1}M`);
		await terminal.waitForRender(() => terminal.getViewportRowUnderlineColumns(parentRow).length > 0);
		expect(terminal.getViewportRowUnderlineColumns(parentRow)).not.toHaveLength(0);

		const outsideRow = terminal.getViewport().length - 1;
		terminal.sendInput(`\x1b[<35;2;${outsideRow + 1}M`);
		await terminal.waitForRender(() => terminal.getViewportRowUnderlineColumns(parentRow).length === 0);
		expect(terminal.getViewportRowUnderlineColumns(parentRow)).toHaveLength(0);
	});

	it("resolves a committed compact parent history target and repaints its card through SGR input", async () => {
		await startInteractiveMode();
		mode.chatContainer.clear();
		const call = settledCompactRow("committed-target", "echo committed-target");
		mode.chatContainer.addChild(call);
		mode.ui.requestRender();
		await terminal.waitForRender();

		const fillers: CompactToolCallComponent[] = [];
		for (let index = 0; index < 48 && mode.chatContainer.canRemoveBlock(call); index++) {
			const filler = settledCompactRow(`filler-${index}`, `echo filler-${index}`);
			fillers.push(filler);
			mode.chatContainer.addChild(filler);
			mode.ui.requestRender();
			await terminal.waitForRender();
		}
		expect(mode.chatContainer.canRemoveBlock(call)).toBe(false);

		for (const filler of fillers) {
			if (mode.chatContainer.canRemoveBlock(filler)) mode.chatContainer.removeChild(filler);
		}
		const historyTarget = call.historyRowTarget(0);
		expect(historyTarget).toBeDefined();
		mode.chatContainer.resetStableEmission();
		mode.ui.resetDisplay();
		await terminal.waitForRender(() => {
			const mutableTop = mode.ui.getMutableViewport().top;
			for (let row = 0; row < mutableTop; row++) {
				if (mode.ui.historyRowTarget(row) === historyTarget) return true;
			}
			return false;
		});

		let mutableTop = mode.ui.getMutableViewport().top;
		let historyRow = -1;
		for (let row = 0; row < mutableTop; row++) {
			if (mode.ui.historyRowTarget(row) === historyTarget) historyRow = row;
		}
		expect(historyRow).toBeGreaterThanOrEqual(0);
		expect(resolveHistoryRowTarget(historyTarget!)).toBe(call);

		terminal.sendInput(`\x1b[<0;1;${historyRow + 1}M`);
		await terminal.waitForRender(() =>
			plainRows(terminal.getViewport()).some(line => line.includes("committed-target output")),
		);
		expect(mode.chatContainer.children).toContain(call);
	});
});
