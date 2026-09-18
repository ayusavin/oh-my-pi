/**
 * Compact rendering gives every generic tool call a separate Normal row.
 * Hidden thinking cannot merge calls or seal a pending row from an earlier
 * assistant message.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import { CompactToolCallComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-call-compact";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

type Block = AssistantMessage["content"][number];

function toolCall(name: string, id: string, args: Record<string, unknown>): Block {
	return { type: "toolCall", id, name, arguments: args } as Block;
}

function thinking(text: string): Block {
	return { type: "thinking", thinking: text } as Block;
}

function assistantMessage(content: Block[]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.5",
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
	};
}

function createFixture(hideThinking = false) {
	const ctx = createInteractiveModeContext({ hideThinkingBlock: hideThinking });
	return { controller: new EventController(ctx), chatContainer: ctx.chatContainer };
}

/** Drive one assistant completion: message_start then a single full message_update. */
async function streamCompletion(controller: EventController, content: Block[]): Promise<void> {
	const message = assistantMessage(content);
	await controller.handleEvent({ type: "message_start", message } as AgentSessionEvent);
	await controller.handleEvent({ type: "message_update", message } as AgentSessionEvent);
}

function compactRows(chatContainer: TranscriptContainer): CompactToolCallComponent[] {
	return chatContainer.children.filter((c): c is CompactToolCallComponent => c instanceof CompactToolCallComponent);
}

function compactRow(row: CompactToolCallComponent): string {
	return Bun.stripANSI(row.render(120).join("\n")).trimEnd();
}

describe("EventController compact rows with visible content", () => {
	it("keeps same-tool calls separate across hidden thinking", async () => {
		const { controller, chatContainer } = createFixture(true);

		await streamCompletion(controller, [
			thinking("considering which files to touch"),
			toolCall("bash", "bash-1", { command: "echo first", i: "Inspect source" }),
			thinking("second call rationale"),
			toolCall("bash", "bash-2", { command: "echo second", i: "Inspect source" }),
		]);

		const rows = compactRows(chatContainer);
		expect(rows).toHaveLength(2);
		expect(rows.map(row => compactRow(row)).join("\n")).toContain("queued bash(echo first)");
		expect(rows.map(row => compactRow(row)).join("\n")).toContain("queued bash(echo second)");
	});

	it("does not seal a pending row because the next assistant message starts", async () => {
		const { controller, chatContainer } = createFixture(true);
		await streamCompletion(controller, [toolCall("bash", "bash-1", { command: "echo first" })]);
		await streamCompletion(controller, [toolCall("bash", "bash-2", { command: "echo second" })]);

		const rows = compactRows(chatContainer);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.isTranscriptBlockFinalized()).toBe(false);
	});

	it("keeps the full-mode read grouping contract", async () => {
		settings.set("display.toolCalls", "full");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			thinking("considering the next read"),
			toolCall("read", "read-1", { path: "/tmp/first.txt" }),
		]);
		await streamCompletion(controller, [
			thinking("more reasoning"),
			toolCall("read", "read-2", { path: "/tmp/second.txt" }),
		]);

		const groups = chatContainer.children.filter(
			(child): child is ReadToolGroupComponent => child instanceof ReadToolGroupComponent,
		);
		expect(groups).toHaveLength(2);
	});
});
