/**
 * End-to-end geometry of grouped parent-row clicks: raw SGR bytes travel
 * through InputController, Composer's published spans, and the transcript
 * component that owns the clicked parent.
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
});
