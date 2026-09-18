/**
 * `display.toolCalls` (`full` | `compact`).
 *
 * `compact` is the Normal default: every call owns a separate row showing its
 * state, primary target, and intent. `full` remains the explicit Verbose card
 * path. Compact reads follow the same per-action path; `ReadToolGroupComponent`
 * remains only for full-mode reads.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import {
	CompactToolCallComponent,
	mountCompactToolCall,
} from "@oh-my-pi/pi-coding-agent/modes/components/tool-call-compact";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { buildAsyncResultBlock } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { Container } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

describe("CompactToolCallComponent", () => {
	it("renders a Normal row with intent and primary target", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "ls -la", i: "Inspect the directory" }, undefined);
		component.setExecutionStarted("call-1");
		component.updateResult({ content: [{ type: "text", text: "a.txt\nb.txt\n" }], isError: false }, false, "call-1");
		const text = plain(component.render(120));
		expect(text).toContain("Inspect the directory");
		expect(text).toContain("Bash(ls -la)");
		expect(text).not.toContain("command=");
	});

	it("a search row carries its pattern, not its directory", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "grep", "Grep", { pattern: "codex_pool_models", path: "ansible" }, undefined);
		component.updateResult({ content: [{ type: "text", text: "hit" }], isError: false }, false, "call-1");
		expect(plain(component.render(120))).toContain("Grep(codex_pool_models)");
	});
});

describe("CompactToolCallComponent row expansion", () => {
	beforeAll(() => {
		initTheme();
	});

	function settledRow(id: string, command: string): CompactToolCallComponent {
		const component = new CompactToolCallComponent();
		component.addCall(id, "bash", "Bash", { command, i: "Inspect source files" }, undefined);
		component.updateResult({ content: [{ type: "text", text: `${id} output` }], isError: false }, false, id);
		return component;
	}

	it("expands only the clicked compact call into its full card", () => {
		const first = settledRow("call-1", "echo first");
		const second = settledRow("call-2", "echo second");

		first.getViewportClickAction()!(0);

		expect(plain(first.render(120))).toContain("call-1 output");
		expect(first.children.some(child => child instanceof ToolExecutionComponent)).toBe(true);
		expect(second.children.some(child => child instanceof ToolExecutionComponent)).toBe(false);
	});

	it("lets global Verbose expansion override a local collapse", () => {
		const component = settledRow("call-1", "echo first");

		component.getViewportClickAction()!(0);
		component.getViewportClickAction()!(0);
		expect(component.children.some(child => child instanceof ToolExecutionComponent)).toBe(false);

		component.setExpanded(true);
		expect(plain(component.render(120))).toContain("call-1 output");
		expect(component.children.some(child => child instanceof ToolExecutionComponent)).toBe(true);
	});

	it("keeps the primary target visible and truncates a long intent", () => {
		const component = new CompactToolCallComponent();
		component.addCall(
			"call-1",
			"read",
			"Read",
			{ path: "src/file.ts" },
			undefined,
			`Inspect ${"source context ".repeat(12)}INTENT_TAIL`,
		);

		const text = plain(component.render(40));
		expect(text).toContain("Read(src/file.ts)");
		expect(text).toContain("…");
		expect(text).not.toContain("INTENT_TAIL");
	});

	it("keeps finality independent of local and global expansion", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo hi" }, undefined);

		component.getViewportClickAction()!(0);
		component.setExpanded(true);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false, "call-1");
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});
});

describe("CompactToolCallComponent ask resultSummary (B)", () => {
	beforeAll(() => {
		initTheme();
	});

	it("the ask row shows the question before resolution and the chosen answer after", () => {
		const component = new CompactToolCallComponent();
		component.addCall(
			"call-1",
			"ask",
			"Ask",
			{ questions: [{ id: "q1", question: "Use plan mode?", options: ["Plan", "No"], multi: false }] },
			undefined,
		);
		const pending = plain(component.render(120));
		expect(pending).toContain("Ask(Use plan mode?)");
		expect(pending).not.toContain("Yes");

		component.updateResult(
			{
				content: [{ type: "text", text: "User answers:\nq1: Plan" }],
				details: {
					results: [
						{
							id: "q1",
							question: "Use plan mode?",
							options: ["Plan", "No"],
							multi: false,
							selectedOptions: ["Plan"],
						},
					],
				},
				isError: false,
			},
			false,
			"call-1",
		);
		const settled = plain(component.render(120));
		expect(settled).toContain("Ask(Use plan mode?)");
		expect(settled).toContain("Plan");
	});

	it("a custom Other answer and a chat redirect render on the row", () => {
		const custom = new CompactToolCallComponent();
		custom.addCall("call-1", "ask", "Ask", { question: "Name the branch?" }, undefined);
		custom.updateResult(
			{
				content: [{ type: "text", text: 'User answers:\nq1: "feat/x"' }],
				details: { question: "Name the branch?", customInput: "feat/x" },
				isError: false,
			},
			false,
			"call-1",
		);
		expect(plain(custom.render(120))).toContain("feat/x");

		const redirect = new CompactToolCallComponent();
		redirect.addCall("call-2", "ask", "Ask", { question: "Continue?" }, undefined);
		redirect.updateResult(
			{
				content: [{ type: "text", text: "User chose to chat" }],
				details: { chatRedirect: true, questions: ["Continue?"] },
				isError: false,
			},
			false,
			"call-2",
		);
		expect(plain(redirect.render(120))).toContain("chat redirect");
	});
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

function compactRows(chatContainer: TranscriptContainer): CompactToolCallComponent[] {
	return chatContainer.children.filter((c): c is CompactToolCallComponent => c instanceof CompactToolCallComponent);
}

function plain(lines: readonly string[]): string {
	return Bun.stripANSI(lines.join("\n"));
}

function asyncResultMessage(details: Record<string, unknown>): CustomMessage {
	return { role: "custom", customType: "async-result", content: "", display: true, details, timestamp: Date.now() };
}

describe("display.toolCalls", () => {
	it("defaults to compact Normal rows", () => {
		expect(settings.get("display.toolCalls")).toBe("compact");
	});

	it("full remains the explicit ToolExecutionComponent path", async () => {
		settings.set("display.toolCalls", "full");
		const { controller, chatContainer, ctx } = createFixture();
		await streamCompletion(controller, [toolCall("bash", "bash-1", { command: "echo hi" })]);

		const rendered = chatContainer.children.find(child => child instanceof ToolExecutionComponent);
		expect(rendered).toBeInstanceOf(ToolExecutionComponent);
		expect(compactRows(chatContainer)).toHaveLength(0);

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

	it("compact exposes args.i as the action intent with the primary target", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("bash", "bash-1", { command: "systemctl restart gateway", i: "Restarting the gateway" }),
		]);

		const rows = compactRows(chatContainer);
		expect(rows).toHaveLength(1);
		const text = plain(rows[0]!.render(120));
		expect(text).toContain("Restarting the gateway");
		expect(text).toContain("(systemctl restart gateway)");
		expect(text).not.toContain("command=");
	});

	it("uses the authoritative live execution intent when it is available", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		const message = assistantMessage([toolCall("bash", "bash-1", { command: "echo source" })]);
		await controller.handleEvent({ type: "message_start", message } as AgentSessionEvent);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command: "echo source" },
			intent: "Inspect source files",
		} as AgentSessionEvent);

		expect(plain(compactRows(chatContainer)[0]!.render(120))).toContain("Inspect source files");
	});

	it("compact never folds a second call into the first call's row", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("bash", "bash-1", { command: "echo first" }),
			toolCall("bash", "bash-2", { command: "echo second" }),
		]);

		const rows = compactRows(chatContainer);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.render(120)).toHaveLength(1);
		expect(rows[1]!.render(120)).toHaveLength(1);
	});

	it("bounds a long primary argument without exposing its raw full value (C8)", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		const longCommand = `echo ${"x".repeat(200)}`;
		await streamCompletion(controller, [toolCall("bash", "bash-1", { command: longCommand })]);

		const text = plain(compactRows(chatContainer)[0]!.render(400));
		expect(text).not.toContain(longCommand);
		expect(text).toContain("echo ");
		expect(text).toContain("…");
	});

	it("renders compatible same-tool calls as separate Normal rows", async () => {
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("bash", "call-1", { command: "echo one", i: "Inspect source files" }),
			toolCall("bash", "call-2", { command: "echo two", i: "Inspect source files" }),
			toolCall("bash", "call-3", { command: "echo three", i: "Inspect source files" }),
		]);

		const rows = compactRows(chatContainer);
		expect(rows).toHaveLength(3);
		const text = rows.map(row => plain(row.render(120))).join("\n");
		expect(text).toContain("queued bash(echo one) — Inspect source files");
		expect(text).toContain("queued bash(echo two) — Inspect source files");
	});

	it("renders heterogeneous calls as separate Normal rows", async () => {
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("bash", "bash-1", { command: "echo source", i: "Inspect source" }),
			toolCall("read", "read-1", { path: "/tmp/example.ts", i: "Read the implementation" }),
			toolCall("eval", "eval-1", { language: "js", code: "1+1", i: "Check the expression" }),
			toolCall("grep", "grep-1", { pattern: "needle", path: "/tmp/hay", i: "Find the reference" }),
		]);

		const rows = compactRows(chatContainer);
		expect(rows).toHaveLength(4);
		expect(chatContainer.children.filter(child => child instanceof ReadToolGroupComponent)).toHaveLength(0);
		const text = rows.map(row => plain(row.render(120))).join("\n");
		expect(text).toContain("Inspect source");
		expect(text).toContain("Read the implementation");
		expect(text).toContain("Check the expression");
		expect(text).toContain("Find the reference");
	});

	it("keeps tool-only assistant messages in separate rows until each result settles", async () => {
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [toolCall("bash", "call-1", { command: "echo one", i: "Inspect source" })]);
		await streamCompletion(controller, [toolCall("bash", "call-2", { command: "echo two", i: "Inspect source" })]);

		const rows = compactRows(chatContainer);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.isTranscriptBlockFinalized()).toBe(false);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "done" }] },
			isError: false,
		} as AgentSessionEvent);

		expect(rows[0]!.isTranscriptBlockFinalized()).toBe(true);
		expect(rows[1]!.isTranscriptBlockFinalized()).toBe(false);
	});

	it("settles a compact row after its streamed provisional id becomes final", async () => {
		const { controller, chatContainer } = createFixture();
		const provisional = assistantMessage([toolCall("bash", "provisional-id", { command: "echo one" })]);
		await controller.handleEvent({ type: "message_start", message: provisional } as AgentSessionEvent);
		await controller.handleEvent({ type: "message_update", message: provisional } as AgentSessionEvent);

		const finalized = assistantMessage([toolCall("bash", "final-id", { command: "echo one" })]);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "final-id",
			toolName: "bash",
			result: { content: [{ type: "text", text: "done" }] },
			isError: false,
		} as AgentSessionEvent);
		await controller.handleEvent({ type: "message_update", message: finalized } as AgentSessionEvent);

		const rows = compactRows(chatContainer);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.isTranscriptBlockFinalized()).toBe(true);
	});

	it("retains the provisional row and adopts a final row that already settled", async () => {
		const { controller, chatContainer, ctx } = createFixture();
		const provisional = assistantMessage([toolCall("bash", "provisional-id", { command: "echo provisional" })]);
		await controller.handleEvent({ type: "message_start", message: provisional } as AgentSessionEvent);
		await controller.handleEvent({ type: "message_update", message: provisional } as AgentSessionEvent);
		const provisionalRow = compactRows(chatContainer)[0]!;

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "final-id",
			toolName: "bash",
			args: { command: "echo authoritative" },
			intent: "Inspect authoritative source",
		} as AgentSessionEvent);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "final-id",
			toolName: "bash",
			result: { content: [{ type: "text", text: "AUTHORITATIVE_RESULT" }] },
			isError: false,
		} as AgentSessionEvent);

		const finalized = assistantMessage([toolCall("bash", "final-id", { command: "echo authoritative" })]);
		await controller.handleEvent({ type: "message_update", message: finalized } as AgentSessionEvent);

		const rows = compactRows(chatContainer);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toBe(provisionalRow);
		expect(rows[0]!.isTranscriptBlockFinalized()).toBe(true);
		expect(ctx.pendingTools.size).toBe(0);
		expect(plain(provisionalRow.render(120))).toContain("echo authoritative");
		expect(plain(provisionalRow.render(120))).toContain("Inspect authoritative source");
		provisionalRow.setExpanded(true);
		expect(plain(provisionalRow.render(120))).toContain("AUTHORITATIVE_RESULT");
	});

	it("keeps [P(A), B] ordered as [F(A), B] when final execution starts first", async () => {
		const { controller, chatContainer, ctx } = createFixture();
		const provisional = assistantMessage([
			toolCall("bash", "provisional-id", { command: "echo provisional-A" }),
			toolCall("bash", "b-id", { command: "echo B" }),
		]);
		await controller.handleEvent({ type: "message_start", message: provisional } as AgentSessionEvent);
		await controller.handleEvent({ type: "message_update", message: provisional } as AgentSessionEvent);
		const provisionalRow = compactRows(chatContainer)[0]!;
		const siblingRow = compactRows(chatContainer)[1]!;

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "final-id",
			toolName: "bash",
			args: { command: "echo authoritative-A" },
			intent: "Inspect action A",
		} as AgentSessionEvent);
		const finalized = assistantMessage([
			toolCall("bash", "final-id", { command: "echo authoritative-A" }),
			toolCall("bash", "b-id", { command: "echo B" }),
		]);
		await controller.handleEvent({ type: "message_update", message: finalized } as AgentSessionEvent);

		const rows = compactRows(chatContainer);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toBe(provisionalRow);
		expect(rows[1]).toBe(siblingRow);
		expect(plain(rows[0]!.render(120))).toContain("echo authoritative-A");
		expect(plain(rows[0]!.render(120))).toContain("Inspect action A");
		expect(plain(rows[1]!.render(120))).toContain("echo B");
		expect(ctx.pendingTools.get("final-id")).toBe(provisionalRow);
		expect(ctx.pendingTools.has("provisional-id")).toBe(false);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "final-id",
			toolName: "bash",
			result: { content: [{ type: "text", text: "A_RESULT" }] },
			isError: false,
		} as AgentSessionEvent);

		expect(provisionalRow.isTranscriptBlockFinalized()).toBe(true);
		expect(ctx.pendingTools.has("final-id")).toBe(false);
		expect(ctx.pendingTools.get("b-id")).toBe(siblingRow);
	});

	it("keeps an authoritative row that started before the delayed provisional stream", async () => {
		const { controller, chatContainer, ctx } = createFixture();
		const provisional = assistantMessage([
			toolCall("bash", "provisional-id", { command: "echo provisional-A" }),
			toolCall("bash", "b-id", { command: "echo B" }),
		]);
		await controller.handleEvent({ type: "message_start", message: provisional } as AgentSessionEvent);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "final-id",
			toolName: "bash",
			args: { command: "echo authoritative-A" },
			intent: "Inspect action A",
		} as AgentSessionEvent);
		const authoritativeRow = compactRows(chatContainer)[0]!;

		await controller.handleEvent({ type: "message_update", message: provisional } as AgentSessionEvent);
		const siblingRow = compactRows(chatContainer).at(-1)!;
		const finalized = assistantMessage([
			toolCall("bash", "final-id", { command: "echo authoritative-A" }),
			toolCall("bash", "b-id", { command: "echo B" }),
		]);
		await controller.handleEvent({ type: "message_update", message: finalized } as AgentSessionEvent);

		let rows = compactRows(chatContainer);
		expect(rows).toEqual([authoritativeRow, siblingRow]);
		expect(ctx.pendingTools.get("final-id")).toBe(authoritativeRow);
		expect(ctx.pendingTools.has("provisional-id")).toBe(false);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "final-id",
			toolName: "bash",
			result: { content: [{ type: "text", text: "AUTHORITATIVE_RESULT" }] },
			isError: false,
		} as AgentSessionEvent);

		rows = compactRows(chatContainer);
		expect(rows).toEqual([authoritativeRow, siblingRow]);
		expect(authoritativeRow.isTranscriptBlockFinalized()).toBe(true);
		expect(ctx.pendingTools.has("final-id")).toBe(false);
		authoritativeRow.setExpanded(true);
		expect(plain(authoritativeRow.render(120))).toContain("AUTHORITATIVE_RESULT");
	});

	it("a waiting poll (hub wait) renders a human name, not a bare internal id (C6)", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [toolCall("hub", "hub-1", { op: "wait", ids: ["bg_10", "bg_11"] })]);

		const text = plain(compactRows(chatContainer)[0]!.render(120));
		expect(text).not.toContain("bg_10");
		expect(text).not.toContain("bg_11");
		expect(text).toContain("2 jobs");
	});

	it("hub renders the peer's own name for a wait addressed by peer, not a serialized args dump (C1, C6)", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [toolCall("hub", "hub-1", { op: "wait", from: "CompactRows" })]);

		const text = plain(compactRows(chatContainer)[0]!.render(120));
		expect(text).toContain("CompactRows");
		expect(text).not.toContain("op=");
	});

	it("ask renders the question itself for one question, a count for several — never the raw `questions` array (C1, C6)", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("ask", "ask-1", { questions: [{ id: "q1", question: "JWT or session cookies?", options: [] }] }),
		]);

		const text = plain(compactRows(chatContainer)[0]!.render(120));
		expect(text).toContain("JWT or session cookies?");
		expect(text).not.toContain("questions=");
		expect(text).not.toContain("[1 items]");
	});

	it("ask renders a question count for a multi-question batch, not `[N items]` (C1, C6)", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("ask", "ask-1", {
				questions: [
					{ id: "q1", question: "JWT or session cookies?", options: [] },
					{ id: "q2", question: "SQLite or Postgres?", options: [] },
				],
			}),
		]);

		const text = plain(compactRows(chatContainer)[0]!.render(120));
		expect(text).toContain("2 questions");
		expect(text).not.toMatch(/\[2 items\]/);
	});
});

describe("CompactToolCallComponent", () => {
	it("renders an explicit done state without incidental byte counts", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "ls -la" }, undefined);
		component.setExecutionStarted("call-1");
		component.updateResult({ content: [{ type: "text", text: "a.txt\nb.txt\n" }], isError: false }, false, "call-1");

		const text = plain(component.render(120));
		expect(text).toContain("done Bash(ls -la)");
		expect(text).not.toMatch(/\d+\s*B\b/);
	});

	it("renders queued, running, and done states while duration stays live-only (C3)", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "restart gateway" }, undefined);
		expect(plain(component.render(120))).toContain("queued Bash(restart gateway)");

		component.setExecutionStarted("call-1");
		const runningText = plain(component.render(120));
		expect(runningText).toContain("running Bash(restart gateway)");
		expect(runningText).toMatch(/\d+(\.\d+)?(ms|s)/);

		component.updateResult({ content: [{ type: "text", text: "" }], isError: false }, false, "call-1");
		const settledText = plain(component.render(120));
		expect(settledText).toContain("done Bash(restart gateway)");
		expect(settledText).not.toMatch(/\d+(\.\d+)?(ms|s)/);
	});

	it("shows a settled subagent (task) completion's duration, unlike an ordinary tool (C3)", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "task", "Task", { tasks: [{ name: "Explore", task: "map the repo" }] }, undefined);
		component.setExecutionStarted("call-1");
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false, "call-1");

		const text = plain(component.render(120));
		expect(text).toContain("Explore");
		expect(text).toMatch(/\d+(\.\d+)?(ms|s)/);
	});

	it("renders failed plus the first error line and omits the stack tail (C3)", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "chmod 400 file" }, undefined);
		component.updateResult(
			{
				content: [{ type: "text", text: "Permission denied\nsome stack trace the row must not show" }],
				isError: true,
			},
			false,
			"call-1",
		);

		const text = plain(component.render(120));
		expect(text).toContain("failed Bash(chmod 400 file)");
		expect(text).toContain("Permission denied");
		expect(text).not.toContain("some stack trace the row must not show");
	});

	it("falls back to the generic command/path/input scan when the tool has no bespoke summary, and to the bare label with no primary argument", () => {
		const withArg = new CompactToolCallComponent();
		withArg.addCall("call-1", "some_custom_tool", "SomeCustomTool", { command: "do the thing" }, undefined);
		expect(plain(withArg.render(120))).toContain("SomeCustomTool(do the thing)");

		const bare = new CompactToolCallComponent();
		bare.addCall("call-1", "some_custom_tool", "SomeCustomTool", { unrelated: 1 }, undefined);
		const bareText = plain(bare.render(120));
		expect(bareText).toContain("SomeCustomTool");
		expect(bareText).not.toContain("(");
	});

	it("rejects a second generic call and finalizes after its sole result", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo first" }, undefined);

		expect(() => component.addCall("call-2", "bash", "Bash", { command: "echo second" }, undefined)).toThrow(
			"CompactToolCallComponent accepts exactly one tool call",
		);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false, "call-1");
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("seal() finalizes an abandoned pending call", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo hi" }, undefined);
		component.seal();
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});
});

describe("mountCompactToolCall", () => {
	it("mounts one admitted component for each call", () => {
		const container = new Container();
		const first = mountCompactToolCall(container, false, "call-1", "bash", { command: "echo one" }, undefined);
		const second = mountCompactToolCall(container, false, "call-2", "bash", { command: "echo two" }, undefined);

		expect(container.children).toEqual([first.component, second.component]);
		expect(first.component.isTranscriptBlockFinalized()).toBe(false);
		first.component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false, "call-1");
		expect(first.component.isTranscriptBlockFinalized()).toBe(true);
		expect(second.component.isTranscriptBlockFinalized()).toBe(false);
	});
});

describe("buildAsyncResultBlock (background job rows, C6)", () => {
	it("prefers the job's own label over its bare internal id", () => {
		const block = buildAsyncResultBlock(
			asyncResultMessage({ jobId: "bg_10", type: "bash", label: "npm test", durationMs: 60_000 }),
		);
		const text = plain(block.render(120));
		expect(text).toContain("npm test");
		expect(text).not.toMatch(/\bbg_10\b(?!\))/); // the id may still appear parenthetically, never standing alone
	});

	it("falls back to the bare id only when the job carries no label at all", () => {
		const block = buildAsyncResultBlock(asyncResultMessage({ jobId: "bg_10", type: "bash" }));
		const text = plain(block.render(120));
		expect(text).toContain("bg_10");
	});
});
