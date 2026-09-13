/**
 * End-to-end geometry of a compact row click: raw SGR bytes into the real
 * terminal, through InputController's inline-mouse handler, the composer's
 * published spans, and into the clicked component. Unit coverage of the
 * router cannot see a viewport/span offset; only the painted frame can.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
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
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, new Composer({ terminal: term }));
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** A settled two-call group of one tool, mounted straight into the transcript. */
	function addGroup(tool: string, label: string, args: [Record<string, unknown>, Record<string, unknown>]): CompactToolCallComponent {
		const group = new CompactToolCallComponent();
		const prefix = `${tool}-${mode.chatContainer.children.length}`;
		group.addCall(`${prefix}-1`, tool, label, args[0], undefined);
		group.addCall(`${prefix}-2`, tool, label, args[1], undefined);
		group.updateResult({ content: [{ type: "text", text: `${tool} out one` }], isError: false }, false, `${prefix}-1`);
		group.updateResult({ content: [{ type: "text", text: `${tool} out two` }], isError: false }, false, `${prefix}-2`);
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

	it("offers no click target for rows that already went to native scrollback", async () => {
		term = new VirtualTerminal(120, 14);
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, new Composer({ terminal: term }));
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const group = new CompactToolCallComponent();
		for (let index = 0; index < 24; index++) {
			group.addCall(`call-${index}`, "bash", "Bash", { command: `echo cmd-${index}` }, undefined);
			group.updateResult({ content: [{ type: "text", text: `out-${index}` }], isError: false }, false, `call-${index}`);
		}
		group.seal();
		group.setExpanded(true);
		mode.chatContainer.addChild(group);
		mode.ui.requestRender();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("echo cmd-23")));

		// Retirement printed the block's rows into the terminal's own scrollback:
		// they sit above the mutable window, where nothing can repaint them.
		const rows = plainRows(term.getViewport());
		const targetRow = rows.findIndex(row => row.includes("echo cmd-23"));
		expect(targetRow).toBeGreaterThanOrEqual(0);
		expect(targetRow).toBeLessThan(mode.ui.getMutableViewport().top);

		term.sendInput(`\x1b[<0;1;${targetRow + 1}M`);
		await term.waitForRender();
		// The click is swallowed, never misrouted onto a live row of another block.
		expect(plainRows(group.render(120)).join("\n")).not.toContain("out-23");
	});
});
