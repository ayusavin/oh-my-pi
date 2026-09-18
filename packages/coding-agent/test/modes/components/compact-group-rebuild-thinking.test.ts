/**
 * Transcript rebuilds preserve one compact component per tool call. Hidden
 * thinking remains transparent without merging calls inside or across assistant
 * messages.
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
	settings.set("display.toolCalls", "compact");
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

function compatibleBashBatch(): AgentMessage {
	const message = thinkingThenBash("bash-1", "echo one");
	return {
		...message,
		content: [
			{ type: "thinking", thinking: "why echo one" },
			{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "echo one", i: "Inspect source" } },
			{ type: "thinking", thinking: "why echo two" },
			{ type: "toolCall", id: "bash-2", name: "bash", arguments: { command: "echo two", i: "Inspect source" } },
		],
	} as AgentMessage;
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

function compactRows(container: { children: readonly unknown[] }): CompactToolCallComponent[] {
	return container.children.filter((c): c is CompactToolCallComponent => c instanceof CompactToolCallComponent);
}

function rowText(component: CompactToolCallComponent): string {
	return Bun.stripANSI(component.render(120).join("\n"));
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
		settings: { get: (key: string) => (key === "display.toolCalls" ? "compact" : false) },
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

describe("compact rows across transcript rebuilds", () => {
	it("renders tool-only assistant messages as separate compact components", () => {
		const target = builder(true);
		target.rebuild(entries([thinkingThenBash("bash-1", "echo one"), thinkingThenBash("bash-2", "echo two")]));

		const rows = compactRows(target.container);
		expect(rows).toHaveLength(2);
		expect(rows.every(row => row.isTranscriptBlockFinalized() === false)).toBe(true);
	});

	it("renders compatible calls in one rebuilt assistant message as separate rows", () => {
		const message = compatibleBashBatch();
		const target = builder(true);
		target.rebuild(entries([message]));

		const rows = compactRows(target.container);
		expect(rows).toHaveLength(2);
		expect(rows.map(rowText).join("\n")).toContain("echo one");
		expect(rows.map(rowText).join("\n")).toContain("echo two");

		const replay = uiHelpers(true);
		replay.helpers.renderSessionContext({ messages: [message] } as unknown as SessionContext);
		expect(compactRows(replay.ctx.chatContainer)).toHaveLength(2);
	});
	it("finalizes a completed trailing replay row without a usage row", () => {
		const target = builder(true);
		const assistant = thinkingThenBash("bash-1", "echo one");
		const result = {
			role: "toolResult",
			toolCallId: "bash-1",
			toolName: "bash",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: Date.now(),
		} as unknown as AgentMessage;

		target.rebuild(entries([assistant, result]));

		const [row] = compactRows(target.container);
		expect(row?.isTranscriptBlockFinalized()).toBe(true);
	});
});
