/**
 * `display.toolCalls` (`full` | `compact` | `grouped`).
 *
 * `full` is the default and must keep constructing `ToolExecutionComponent`
 * exactly as upstream does — the daily upstream merge can silently change
 * that construction, so the regression test below asserts byte-for-byte
 * equality against a component built the same way, outside the controller.
 * `compact` collapses a call to one line: the tool's name and its primary
 * argument (`.downstream/spec/transcript.md`'s "Compact rendering contract",
 * C1-C8) — never the model's own intent sentence, never a `key=value` dump,
 * never a status word or byte count. `grouped` additionally folds a run of
 * consecutive calls — merging across message boundaries as long as nothing
 * visible interrupts them — into one row naming the work, expandable
 * (ctrl+o) to one line per call. A collapsible `read` call joins that same
 * group like any other call once `display.toolCalls` is `compact`/`grouped`;
 * `ReadToolGroupComponent` keeps owning it only in `full` mode.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import {
	CompactToolCallComponent,
	type CompactToolGroupHolder,
	mountCompactToolCall,
	resetCompactToolGroup,
} from "@oh-my-pi/pi-coding-agent/modes/components/tool-call-compact";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { buildAsyncResultBlock } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { Container, parseSgrMouse } from "@oh-my-pi/pi-tui";
const ESC = String.fromCharCode(27);

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

describe("CompactToolCallComponent", () => {
	it("renders `Tool(primary argument)` with no status word or byte count", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "ls -la" }, undefined);
		component.setExecutionStarted("call-1");
		component.updateResult({ content: [{ type: "text", text: "a.txt\nb.txt\n" }], isError: false }, false, "call-1");
		const text = plain(component.render(120));
		expect(text).toContain("Bash(ls -la)");
		expect(text).not.toContain("ok");
		expect(text).not.toContain("B)");
	});

	it("a search row carries its pattern, not its directory", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "grep", "Grep", { pattern: "codex_pool_models", path: "ansible" }, undefined);
		component.updateResult({ content: [{ type: "text", text: "hit" }], isError: false }, false, "call-1");
		expect(plain(component.render(120))).toContain("Grep(codex_pool_models)");
	});
});

describe("CompactToolCallComponent click-to-expand (C7)", () => {
	beforeAll(() => {
		initTheme();
	});

	it("a left click on a settled single row toggles it; the sibling stays collapsed", () => {
		const first = new CompactToolCallComponent();
		first.addCall("call-1", "bash", "Bash", { command: "echo one" }, undefined);
		first.updateResult(
			{ content: [{ type: "text", text: "out one\nmore\nlines" }], isError: false },
			false,
			"call-1",
		);
		const second = new CompactToolCallComponent();
		second.addCall("call-2", "bash", "Bash", { command: "echo two" }, undefined);
		second.updateResult({ content: [{ type: "text", text: "out two" }], isError: false }, false, "call-2");

		const collapsed = plain(first.render(120));
		expect(collapsed.split("\n")).toHaveLength(1);
		expect(first.getViewportClickAction()).toBeDefined();

		first.getViewportClickAction()!(0);
		const expanded = plain(first.render(120));
		expect(expanded.split("\n").length).toBeGreaterThan(1);
		expect(expanded).toContain("out one");
		expect(expanded).toContain("more");

		// The sibling is untouched: its rows never changed, and its own toggle
		// acts on it alone — opening its own card, not the first row's.
		expect(plain(second.render(120)).split("\n")).toHaveLength(1);
		expect(second.getViewportClickAction()).toBeDefined();
		second.getViewportClickAction()!(0);
		const siblingExpanded = plain(second.render(120));
		expect(siblingExpanded.split("\n").length).toBeGreaterThan(1);
		expect(siblingExpanded).toContain("out two");
		expect(siblingExpanded).not.toContain("out one");

		// A second click collapses the first row back.
		first.getViewportClickAction()!(0);
		expect(plain(first.render(120)).split("\n")).toHaveLength(1);
	});

	it("a grouped row expands to the summary plus one dimmed line per call, and a second click collapses it", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo first" }, undefined);
		component.addCall("call-2", "bash", "Bash", { command: "echo second" }, undefined);
		const collapsed = plain(component.render(120));
		expect(collapsed.split("\n")).toHaveLength(1);
		expect(collapsed).toContain("2 shell commands");

		component.getViewportClickAction()!(0);
		const expandedLines = component.render(120);
		expect(expandedLines).toHaveLength(3);
		expect(expandedLines[1]).toContain("\x1b[2m"); // per-call lines are dimmed (C7)
		expect(expandedLines[2]).toContain("\x1b[2m");
		const expanded = plain(expandedLines);
		expect(expanded).toContain("2 shell commands"); // the summary row stays (req 3)
		expect(expanded).toContain("echo first");
		expect(expanded).toContain("echo second");

		component.getViewportClickAction()!(0);
		expect(plain(component.render(120))).toBe(collapsed);
	});

	it("marks every row with what a click does: ▸ opens, ▾ closes — a running call included", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo one" }, undefined);
		component.addCall("call-2", "bash", "Bash", { command: "echo two" }, undefined);
		component.updateResult({ content: [{ type: "text", text: "out one" }], isError: false }, false, "call-1");
		// call-2 never settles: its row still opens, to its arguments.
		expect(plain(component.render(120)).startsWith("▸ ")).toBe(true);

		component.getViewportClickAction()!(0);
		const expanded = plain(component.render(120)).split("\n");
		expect(expanded[0]!.startsWith("▾ ")).toBe(true);
		expect(expanded[1]!.startsWith("   ▸ ")).toBe(true);
		expect(expanded[2]!.startsWith("   ▸ ")).toBe(true);

		component.getViewportClickAction()!(1); // open call-1's card
		const opened = plain(component.render(120)).split("\n");
		expect(opened[1]!.startsWith("   ▾ ")).toBe(true);
	});

	it("a wheel report is not a left click and toggles nothing", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo hi" }, undefined);
		component.updateResult({ content: [{ type: "text", text: "out" }], isError: false }, false, "call-1");
		const before = plain(component.render(120));

		const event = parseSgrMouse(`${ESC}[<65;5;1M`);
		expect(event).not.toBeNull();
		expect(event!.leftClick).toBe(false);
		expect(event!.wheel).toBe(1);
		// No toggle method fires without a real left click routed to the row.
		expect(plain(component.render(120))).toBe(before);
	});

	it("ctrl+o keeps driving the session-wide flag alongside per-row state", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo first" }, undefined);
		component.addCall("call-2", "bash", "Bash", { command: "echo second" }, undefined);

		// ctrl+o expands every row session-wide…
		component.setExpanded(true);
		expect(plain(component.render(120)).split("\n")).toHaveLength(3);
		component.setExpanded(false);
		expect(plain(component.render(120)).split("\n")).toHaveLength(1);

		// …while a click override on this row stays independent of it.
		component.getViewportClickAction()!(0);
		expect(plain(component.render(120)).split("\n")).toHaveLength(3);
		component.setExpanded(false);
		expect(plain(component.render(120)).split("\n")).toHaveLength(3);
		component.getViewportClickAction()!(0);
		expect(plain(component.render(120)).split("\n")).toHaveLength(1);
		// With the override cleared and the baseline false, the row is collapsed again.
		component.setExpanded(false);
		expect(plain(component.render(120)).split("\n")).toHaveLength(1);
	});

	it("a running call is clickable too: its card shows the arguments the row truncated", () => {
		const pending = new CompactToolCallComponent();
		pending.addCall("call-1", "bash", "Bash", { command: "echo running with a very long tail of arguments" }, undefined);
		expect(pending.getViewportClickAction()).toBeDefined();
		expect(pending.getClickFocusAgentIds()).not.toEqual([]);

		pending.getViewportClickAction()!(0);
		expect(plain(pending.render(120))).toContain("echo running with a very long tail of arguments");

		// The result lands in the already-open card.
		pending.updateResult({ content: [{ type: "text", text: "late output" }], isError: false }, false, "call-1");
		expect(plain(pending.render(120))).toContain("late output");
	});

	it("clicking one subordinate call in an expanded group opens its stock full card; a second click restores the dimmed line", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo one" }, undefined);
		component.addCall("call-2", "bash", "Bash", { command: "echo two" }, undefined);
		component.updateResult({ content: [{ type: "text", text: "out one" }], isError: false }, false, "call-1");
		component.updateResult({ content: [{ type: "text", text: "out two" }], isError: false }, false, "call-2");
		component.getViewportClickAction()!(0); // expand: row 0 = summary, row 1 = call-1, row 2 = call-2

		component.getViewportClickAction()!(2); // click call-2's own dimmed line
		const openedLines = component.render(120);
		expect(openedLines.length).toBeGreaterThan(3);
		const opened = plain(openedLines);
		expect(opened).toContain("out two");
		expect(plain([openedLines[0]!])).toContain("2 shell commands"); // summary untouched
		expect(plain([openedLines[1]!])).toContain("echo one"); // call-1 stays a dimmed one-liner
		// The open call keeps its own header row above the card, so the row that
		// closes it again is on screen.
		expect(plain([openedLines[2]!])).toContain("echo two");

		const ui: ToolExecutionUi = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
		const reference = new ToolExecutionComponent("bash", { command: "echo two" }, {}, undefined, ui, undefined, "call-2");
		reference.setExpanded(true);
		reference.setArgsComplete("call-2");
		reference.setExecutionStarted("call-2");
		reference.updateResult({ content: [{ type: "text", text: "out two" }], isError: false }, false, "call-2");
		// Card rows are the stock card's own, indented under the header.
		const cardRows = openedLines.slice(3).map(line => Bun.stripANSI(line));
		expect(cardRows.every(row => row.startsWith("   "))).toBe(true);
		expect(cardRows.map(row => row.slice(3)).join("\n")).toBe(plain(reference.render(117)));

		// A second click on any of the open card's own rows restores the dimmed line.
		component.getViewportClickAction()!(openedLines.length - 1);
		const closedLines = component.render(120);
		expect(closedLines).toHaveLength(3);
		expect(plain([closedLines[2]!])).toContain("echo two");
		expect(plain([closedLines[2]!])).not.toContain("out two");
	});

	it("hovering one row in an expanded group bands only that row's own id, never a sibling's or the summary's", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo one" }, undefined);
		component.addCall("call-2", "bash", "Bash", { command: "echo two" }, undefined);
		component.updateResult({ content: [{ type: "text", text: "out one" }], isError: false }, false, "call-1");
		component.updateResult({ content: [{ type: "text", text: "out two" }], isError: false }, false, "call-2");
		component.getViewportClickAction()!(0);
		component.render(120);

		const summaryIds = component.getClickFocusAgentIds(0);
		const call1Ids = component.getClickFocusAgentIds(1);
		const call2Ids = component.getClickFocusAgentIds(2);
		expect(summaryIds).toHaveLength(1);
		expect(call1Ids).toHaveLength(1);
		expect(call2Ids).toHaveLength(1);
		expect(new Set([...summaryIds, ...call1Ids, ...call2Ids]).size).toBe(3);
	});

	it("a still-pending sibling inside an expanded group opens like any other row", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo one" }, undefined);
		component.addCall("call-2", "bash", "Bash", { command: "echo two on a much longer line" }, undefined);
		component.updateResult({ content: [{ type: "text", text: "out one" }], isError: false }, false, "call-1");
		// call-2 never settles.
		component.getViewportClickAction()!(0);
		component.render(120);

		expect(component.getClickFocusAgentIds(2)).not.toEqual([]);
		component.getViewportClickAction()!(2);
		expect(plain(component.render(120))).toContain("echo two on a much longer line");
	});

	it("a group is only red when nothing in it worked: one failure among successes is not a failed run", () => {
		const icon = (rows: string): string => rows.split("\n")[0]!.replace(/^[▸▾]\s*/, "").slice(0, 1);
		const mixed = new CompactToolCallComponent();
		mixed.addCall("call-1", "bash", "Bash", { command: "echo one" }, undefined);
		mixed.addCall("call-2", "bash", "Bash", { command: "echo two" }, undefined);
		mixed.updateResult({ content: [{ type: "text", text: "out" }], isError: false }, false, "call-1");
		mixed.updateResult({ content: [{ type: "text", text: "boom" }], isError: true }, false, "call-2");

		const allFailed = new CompactToolCallComponent();
		allFailed.addCall("call-1", "bash", "Bash", { command: "echo one" }, undefined);
		allFailed.addCall("call-2", "bash", "Bash", { command: "echo two" }, undefined);
		allFailed.updateResult({ content: [{ type: "text", text: "boom" }], isError: true }, false, "call-1");
		allFailed.updateResult({ content: [{ type: "text", text: "boom" }], isError: true }, false, "call-2");

		const stillRunning = new CompactToolCallComponent();
		stillRunning.addCall("call-1", "bash", "Bash", { command: "echo one" }, undefined);
		stillRunning.addCall("call-2", "bash", "Bash", { command: "echo two" }, undefined);
		stillRunning.updateResult({ content: [{ type: "text", text: "boom" }], isError: true }, false, "call-1");

		const failedIcon = icon(plain(allFailed.render(120)));
		expect(icon(plain(mixed.render(120)))).not.toBe(failedIcon);
		expect(icon(plain(stillRunning.render(120)))).not.toBe(failedIcon);
		expect(icon(plain(stillRunning.render(120)))).not.toBe(icon(plain(mixed.render(120))));
		// The failure is not hidden — it is on its own row once expanded.
		mixed.getViewportClickAction()!(0);
		expect(plain(mixed.render(120)).split("\n")[2]).toContain(failedIcon);
	});

	it("collapsing the group (ctrl+o) while a subordinate call is open retracts its card", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo one" }, undefined);
		component.addCall("call-2", "bash", "Bash", { command: "echo two" }, undefined);
		component.updateResult({ content: [{ type: "text", text: "out one" }], isError: false }, false, "call-1");
		component.updateResult({ content: [{ type: "text", text: "out two" }], isError: false }, false, "call-2");
		component.setExpanded(true);
		component.render(120);
		component.getViewportClickAction()!(2); // open call-2
		expect(component.render(120).length).toBeGreaterThan(3);

		component.setExpanded(false); // ctrl+o collapses the whole group back to its summary
		const collapsed = component.render(120);
		expect(collapsed).toHaveLength(1);
		expect(plain(collapsed)).toContain("2 shell commands");

		component.setExpanded(true); // re-expanding must not silently resurrect the old open card
		expect(component.render(120)).toHaveLength(3);
	});

	it("a settled call whose output is empty still opens: the card shows the full command the row truncated", () => {
		const component = new CompactToolCallComponent();
		const command = `find ~/.claude/projects -name "e7ea78bd-2ca4-4de9-af12-a73051af1d89.jsonl" -maxdepth 6 -print`;
		component.addCall("call-1", "bash", "Bash", { command }, undefined);
		component.updateResult({ content: [{ type: "text", text: "" }], isError: false }, false, "call-1");

		expect(component.getClickFocusAgentIds(0)).toHaveLength(1);
		component.getViewportClickAction()!(0);
		const opened = plain(component.render(120));
		expect(opened).toContain("-maxdepth 6 -print");
	});

	it("an open card keeps the block out of native scrollback until the closing click", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo one" }, undefined);
		component.addCall("call-2", "bash", "Bash", { command: "echo two" }, undefined);
		component.updateResult({ content: [{ type: "text", text: "out one" }], isError: false }, false, "call-1");
		component.updateResult({ content: [{ type: "text", text: "out two" }], isError: false }, false, "call-2");
		component.seal();
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		component.getViewportClickAction()!(0);
		component.render(120);
		component.getViewportClickAction()!(2); // open call-2's card
		component.render(120);
		// Retiring now would print the open card into scrollback, where no click
		// can ever collapse it again.
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		component.getViewportClickAction()!(2); // close it
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});
});

describe("CompactToolCallComponent ask resultSummary (B)", () => {
	beforeAll(() => {
		initTheme();
	});

	it("the ask row shows the question before resolution and the chosen answer after", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "ask", "Ask", { questions: [{ id: "q1", question: "Use plan mode?", options: ["Plan", "No"], multi: false }] }, undefined);
		const pending = plain(component.render(120));
		expect(pending).toContain("Ask(Use plan mode?)");
		expect(pending).not.toContain("Yes");

		component.updateResult(
			{
				content: [{ type: "text", text: "User answers:\nq1: Plan" }],
				details: { results: [{ id: "q1", question: "Use plan mode?", options: ["Plan", "No"], multi: false, selectedOptions: ["Plan"] }] },
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
				content: [{ type: "text", text: "User answers:\nq1: \"feat/x\"" }],
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

/** Drive a user prompt (`message_start` only — that is all a group-reset boundary needs). */
async function sendUserMessage(controller: EventController, text: string): Promise<void> {
	await controller.handleEvent({
		type: "message_start",
		message: { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp: Date.now() },
	} as AgentSessionEvent);
}

function compactGroups(chatContainer: TranscriptContainer): CompactToolCallComponent[] {
	return chatContainer.children.filter((c): c is CompactToolCallComponent => c instanceof CompactToolCallComponent);
}

function plain(lines: readonly string[]): string {
	return Bun.stripANSI(lines.join("\n"));
}

function asyncResultMessage(details: Record<string, unknown>): CustomMessage {
	return { role: "custom", customType: "async-result", content: "", display: true, details, timestamp: Date.now() };
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

	it("compact renders `Tool(primary argument)` — no key=value, no intent sentence, no status word or byte count (C1, C2, C3)", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("bash", "bash-1", { command: "systemctl restart gateway", i: "Restarting the gateway" }),
		]);

		const groups = compactGroups(chatContainer);
		expect(groups).toHaveLength(1);
		const text = plain(groups[0]!.render(120));
		expect(text).toContain("(systemctl restart gateway)");
		expect(text).not.toContain("Restarting the gateway"); // the model's own intent (C2) never reaches the row
		expect(text).not.toContain("command="); // no key=value dump of the argument object (C1)
		expect(text).not.toMatch(/\bok\b/); // success is the icon alone, no status word (C3)
		expect(text).not.toMatch(/\d+\s*B\b/); // never a byte count (C3)
	});

	it("compact never folds a second call into the first call's row", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("bash", "bash-1", { command: "echo first" }),
			toolCall("bash", "bash-2", { command: "echo second" }),
		]);

		const groups = compactGroups(chatContainer);
		expect(groups).toHaveLength(2);
		expect(groups[0]!.render(120)).toHaveLength(1);
		expect(groups[1]!.render(120)).toHaveLength(1);
	});

	it("a long primary argument truncates to the budget with a single ellipsis, never mid-escape (C8)", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		const longCommand = `echo ${"x".repeat(200)}`;
		await streamCompletion(controller, [toolCall("bash", "bash-1", { command: longCommand })]);

		const text = plain(compactGroups(chatContainer)[0]!.render(400));
		expect(text).not.toContain(longCommand);
		expect(text).toContain("echo ");
		const ellipses = [...text].filter(ch => ch === "…").length;
		expect(ellipses).toBe(1);
	});

	it("grouped names the work instead of a bare call count, and expands to one row per call (C5)", async () => {
		settings.set("display.toolCalls", "grouped");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("bash", "call-1", { command: "echo one" }),
			toolCall("bash", "call-2", { command: "echo two" }),
			toolCall("bash", "call-3", { command: "echo three" }),
		]);

		const groups = compactGroups(chatContainer);
		expect(groups).toHaveLength(1);
		const group = groups[0]!;
		const collapsed = plain(group.render(120));
		expect(collapsed).toContain("3 shell commands");
		expect(collapsed).not.toMatch(/\d+ tool calls?/);

		group.setExpanded(true);
		const expanded = plain(group.render(120));
		expect(expanded).toContain("echo one");
		expect(expanded).toContain("echo two");
		expect(expanded).toContain("echo three");
	});

	it("grouped names every tool in a mixed-tool run, not the total (C5)", async () => {
		settings.set("display.toolCalls", "grouped");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("bash", "call-1", { command: "echo one" }),
			toolCall("bash", "call-2", { command: "echo two" }),
			toolCall("write", "call-3", { path: "out.txt", content: "hi" }),
		]);

		const text = plain(compactGroups(chatContainer)[0]!.render(120));
		expect(text).toContain("2 shell commands");
		expect(text).toContain("1 file written");
		expect(text).not.toMatch(/3 tool calls?/);
	});

	it("grouped merges two consecutive assistant messages whose tool calls are not interrupted by anything visible (Defect 1)", async () => {
		settings.set("display.toolCalls", "grouped");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [toolCall("bash", "call-1", { command: "echo one" })]);
		await streamCompletion(controller, [toolCall("bash", "call-2", { command: "echo two" })]);

		const groups = compactGroups(chatContainer);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.size).toBe(2);
	});

	it("grouped starts a fresh group after visible assistant content breaks the run", async () => {
		settings.set("display.toolCalls", "grouped");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [toolCall("bash", "call-1", { command: "echo one" })]);
		await streamCompletion(controller, [
			thinking("Now checking something else"),
			toolCall("bash", "call-2", { command: "echo two" }),
		]);

		expect(compactGroups(chatContainer)).toHaveLength(2);
	});

	it("grouped closes the run on a user message, even mid-turn (Defect 1)", async () => {
		settings.set("display.toolCalls", "grouped");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [toolCall("bash", "call-1", { command: "echo one" })]);
		await sendUserMessage(controller, "actually, do this instead");
		await streamCompletion(controller, [toolCall("bash", "call-2", { command: "echo two" })]);

		expect(compactGroups(chatContainer)).toHaveLength(2);
	});

	it("grouped joins a collapsible read call into the compact group like any other call", async () => {
		settings.set("display.toolCalls", "grouped");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [toolCall("read", "read-1", { path: "/tmp/example.ts" })]);

		const readGroups = chatContainer.children.filter(child => child instanceof ReadToolGroupComponent);
		expect(readGroups).toHaveLength(0);
		const groups = compactGroups(chatContainer);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.size).toBe(1);
	});

	it("grouped keeps a read call in the same group as surrounding bash calls", async () => {
		settings.set("display.toolCalls", "grouped");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [toolCall("bash", "call-1", { command: "echo one" })]);
		await streamCompletion(controller, [toolCall("read", "read-1", { path: "/tmp/example.ts" })]);
		await streamCompletion(controller, [toolCall("bash", "call-2", { command: "echo two" })]);

		const groups = compactGroups(chatContainer);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.size).toBe(3);
	});

	it("grouped names bash, read, eval, and grep in one mixed run, with no Called-once fallback for a built-in (C5)", async () => {
		settings.set("display.toolCalls", "grouped");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("bash", "call-1", { command: "echo one" }),
			toolCall("bash", "call-2", { command: "echo two" }),
			toolCall("read", "read-1", { path: "/tmp/example.ts" }),
			toolCall("eval", "eval-1", { language: "js", code: "1+1" }),
			toolCall("grep", "grep-1", { pattern: "needle", path: "/tmp/hay" }),
		]);

		const readGroups = chatContainer.children.filter(child => child instanceof ReadToolGroupComponent);
		expect(readGroups).toHaveLength(0);
		const groups = compactGroups(chatContainer);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.size).toBe(5);

		const text = plain(groups[0]!.render(120));
		expect(text).toContain("2 shell commands");
		expect(text).toContain("1 file read");
		expect(text).toContain("1 eval");
		expect(text).toContain("1 search");
		expect(text).not.toMatch(/Called \w+ once/);
	});

	it("a waiting poll (hub wait) renders a human name, not a bare internal id (C6)", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [toolCall("hub", "hub-1", { op: "wait", ids: ["bg_10", "bg_11"] })]);

		const text = plain(compactGroups(chatContainer)[0]!.render(120));
		expect(text).not.toContain("bg_10");
		expect(text).not.toContain("bg_11");
		expect(text).toContain("2 jobs");
	});

	it("hub renders the peer's own name for a wait addressed by peer, not a serialized args dump (C1, C6)", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [toolCall("hub", "hub-1", { op: "wait", from: "CompactRows" })]);

		const text = plain(compactGroups(chatContainer)[0]!.render(120));
		expect(text).toContain("CompactRows");
		expect(text).not.toContain("op=");
	});

	it("ask renders the question itself for one question, a count for several — never the raw `questions` array (C1, C6)", async () => {
		settings.set("display.toolCalls", "compact");
		const { controller, chatContainer } = createFixture();
		await streamCompletion(controller, [
			toolCall("ask", "ask-1", { questions: [{ id: "q1", question: "JWT or session cookies?", options: [] }] }),
		]);

		const text = plain(compactGroups(chatContainer)[0]!.render(120));
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

		const text = plain(compactGroups(chatContainer)[0]!.render(120));
		expect(text).toContain("2 questions");
		expect(text).not.toMatch(/\[2 items\]/);
	});
});

describe("CompactToolCallComponent", () => {
	it("renders `Tool(primary argument)` with no status word or byte count", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "ls -la" }, undefined);
		component.setExecutionStarted("call-1");
		component.updateResult({ content: [{ type: "text", text: "a.txt\nb.txt\n" }], isError: false }, false, "call-1");

		const text = plain(component.render(120));
		expect(text).toContain("Bash(ls -la)");
		expect(text).not.toMatch(/\bok\b/);
		expect(text).not.toMatch(/\d+\s*B\b/);
	});

	it("shows a live duration only while the call is running; a settled ordinary call carries none (C3)", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "restart gateway" }, undefined);
		component.setExecutionStarted("call-1");

		const runningText = plain(component.render(120));
		expect(runningText).toMatch(/\d+(\.\d+)?(ms|s)/);

		component.updateResult({ content: [{ type: "text", text: "" }], isError: false }, false, "call-1");
		const settledText = plain(component.render(120));
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

	it("a failure shows its first error line, not a status word (C3)", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "chmod 400 file" }, undefined);
		component.updateResult(
			{ content: [{ type: "text", text: "Permission denied\nsome stack trace the row must not show" }], isError: true },
			false,
			"call-1",
		);

		const text = plain(component.render(120));
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

	it("folds N calls into one collapsed group row naming the work, and expands to the summary plus N rows", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo first" }, undefined);
		component.addCall("call-2", "bash", "Bash", { command: "echo second" }, undefined);
		component.addCall("call-3", "bash", "Bash", { command: "echo third" }, undefined);
		component.updateResult({ content: [{ type: "text", text: "" }], isError: false }, false, "call-1");
		component.updateResult({ content: [{ type: "text", text: "" }], isError: true }, false, "call-2");

		const collapsed = component.render(120);
		expect(collapsed).toHaveLength(1);
		expect(plain(collapsed)).toContain("3 shell commands");

		component.setExpanded(true);
		const expanded = component.render(120);
		expect(expanded).toHaveLength(4);
		expect(Bun.stripANSI(expanded[0]!)).toContain("3 shell commands");
		expect(Bun.stripANSI(expanded[1]!)).toContain("echo first");
		expect(Bun.stripANSI(expanded[2]!)).toContain("echo second");
		expect(Bun.stripANSI(expanded[3]!)).toContain("echo third");
	});

	it("closes to new entries only once finalized — a settled-but-unfinalized group stays open (Defect 1)", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo hi" }, undefined);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		component.updateResult({ content: [{ type: "text", text: "" }], isError: false }, false, "call-1");
		// Settled, but never finalize()d: a sibling call could still join this
		// group (the whole point of Defect 1's fix), so it is not yet
		// transcript-finalized — mirrors ReadToolGroupComponent's own pair.
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		component.finalize();
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("seal() forces finalized even with a call still pending", () => {
		const component = new CompactToolCallComponent();
		component.addCall("call-1", "bash", "Bash", { command: "echo hi" }, undefined);
		component.seal();
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});
});

describe("mountCompactToolCall / resetCompactToolGroup", () => {
	it("compact mode finalizes its single-call group immediately; grouped mode holds it open until reset", () => {
		const container = new Container();
		const compactHolder: CompactToolGroupHolder = { current: undefined };
		const { group: compactGroup } = mountCompactToolCall(
			container,
			compactHolder,
			"compact",
			false,
			"call-1",
			"bash",
			{ command: "echo hi" },
			undefined,
		);
		compactGroup.updateResult({ content: [{ type: "text", text: "" }], isError: false }, false, "call-1");
		expect(compactGroup.isTranscriptBlockFinalized()).toBe(true);
		expect(compactHolder.current).toBeUndefined();

		const groupedHolder: CompactToolGroupHolder = { current: undefined };
		const { group: groupedGroup } = mountCompactToolCall(
			container,
			groupedHolder,
			"grouped",
			false,
			"call-2",
			"bash",
			{ command: "echo hi" },
			undefined,
		);
		groupedGroup.updateResult({ content: [{ type: "text", text: "" }], isError: false }, false, "call-2");
		expect(groupedGroup.isTranscriptBlockFinalized()).toBe(false);
		expect(groupedHolder.current).toBe(groupedGroup);
	});

	it("reuses the held grouped group for as long as the holder keeps it, regardless of the container's tail", () => {
		const container = new Container();
		const holder: CompactToolGroupHolder = { current: undefined };
		const { group: first } = mountCompactToolCall(
			container,
			holder,
			"grouped",
			false,
			"call-1",
			"bash",
			{ command: "echo one" },
			undefined,
		);
		// An unrelated child lands after it (the live path's invisible
		// per-message placeholder) — the held group must still extend.
		container.addChild(new Container());
		const { group: second } = mountCompactToolCall(
			container,
			holder,
			"grouped",
			false,
			"call-2",
			"bash",
			{ command: "echo two" },
			undefined,
		);
		expect(second).toBe(first);
		expect(first.size).toBe(2);
	});

	it("resetCompactToolGroup(sealed: false) closes the held group to new entries but lets a pending call keep resolving", () => {
		const container = new Container();
		const holder: CompactToolGroupHolder = { current: undefined };
		const { group } = mountCompactToolCall(
			container,
			holder,
			"grouped",
			false,
			"call-1",
			"bash",
			{ command: "echo hi" },
			undefined,
		);
		resetCompactToolGroup(holder, false);
		expect(holder.current).toBeUndefined();
		expect(group.isTranscriptBlockFinalized()).toBe(false); // still has its one pending call
		group.updateResult({ content: [{ type: "text", text: "" }], isError: false }, false, "call-1");
		expect(group.isTranscriptBlockFinalized()).toBe(true); // finalize()d earlier, now settled too
	});

	it("resetCompactToolGroup(sealed: true) forces the held group finalized even with a call still pending", () => {
		const container = new Container();
		const holder: CompactToolGroupHolder = { current: undefined };
		const { group } = mountCompactToolCall(
			container,
			holder,
			"grouped",
			false,
			"call-1",
			"bash",
			{ command: "echo hi" },
			undefined,
		);
		resetCompactToolGroup(holder, true);
		expect(group.isTranscriptBlockFinalized()).toBe(true);
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
