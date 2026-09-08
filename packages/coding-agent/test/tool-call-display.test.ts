import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ToolCallGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-call-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { buildCollapsedToolCallLine } from "@oh-my-pi/pi-coding-agent/tools/tool-call-display";
import type { TUI } from "@oh-my-pi/pi-tui";

const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function plain(text: string): string {
	return text.replace(ANSI, "");
}

function makeCall(
	toolName: string,
	args: Record<string, unknown>,
	tool: Partial<AgentTool>,
	result?: { text: string; isError?: boolean; details?: unknown },
): ToolExecutionComponent {
	const component = new ToolExecutionComponent(toolName, args, {}, tool as AgentTool, ui, "/tmp", `${toolName}-1`);
	component.setArgsComplete();
	component.setExecutionStarted();
	if (result) {
		component.updateResult(
			{ content: [{ type: "text", text: result.text }], isError: result.isError, details: result.details },
			false,
		);
	}
	return component;
}

describe("collapsed tool-call lines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	test("bash call with an intent and exit 0 renders one line", () => {
		const call = makeCall(
			"bash",
			{ command: "systemctl restart gateway" },
			{ label: "Bash", intent: () => "Restarting the gateway" },
			{ text: "a\nb\nc" },
		);
		const line = plain(buildCollapsedToolCallLine(call.collapsedCall(), theme, 120));
		console.log(`  1 | ${line}`);
		expect(line.split("\n")).toHaveLength(1);
		expect(line).toContain("Restarting the gateway");
		expect(line).toContain("ok");
		expect(line).toContain("3 lines");
	});

	test("read call with no intent falls back to label plus args preview", () => {
		const call = makeCall(
			"read",
			{ path: "/tmp/memory-provider.md" },
			{ label: "Read" },
			{ text: Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n") },
		);
		const line = plain(buildCollapsedToolCallLine(call.collapsedCall(), theme, 120));
		console.log(`  2 | ${line}`);
		expect(line.split("\n")).toHaveLength(1);
		expect(line).toContain("Read");
		expect(line).toContain("memory-provider.md");
		expect(line).toContain("25 lines");
	});

	test("failed call renders one line with its exit code", () => {
		const call = makeCall(
			"bash",
			{ command: "false" },
			{ label: "Bash", intent: () => "Restarting the gateway" },
			{ text: "boom\nstack\ntrace", isError: true, details: { exitCode: 1 } },
		);
		const line = plain(buildCollapsedToolCallLine(call.collapsedCall(), theme, 120));
		console.log(`  3 | ${line}`);
		expect(line.split("\n")).toHaveLength(1);
		expect(line).toContain("exit 1");
		expect(line).toContain("3 lines");
	});

	test("setIntent threads a live intent onto a tool with no intent() implementation", () => {
		// bash has no `intent()` function (see command-review.ts's DANGEROUS-pattern
		// comment for the same fact) — before setIntent existed, this call could only
		// ever render its raw args preview. omp resolves an intent for every call
		// regardless (model `i` field, or a derived value) and forwards it via
		// `tool_execution_start`/persisted history; setIntent is the seam that
		// carries it onto the collapsed line.
		const call = makeCall("bash", { command: "ssh ayusavin@mac-mini-home.tail4430", timeout: 20 }, { label: "Bash" }, { text: "a\nb" });
		call.setIntent("Checking disk usage on mac-mini-home");
		const line = plain(buildCollapsedToolCallLine(call.collapsedCall(), theme, 120));
		expect(line).toContain("Checking disk usage on mac-mini-home");
		expect(line).not.toContain("command=");
	});

	test("no threaded intent and no tool.intent(): falls back to label plus raw args preview", () => {
		const call = makeCall("bash", { command: "ssh ayusavin@mac-mini-home.tail4430", timeout: 20 }, { label: "Bash" }, { text: "a\nb" });
		const line = plain(buildCollapsedToolCallLine(call.collapsedCall(), theme, 120));
		expect(line).toContain("Bash");
		expect(line).toContain("command=");
	});

	test("a threaded intent on one call does not change the group summary line", () => {
		const group = new ToolCallGroupComponent();
		const a = makeCall("bash", { command: "a" }, { label: "Bash" }, { text: "ok" });
		a.setIntent("Running the release script");
		group.addCall(a);
		group.addCall(makeCall("bash", { command: "b" }, { label: "Bash" }, { text: "ok" }));
		group.addCall(makeCall("read", { path: "/tmp/x.md" }, { label: "Read" }, { text: "x" }));
		const rows = group.render(120).map(plain);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Ran 2 commands, read 1 file");
		expect(rows[0]).not.toContain("Running the release script");
	});

	test("four calls in one turn render one summary row", () => {
		const group = new ToolCallGroupComponent();
		group.addCall(makeCall("bash", { command: "a" }, { label: "Bash" }, { text: "ok" }));
		group.addCall(makeCall("bash", { command: "b" }, { label: "Bash" }, { text: "ok" }));
		group.addCall(
			makeCall("bash", { command: "c" }, { label: "Bash" }, { text: "no", isError: true, details: { exitCode: 2 } }),
		);
		group.addCall(makeCall("read", { path: "/tmp/x.md" }, { label: "Read" }, { text: "x" }));
		const rows = group.render(120).map(plain);
		console.log(`  4 | ${rows.join("\n")}`);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Ran 3 commands, read 1 file");
		expect(rows[0]).toContain("1 failed");
	});
});
