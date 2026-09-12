/**
 * The compact tool group's reset signal counts only content the user can
 * actually see (`event-controller.ts` `#handleMessageUpdate`): text always,
 * thinking only while it is displayed. The model emits a thinking block
 * between practically every pair of tool calls; counted unconditionally the
 * hidden-by-default block would break `2 shell commands` into loose rows.
 * `#resetReadGroup()` keeps upstream's own unchanged signal — thinking always
 * counts for the read group.
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

function createFixture() {
	const ctx = createInteractiveModeContext();
	return { controller: new EventController(ctx), chatContainer: ctx.chatContainer };
}

/** Drive one assistant completion: message_start then a single full message_update. */
async function streamCompletion(controller: EventController, content: Block[]): Promise<void> {
	const message = assistantMessage(content);
	await controller.handleEvent({ type: "message_start", message } as AgentSessionEvent);
	await controller.handleEvent({ type: "message_update", message } as AgentSessionEvent);
}

function compactGroups(chatContainer: TranscriptContainer): CompactToolCallComponent[] {
	return chatContainer.children.filter((c): c is CompactToolCallComponent => c instanceof CompactToolCallComponent);
}

function compactRow(group: CompactToolCallComponent): string {
	return Bun.stripANSI(group.render(120).join("\n")).trimEnd();
}

describe("EventController compact tool-group visible-content reset", () => {
	it("a hidden thinking block between two tool calls keeps them in one group", async () => {
		settings.set("display.toolCalls", "grouped");
		const { controller, chatContainer } = createFixture();

		await streamCompletion(controller, [
			thinking("considering which files to touch"),
			toolCall("bash", "bash-1", { command: "echo first" }),
			thinking("second call rationale"),
			toolCall("bash", "bash-2", { command: "echo second" }),
		]);

		const groups = compactGroups(chatContainer);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.size).toBe(2);
		expect(compactRow(groups[0]!)).toContain("2 shell commands");
	});

	it("a displayed thinking block closes the group (displayed = counted)", async () => {
		settings.set("display.toolCalls", "grouped");
		// The shared stub's `effectiveHideThinkingBlock` getter reads its own
		// `hideThinkingBlock` member, which defaults false — the *displayed*
		// half of the split (production's default true is the first test).
		const ctx = createInteractiveModeContext();
		const controller = new EventController(ctx);
		const chatContainer = ctx.chatContainer;

		await streamCompletion(controller, [thinking("considering which files to touch"), toolCall("bash", "bash-1", { command: "echo first" })]);
		await streamCompletion(controller, [thinking("second call rationale"), toolCall("bash", "bash-2", { command: "echo second" })]);

		// With thinking on screen, the visible block is real content: the run
		// closes at it and the next call starts a fresh group.
		const groups = compactGroups(chatContainer);
		expect(groups).toHaveLength(2);
		expect(groups[0]!.size).toBe(1);
		expect(groups[1]!.size).toBe(1);
	});

	it("a mixed run of two bash calls and one grep renders one group naming both tools", async () => {
		settings.set("display.toolCalls", "grouped");
		const { controller, chatContainer } = createFixture();

		await streamCompletion(controller, [
			toolCall("bash", "bash-1", { command: "echo first" }),
			toolCall("bash", "bash-2", { command: "echo second" }),
			toolCall("grep", "grep-1", { pattern: "needle", path: "/tmp/hay" }),
		]);

		const groups = compactGroups(chatContainer);
		expect(groups).toHaveLength(1);
		const row = compactRow(groups[0]!);
		expect(row).toContain("2 shell commands");
		expect(row).toContain("1 search");
		expect(row).not.toContain("Called grep");
	});

	it("the read group keeps upstream's own signal, untouched by the screen-visible split", async () => {
		const { controller, chatContainer } = createFixture();

		// Upstream's `#lastVisibleBlockCount` behavior is unchanged by this
		// fix — its full coverage lives in `event-controller-read-grouping.test.ts`
		// (which still passes); this is the one contrasting case: non-empty
		// thinking in BOTH completions keeps the read runs separate there.
		await streamCompletion(controller, [thinking("considering the next read"), toolCall("read", "read-1", { path: "/tmp/first.txt" })]);
		await streamCompletion(controller, [thinking("more reasoning"), toolCall("read", "read-2", { path: "/tmp/second.txt" })]);

		const groups = chatContainer.children.filter(
			(c): c is ReadToolGroupComponent => c instanceof ReadToolGroupComponent,
		);
		expect(groups).toHaveLength(2);
	});
});
