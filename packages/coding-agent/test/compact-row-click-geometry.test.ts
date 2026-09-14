/**
 * End-to-end geometry of a compact row click: raw SGR bytes into the real
 * terminal, through InputController's inline-mouse handler, the composer's
 * published spans, and into the clicked component. Unit coverage of the
 * router cannot see a viewport/span offset; only the painted frame can.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { CompactToolCallComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-call-compact";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Text } from "@oh-my-pi/pi-tui";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

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
		term = new VirtualTerminal(120, 32);
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

	/** A settled two-call group of one tool, mounted straight into the transcript. */
	function addGroup(
		tool: string,
		label: string,
		args: [Record<string, unknown>, Record<string, unknown>],
	): CompactToolCallComponent {
		const group = new CompactToolCallComponent();
		const prefix = `${tool}-${mode.chatContainer.children.length}`;
		group.addCall(`${prefix}-1`, tool, label, args[0], undefined);
		group.addCall(`${prefix}-2`, tool, label, args[1], undefined);
		group.updateResult(
			{ content: [{ type: "text", text: `${tool} out one` }], isError: false },
			false,
			`${prefix}-1`,
		);
		group.updateResult(
			{ content: [{ type: "text", text: `${tool} out two` }], isError: false },
			false,
			`${prefix}-2`,
		);
		group.seal();
		mode.chatContainer.addChild(group);
		return group;
	}

	it("expands exactly the group whose summary row was clicked", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const bash = addGroup("bash", "Bash", [{ command: "echo one" }, { command: "echo two" }]);
		const grep = addGroup("grep", "Grep", [
			{ pattern: "alpha", path: "src" },
			{ pattern: "beta", path: "src" },
		]);
		const glob = addGroup("glob", "Glob", [{ path: "src/**/*.ts" }, { path: "test/**/*.ts" }]);
		mode.ui.requestRender();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("2 globs")));

		const viewport = plainRows(term.getViewport());
		const screenRow = viewport.findIndex(row => row.includes("2 searches"));
		expect(screenRow).toBeGreaterThanOrEqual(0);

		// Exactly what the terminal reports for a left click on that row.
		term.sendInput(`\x1b[<0;1;${screenRow + 1}M`);
		await term.waitForRender();

		expect(grep.render(120)).toHaveLength(3);
		expect(bash.render(120)).toHaveLength(1);
		expect(glob.render(120)).toHaveLength(1);
	});

	it("underlines the hovered clickable row and drops the rule when the pointer leaves", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		addGroup("bash", "Bash", [{ command: "echo one" }, { command: "echo two" }]);
		mode.ui.requestRender();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("2 shell commands")));

		const screenRow = plainRows(term.getViewport()).findIndex(row => row.includes("2 shell commands"));
		expect(screenRow).toBeGreaterThanOrEqual(0);
		expect(term.getViewportRowUnderlineColumns(screenRow)).toHaveLength(0);

		// Motion with no button held is what a hover sends.
		term.sendInput(`\x1b[<35;2;${screenRow + 1}M`);
		await term.waitForRender(() => term.getViewportRowUnderlineColumns(screenRow).length > 0);
		const underlined = term.getViewportRowUnderlineColumns(screenRow);
		// The rule spans the band, not just the plain text before the first reset.
		expect(underlined.length).toBeGreaterThan("▸ • 2 shell commands".length);

		// Off the row: the affordance must not stick.
		const emptyRow = plainRows(term.getViewport()).findIndex((row, index) => index > screenRow && row.length === 0);
		term.sendInput(`\x1b[<35;2;${(emptyRow >= 0 ? emptyRow : screenRow + 1) + 1}M`);
		await term.waitForRender(() => term.getViewportRowUnderlineColumns(screenRow).length === 0);
		expect(term.getViewportRowUnderlineColumns(screenRow)).toHaveLength(0);
	});

	it("opens the clicked call's card, then closes it on a second click of its own row", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		addGroup("bash", "Bash", [{ command: "echo one" }, { command: "echo two" }]);
		const grep = addGroup("grep", "Grep", [
			{ pattern: "alpha", path: "src/alpha" },
			{ pattern: "beta", path: "src/beta" },
		]);
		mode.ui.requestRender();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("2 searches")));

		const summaryRow = plainRows(term.getViewport()).findIndex(row => row.includes("2 searches"));
		term.sendInput(`\x1b[<0;1;${summaryRow + 1}M`);
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("beta")));

		const betaRow = plainRows(term.getViewport()).findIndex(row => row.includes("beta"));
		term.sendInput(`\x1b[<0;1;${betaRow + 1}M`);
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("grep out two")));
		expect(plainRows(grep.render(120)).join("\n")).toContain("grep out two");

		const openRow = plainRows(term.getViewport()).findIndex(row => row.includes("grep out two"));
		term.sendInput(`\x1b[<0;1;${openRow + 1}M`);
		await term.waitForRender(() => !plainRows(term.getViewport()).some(row => row.includes("grep out two")));
		expect(grep.render(120)).toHaveLength(3);
	});

	it("expands a still-running group whose last call has no result yet", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		// The live shape from a turn in flight: settled calls plus one pending,
		// never sealed, mounted while the group is still receiving calls.
		const group = new CompactToolCallComponent();
		group.addCall("live-1", "todo", "Todo", { op: "view" }, undefined);
		group.updateResult({ content: [{ type: "text", text: "todo ok" }], isError: false }, false, "live-1");
		group.addCall("live-2", "bash", "Bash", { command: "echo live" }, undefined);
		group.updateResult({ content: [{ type: "text", text: "live out" }], isError: false }, false, "live-2");
		group.addCall("live-3", "read", "Read", { path: "src/live.ts" }, undefined);
		mode.chatContainer.addChild(group);
		mode.ui.requestRender();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("1 todo update")));

		const summaryRow = plainRows(term.getViewport()).findIndex(row => row.includes("1 todo update"));
		expect(summaryRow).toBeGreaterThanOrEqual(0);
		term.sendInput(`\x1b[<0;1;${summaryRow + 1}M`);
		await term.waitForRender();

		const rendered = plainRows(group.render(120));
		expect(rendered.length).toBeGreaterThan(1);
		expect(rendered.join("\n")).toContain("echo live");
	});

	it("shows the expanded calls of a running group even when the live tail is short of rows", async () => {
		term = new VirtualTerminal(120, 10);
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
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const group = new CompactToolCallComponent();
		for (let index = 0; index < 7; index++) {
			group.addCall(`p-${index}`, "bash", "Bash", { command: `echo p-${index}` }, undefined);
			group.updateResult({ content: [{ type: "text", text: `out-${index}` }], isError: false }, false, `p-${index}`);
		}
		// Never sealed: a turn in flight, so the block cannot retire.
		group.addCall("p-live", "eval", "Eval", { code: "1+1" }, undefined);
		mode.chatContainer.addChild(group);
		mode.ui.requestRender();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("7 shell commands")));

		const summaryRow = plainRows(term.getViewport()).findIndex(row => row.includes("7 shell commands"));
		expect(summaryRow).toBeGreaterThanOrEqual(0);
		term.sendInput(`\x1b[<0;1;${summaryRow + 1}M`);
		await term.waitForRender();

		expect(plainRows(group.render(120)).length).toBeGreaterThan(1);
		// The painted frame must actually show what the click opened.
		expect(plainRows(term.getViewport()).join("\n")).toContain("echo p-6");
	});

	it("expands a group the live event stream built, clicked while the turn is still open", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		// The real mount path: EventController streams tool calls into the
		// transcript exactly as a turn in flight does, with no result for the
		// last one, so the group stays live and unsealed.
		const message = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "live-a", name: "bash", arguments: { command: "echo alpha" } },
				{ type: "toolCall", id: "live-b", name: "bash", arguments: { command: "echo beta" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as unknown as AssistantMessage;

		await mode.eventController.handleEvent({ type: "message_start", message } as AgentSessionEvent);
		await mode.eventController.handleEvent({ type: "message_update", message } as AgentSessionEvent);
		mode.ui.requestRender();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("2 shell commands")));

		const summaryRow = plainRows(term.getViewport()).findIndex(row => row.includes("2 shell commands"));
		expect(summaryRow).toBeGreaterThanOrEqual(0);
		term.sendInput(`\x1b[<0;1;${summaryRow + 1}M`);
		await term.waitForRender();

		expect(plainRows(term.getViewport()).join("\n")).toContain("echo beta");
	});

	it("opens a clicked group even when a tall todo HUD squeezes the transcript to one row", async () => {
		term = new VirtualTerminal(120, 16);
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
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		// A live turn's own group: settled calls plus one pending, never sealed.
		const group = new CompactToolCallComponent();
		for (let index = 0; index < 7; index++) {
			group.addCall(`h-${index}`, "bash", "Bash", { command: `echo h-${index}` }, undefined);
			group.updateResult({ content: [{ type: "text", text: `out-${index}` }], isError: false }, false, `h-${index}`);
		}
		group.addCall("h-live", "eval", "Eval", { code: "1+1" }, undefined);
		mode.chatContainer.addChild(group);
		// The HUD the user actually had on screen: a multi-line todo list under
		// the transcript, which eats the rows the transcript would have used.
		mode.todoContainer.addChild(
			new Text(["TODO", ...Array.from({ length: 9 }, (_, i) => `  item ${i}`)].join("\n"), 1, 0),
		);
		mode.ui.requestRender();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("7 shell commands")));

		const summaryRow = plainRows(term.getViewport()).findIndex(row => row.includes("7 shell commands"));
		expect(summaryRow).toBeGreaterThanOrEqual(0);
		term.sendInput(`\x1b[<0;1;${summaryRow + 1}M`);
		await term.waitForRender();

		expect(plainRows(term.getViewport()).join("\n")).toContain("echo h-6");
	});

	it("reuses one semantic raised copy for a restored compact row", async () => {
		term = new VirtualTerminal(120, 32);
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
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const group = new CompactToolCallComponent();
		for (let index = 0; index < 48; index++) {
			group.addCall(`call-${index}`, "bash", "Bash", { command: `echo cmd-${index}` }, undefined);
			group.updateResult(
				{ content: [{ type: "text", text: `out-${index}` }], isError: false },
				false,
				`call-${index}`,
			);
		}
		group.seal();
		group.setExpanded(true);
		mode.chatContainer.addChild(group);
		mode.ui.requestRender();
		await term.waitForRender(() => {
			const viewport = plainRows(term.getViewport());
			const mutableTop = mode.ui.getMutableViewport().top;
			return viewport.some(
				(row, index) =>
					index < mutableTop && row.includes("echo cmd-") && mode.ui.historyRowTarget(index) !== undefined,
			);
		});

		const rows = plainRows(term.getViewport());
		const mutableTop = mode.ui.getMutableViewport().top;
		const targetRow = rows.findLastIndex(
			(row, index) =>
				index < mutableTop && row.includes("echo cmd-") && mode.ui.historyRowTarget(index) !== undefined,
		);
		expect(targetRow).toBeGreaterThanOrEqual(0);
		const target = mode.ui.historyRowTarget(targetRow);
		expect(target).toBeDefined();
		const command = rows[targetRow]!.match(/echo cmd-(\d+)/)?.[1];
		expect(command).toBeDefined();
		expect(term.getViewportRowUnderlineColumns(targetRow)).toHaveLength(0);
		term.sendInput(`\x1b[<35;2;${targetRow + 1}M`);
		await term.waitForRender(() => term.getViewportRowUnderlineColumns(targetRow).length > 0);

		term.resize(119, 32);
		await term.waitForRender(() => {
			const resizedRows = plainRows(term.getViewport());
			const resizedMutableTop = mode.ui.getMutableViewport().top;
			return resizedRows.some(
				(row, index) =>
					index < resizedMutableTop &&
					row.includes(`echo cmd-${command}`) &&
					mode.ui.historyRowTarget(index) === target,
			);
		});
		const resizedRows = plainRows(term.getViewport());
		const resizedMutableTop = mode.ui.getMutableViewport().top;
		const resizedTargetRow = resizedRows.findLastIndex(
			(row, index) =>
				index < resizedMutableTop &&
				row.includes(`echo cmd-${command}`) &&
				mode.ui.historyRowTarget(index) === target,
		);
		expect(resizedTargetRow).toBeGreaterThanOrEqual(0);
		const resizedTarget = mode.ui.historyRowTarget(resizedTargetRow);
		expect(resizedTarget).toBe(target);
		expect(term.getViewportRowUnderlineColumns(resizedTargetRow)).toHaveLength(0);
		term.sendInput(`\x1b[<35;2;${resizedTargetRow + 1}M`);
		await term.waitForRender(() => term.getViewportRowUnderlineColumns(resizedTargetRow).length > 0);

		// The immutable row still reads expanded even after current component
		// state changes; its captured semantic target must follow what was shown.
		group.setExpanded(false);
		expect(plainRows(group.render(120)).join("\n")).not.toContain(`echo cmd-${command}`);

		const childCount = mode.chatContainer.children.length;
		term.sendInput(`\x1b[<0;1;${resizedTargetRow + 1}M`);
		expect(mode.chatContainer.children).toHaveLength(childCount + 1);
		const raised = mode.chatContainer.children.at(-1);
		expect(raised).toBeInstanceOf(CompactToolCallComponent);
		expect(mode.chatContainer.ownsMutableHistoryComponent(raised!)).toBe(true);
		expect(plainRows(raised!.render(120)).join("\n")).toContain(`out-${command}`);

		// Re-dispatching the same retained row toggles the still-mutable raised copy.
		const secondClick = mode.resolveHistoryClickAction(resizedTarget);
		expect(secondClick).toBeDefined();
		secondClick?.();
		expect(mode.chatContainer.children).toHaveLength(childCount + 1);
		expect(plainRows(raised!.render(120)).join("\n")).not.toContain(`out-${command}`);
	});

	it("keeps wrapped standalone physical history targets distinct", () => {
		const callId = "standalone-wrapped";
		const standalone = new CompactToolCallComponent();
		standalone.addCall(
			callId,
			"bash",
			"Bash",
			{ command: "echo standalone-header 0123456789 continuation-marker" },
			undefined,
		);
		standalone.updateResult(
			{ content: [{ type: "text", text: "STANDALONE-OUTPUT" }], isError: false },
			false,
			callId,
		);
		standalone.seal();

		const rows = plainRows(standalone.render(40));
		const headerRow = rows.findIndex(row => row.includes("Bash(echo standalone-header"));
		expect(headerRow).toBeGreaterThanOrEqual(0);
		const continuationRow = rows.findIndex((row, index) => index > headerRow && row.includes("continuation-marker"));
		expect(continuationRow).toBeGreaterThan(headerRow);

		const headerTarget = standalone.historyTarget(headerRow);
		const continuationTarget = standalone.historyTarget(continuationRow);
		expect(headerTarget).toBeDefined();
		expect(continuationTarget).toBeDefined();
		expect(continuationTarget).not.toBe(headerTarget);
	});

	it("opens the wrapped expanded call continuation instead of the next call", async () => {
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
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const callCount = 24;
		const group = new CompactToolCallComponent();
		for (let index = 0; index < callCount; index++) {
			const callId = `wrapped-call-${index}`;
			const command =
				index === callCount - 1
					? `echo wrapped-${index} compact history terminal tail-${index}`
					: `echo wrapped-${index} compact history continuation marker-${index}`;
			group.addCall(callId, "bash", "Bash", { command }, undefined);
			group.updateResult(
				{ content: [{ type: "text", text: `EXPANDED-OUTPUT-${index}` }], isError: false },
				false,
				callId,
			);
		}
		group.seal();
		group.setExpanded(true);
		mode.chatContainer.addChild(group);
		mode.ui.requestRender();
		await term.waitForRender(() => {
			const rows = plainRows(term.getViewport());
			const mutableTop = mode.ui.getMutableViewport().top;
			return rows.some(
				(row, index) =>
					index < mutableTop &&
					row.includes("continuation marker-") &&
					mode.ui.historyRowTarget(index) !== undefined,
			);
		});

		const rows = plainRows(term.getViewport());
		const mutableTop = mode.ui.getMutableViewport().top;
		const continuationRow = rows.findLastIndex(
			(row, index) =>
				index < mutableTop && row.includes("continuation marker-") && mode.ui.historyRowTarget(index) !== undefined,
		);
		expect(continuationRow).toBeGreaterThanOrEqual(0);
		expect(continuationRow).toBeLessThan(mutableTop);
		const continuationTarget = mode.ui.historyRowTarget(continuationRow);
		expect(continuationTarget).toBeDefined();
		const callId = rows[continuationRow]!.match(/continuation marker-(\d+)/)?.[1];
		expect(callId).toBeDefined();
		const callIndex = Number(callId);
		expect(callIndex).toBeGreaterThanOrEqual(0);
		expect(callIndex).toBeLessThan(callCount - 1);

		const headerRow = rows.findLastIndex(
			(row, index) =>
				index < mutableTop &&
				row.includes(`Bash(echo wrapped-${callIndex} compact`) &&
				mode.ui.historyRowTarget(index) !== undefined,
		);
		expect(headerRow).toBeGreaterThanOrEqual(0);
		expect(headerRow).toBeLessThan(continuationRow);
		const headerTarget = mode.ui.historyRowTarget(headerRow);
		expect(headerTarget).toBeDefined();
		expect(continuationTarget).not.toBe(headerTarget);

		term.sendInput(`\x1b[<35;2;${continuationRow + 1}M`);
		await term.waitForRender(
			() =>
				term.getViewportRowUnderlineColumns(continuationRow).length > 0 &&
				term.getViewportRowUnderlineColumns(headerRow).length === 0,
		);
		expect(term.getViewportRowUnderlineColumns(continuationRow)).not.toHaveLength(0);
		expect(term.getViewportRowUnderlineColumns(headerRow)).toHaveLength(0);

		term.sendInput(`\x1b[<0;1;${continuationRow + 1}M`);
		await term.waitForRender(() =>
			plainRows(term.getViewport()).some(row => row.includes(`EXPANDED-OUTPUT-${callIndex}`)),
		);

		const openedRows = plainRows(term.getViewport()).join("\n");
		expect(openedRows).toContain(`EXPANDED-OUTPUT-${callIndex}`);
		expect(openedRows).not.toContain(`EXPANDED-OUTPUT-${callIndex + 1}`);
	});
});
