/**
 * Transcript rebuild (focus replay, theme/settings change, `/resume`) must
 * group consecutive tool calls the same way the live stream does: a thinking
 * block the user cannot see is not a group boundary. The live path counts
 * screen-visible blocks; these cover the two rebuild paths that used to close
 * the group on any thinking block and rendered every call as its own row.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-builder";
import { CompactToolCallComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-call-compact";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { Container, type TUI } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	await Settings.init({ inMemory: true });
	settings.set("display.toolCalls", "grouped");
});

afterEach(() => {
	resetSettingsForTest();
});

/** One assistant turn: hidden reasoning followed by a single shell call. */
function thinkingThenBash(id: string, command: string): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: `why ${command}` },
			{ type: "toolCall", id, name: "bash", arguments: { command } },
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
	} as unknown as AgentMessage;
}

function entries(messages: AgentMessage[]): SessionMessageEntry[] {
	return messages.map((message, index) => ({
		type: "message" as const,
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		timestamp: new Date(2026, 0, 1).toISOString(),
		message,
	}));
}

function compactGroups(container: { children: readonly unknown[] }): CompactToolCallComponent[] {
	return container.children.filter((c): c is CompactToolCallComponent => c instanceof CompactToolCallComponent);
}

function row(group: CompactToolCallComponent): string {
	return Bun.stripANSI(group.render(120).join("\n"));
}

function builder(hideThinking: boolean): ChatTranscriptBuilder {
	return new ChatTranscriptBuilder({
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: process.cwd(),
		hideThinkingBlock: () => hideThinking,
		requestRender: vi.fn(),
	});
}

function uiHelpers(hideThinking: boolean): { ctx: InteractiveModeContext; helpers: UiHelpers } {
	const ctx = {
		chatContainer: new Container(),
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		ui: { requestRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		settings: { get: (key: string) => (key === "display.toolCalls" ? "grouped" : false) },
		addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
		session: {
			retryAttempt: 0,
			getToolByName: () => undefined,
			hasBuiltInTool: () => true,
			sessionManager: { getCwd: () => process.cwd() },
		},
		get viewSession() {
			return (this as typeof ctx).session;
		},
		toolOutputExpanded: false,
		hideThinkingBlock: hideThinking,
		effectiveHideThinkingBlock: hideThinking,
		clearTransientSessionUi: () => {},
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	return { ctx, helpers };
}

describe("compact tool group across a transcript rebuild", () => {
	it("keeps two turns' calls in one group when their thinking is hidden", () => {
		const target = builder(true);
		target.rebuild(entries([thinkingThenBash("bash-1", "echo one"), thinkingThenBash("bash-2", "echo two")]));

		const groups = compactGroups(target.container);
		expect(groups).toHaveLength(1);
		expect(row(groups[0]!)).toContain("2 shell commands");
	});

	it("closes the group at thinking the user can see", () => {
		const target = builder(false);
		target.rebuild(entries([thinkingThenBash("bash-1", "echo one"), thinkingThenBash("bash-2", "echo two")]));

		const groups = compactGroups(target.container);
		expect(groups).toHaveLength(2);
		expect(row(groups[0]!)).toContain("echo one");
		expect(row(groups[1]!)).toContain("echo two");
	});

	it("groups the same way when the focus-replay rebuild renders the turns", () => {
		const messages = [thinkingThenBash("bash-1", "echo one"), thinkingThenBash("bash-2", "echo two")];

		const hidden = uiHelpers(true);
		hidden.helpers.renderSessionContext({ messages } as unknown as SessionContext);
		const grouped = compactGroups(hidden.ctx.chatContainer);
		expect(grouped).toHaveLength(1);
		expect(row(grouped[0]!)).toContain("2 shell commands");

		const shown = uiHelpers(false);
		shown.helpers.renderSessionContext({ messages } as unknown as SessionContext);
		expect(compactGroups(shown.ctx.chatContainer)).toHaveLength(2);
	});
});
