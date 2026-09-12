import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const ESC = String.fromCharCode(27);
// SGR click on viewport row 1 (1-based y=2): the compact tool-row action
// when the routing override below arms it. The row-2 expander sentinel
// click (EXPANDER_CLICK) falls through to candidates-based focus routing.
const TOOL_ROW_CLICK = `${ESC}[<0;5;2M`;
const EXPANDER_CLICK = `${ESC}[<0;5;3M`;

function makeHarness(overrides?: {
	resolveViewportClickAction?: (index: number) => ((local: number) => void) | undefined;
}) {
	const listeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	const focused: string[] = [];
	let toggled = 0;
	const ctx = {
		ui: {
			addInputListener: (fn: (data: string) => { consume?: boolean; data?: string } | undefined) => {
				listeners.push(fn);
			},
			getMutableViewport: () => ({ top: 0, length: 5 }),
			hasOverlay: () => false,
			requestRender: () => {},
			addStartListener: () => {},
			getFocused: () => undefined,
		},
		handlesBtwBranchKey: () => false,
		editor: {
			getText: () => "",
			setActionKeys: () => {},
			setCustomKeyHandler: () => {},
			clearCustomKeyHandlers: () => {},
		},
		keybindings: KeybindingsManager.inMemory(),
		session: {
			extensionRunner: undefined,
		},
		resolveViewportClickCandidates: (index: number) => (index === 2 ? [PINNED_HUD_TOGGLE_ID] : []),
		resolveViewportClickAction: overrides?.resolveViewportClickAction ?? (() => undefined),
		focusedAgentId: undefined,
		focusAgentSession: async (id: string) => {
			focused.push(id);
		},
		togglePinnedHudExpanded: () => {
			toggled++;
		},
		showStatus: () => {},
		setClickHoverId: () => {},
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupKeyHandlers();
	return {
		listeners,
		click: (data: string = EXPANDER_CLICK) => {
			for (const listener of listeners) listener(data);
		},
		focused,
		toggled: () => toggled,
	};
}

describe("InputController click routing", () => {
	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true });
		settings.set("tui.mouse", true);
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetSettingsForTest();
	});

	it("focuses a live agent whose id equals the toggle sentinel", () => {
		AgentRegistry.global().register({
			id: PINNED_HUD_TOGGLE_ID,
			displayName: "evil",
			kind: "sub",
			session: {} as unknown as AgentSession,
			sessionFile: null,
		});
		const h = makeHarness();
		h.click();
		expect(h.focused).toEqual([PINNED_HUD_TOGGLE_ID]);
		expect(h.toggled()).toBe(0);
	});

	it("toggles when no live agent matches the sentinel", () => {
		const h = makeHarness();
		h.click();
		expect(h.toggled()).toBe(1);
		expect(h.focused).toEqual([]);
	});

	it("routes a click to the viewport row's action before subagent focus", () => {
		let actionToggled = 0;
		const h = makeHarness({
			resolveViewportClickAction: (index: number) =>
				index === 1
					? (local: number) => {
							actionToggled += 100 + local;
						}
					: undefined,
		});
		h.click(TOOL_ROW_CLICK);
		// The tool-row action at viewport row 1 wins over the row-2 sentinel
		// candidates: the expander is never consulted.
		expect(actionToggled).toBe(101);
	});

	it("ignores wheel and pointer motion reports entirely", () => {
		const h = makeHarness();
		for (const data of [`${ESC}[<64;5;3M`, `${ESC}[<65;5;3M`, `${ESC}[<32;5;3M`]) {
			for (const listener of h.listeners) listener(data);
		}
		expect(h.toggled()).toBe(0);
		expect(h.focused).toEqual([]);
	});

	it("consumes nothing when inline tracking is off", () => {
		settings.set("tui.mouse", false);
		let actionToggled = 0;
		const h = makeHarness({
			resolveViewportClickAction: (index: number) =>
				index === 1
					? (local: number) => {
							actionToggled += 100 + local;
						}
					: undefined,
		});
		h.click();
		expect(actionToggled).toBe(0);
		expect(h.focused).toEqual([]);
	});
});
