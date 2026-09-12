/**
 * `display.toolCalls` (`full` | `compact` | `grouped`).
 *
 * `full` is the default and must keep constructing `ToolExecutionComponent`
 * exactly as upstream does — the daily upstream merge can silently change
 * that construction, so the regression test below asserts byte-for-byte
 * equality against a component built the same way, outside the controller.
 * `compact` collapses a call to one line carrying its resolved intent.
 * `grouped` additionally folds a run of consecutive same-turn calls into one
 * row with a count, expandable (ctrl+o) to one line per call — mirroring
 * `ReadToolGroupComponent`, which keeps owning collapsible `read` calls
 * regardless of `display.toolCalls`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import { CompactToolCallComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-call-compact";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

beforeEach(async () => {
	resetSettingsForTest();
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
	return { controller: new EventController(ctx), chatContainer: ctx.chatContainer, ctx };
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

function plain(lines: readonly string[]): string {
	return Bun.stripANSI(lines.join("\n"));
}

describe("display.toolCalls", () => {
	it("defaults to full", () => {
		expect(settings.get("display.toolCalls")).toBe("full");
	});

	it("full renders the exact ToolExecutionComponent construction upstream builds", async () => {
		const { controller, chatContainer, ctx } = createFixture();
		await streamCompletion(controller, [toolCall("bash", "bash-1", { command: "echo hi" })]);

		const rendered = chatContainer.children.find(child => child instanceof ToolExecutionComponent);
		expect(rendered).toBeInstanceOf(ToolExecutionComponent);
		expect(compactGroups(chatContainer)).toHaveLength(0);

		// Same construction event-controller.ts's `full` branch performs, built
		// directly instead of through the controller: proves the branch added
		// for `display.toolCalls` left this call path untouched.
		const reference = new ToolExecutionComponent(
			"bash",
			{ command: "echo hi" },
			{ useBuiltInRenderer: true, showImages: settings.get("terminal.showImages") },
			undefined,
			ctx.ui,
			ctx.sessionManager.getCwd(),
			"bash-1",
		);
		expect(plain((rendered as ToolExecutionComponent).render(120))).toBe(plain(reference.render(120)));
	});

	it("compact renders one line per call carrying the resolved intent", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("bash", "bash-1", { command: "systemctl restart gateway", i: "Restarting the gateway" }),
		]);

		const groups = compactGroups(chatContainer);
		expect(groups).toHaveLength(1);
		const lines = groups[0]!.render(120);
		expect(lines).toHaveLength(1);
		expect(plain(lines)).toContain("Restarting the gateway");
	});

	it("compact never folds a second call into the first call's row", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("bash", "bash-1", { i: "First call" }),
			toolCall("bash", "bash-2", { i: "Second call" }),
		]);

		const groups = compactGroups(chatContainer);
		expect(groups).toHaveLength(2);
		expect(groups[0]!.render(120)).toHaveLength(1);
		expect(groups[1]!.render(120)).toHaveLength(1);
	});

	it("grouped folds consecutive same-turn calls into one row with the count, and expands to one row per call", async () => {
		settings.set("display.toolCalls", "grouped");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("bash", "call-1", { i: "First call" }),
			toolCall("bash", "call-2", { i: "Second call" }),
			toolCall("bash", "call-3", { i: "Third call" }),
		]);

		const groups = compactGroups(chatContainer);
		expect(groups).toHaveLength(1);
		const group = groups[0]!;

		const collapsed = group.render(120);
		expect(collapsed).toHaveLength(1);
		expect(plain(collapsed)).toContain("3");

		group.setExpanded(true);
		const expanded = group.render(120);
		expect(expanded).toHaveLength(3);
		const expandedText = plain(expanded);
		expect(expandedText).toContain("First call");
		expect(expandedText).toContain("Second call");
		expect(expandedText).toContain("Third call");
	});

	it("grouped starts a fresh group after visible assistant content breaks the run", async () => {
		settings.set("display.toolCalls", "grouped");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [toolCall("bash", "call-1", { i: "First call" })]);
		await streamCompletion(controller, [
			thinking("Now checking something else"),
			toolCall("bash", "call-2", { i: "Second call" }),
		]);

		expect(compactGroups(chatContainer)).toHaveLength(2);
	});

	it("grouped leaves collapsible read calls on ReadToolGroupComponent", async () => {
		settings.set("display.toolCalls", "grouped");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [toolCall("read", "read-1", { path: "/tmp/example.ts" })]);

		const readGroups = chatContainer.children.filter(child => child instanceof ReadToolGroupComponent);
		expect(readGroups).toHaveLength(1);
		expect(compactGroups(chatContainer)).toHaveLength(0);
	});
});

describe("CompactToolCallComponent", () => {
	it("renders one line for a single call: intent, outcome, size, duration", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "Bash", { i: "Listing files" }, undefined);
		component.setExecutionStarted("call-1");
		component.updateResult({ content: [{ type: "text", text: "a.txt\nb.txt\n" }], isError: false }, false, "call-1");

		const lines = component.render(120);
		expect(lines).toHaveLength(1);
		const text = plain(lines);
		expect(text).toContain("Listing files");
		expect(text).toContain("ok");
		expect(text).toContain("12B");
		expect(text).toMatch(/\dms/);
	});

	it("shows a pending call without outcome/size/duration until it settles", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "Bash", { i: "Still running" }, undefined);

		const text = plain(component.render(120));
		expect(text).toContain("Still running");
		expect(text).toContain("running");
	});

	it("folds N calls into one collapsed row with the count, and expands to N rows", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "Bash", { i: "First" }, undefined);
		component.addCall("call-2", "Bash", { i: "Second" }, undefined);
		component.addCall("call-3", "Bash", { i: "Third" }, undefined);
		component.updateResult({ content: [{ type: "text", text: "" }], isError: false }, false, "call-1");
		component.updateResult({ content: [{ type: "text", text: "" }], isError: true }, false, "call-2");

		const collapsed = component.render(120);
		expect(collapsed).toHaveLength(1);
		const collapsedText = plain(collapsed);
		expect(collapsedText).toContain("3");
		expect(collapsedText).toContain("1 failed");

		component.setExpanded(true);
		const expanded = component.render(120);
		expect(expanded).toHaveLength(3);
		expect(Bun.stripANSI(expanded[0]!)).toContain("First");
		expect(Bun.stripANSI(expanded[1]!)).toContain("Second");
		expect(Bun.stripANSI(expanded[2]!)).toContain("Third");
	});

	it("falls back to the label and an args preview when no intent is available", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "Bash", { command: "echo hi" }, undefined);

		const text = plain(component.render(120));
		expect(text).toContain("Bash");
		expect(text).toContain("echo hi");
	});

	it("is not finalized while a call is pending, and finalizes once every call settles", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "Bash", { i: "First" }, undefined);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		component.updateResult({ content: [{ type: "text", text: "" }], isError: false }, false, "call-1");
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});
});
