import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolCallGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-call-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { BlockExpansionCursor, type ExpandableBlock } from "@oh-my-pi/pi-coding-agent/modes/utils/block-expansion";
import { setToolCallExpandLevel } from "@oh-my-pi/pi-coding-agent/tools/tool-call-display";
import type { TUI } from "@oh-my-pi/pi-tui";

const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;

/** Stand-in for a transcript block; the cursor only ever sees this contract. */
class FakeBlock implements ExpandableBlock {
	level = 0;
	constructor(
		readonly label: string,
		readonly cycle: readonly number[] = [0, 2],
		readonly calls: FakeBlock[] = [],
	) {}
	blockExpandLevel(): number {
		return this.level;
	}
	setBlockExpandLevel(level: number | undefined): void {
		this.level = level ?? 0;
	}
	blockExpandCycle(): readonly number[] {
		return this.cycle;
	}
	expandedBlockCalls(): readonly ExpandableBlock[] {
		return this.level > 0 ? this.calls : [];
	}
	blockExpandLabel(): string {
		return this.label;
	}
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

describe("block expansion selection", () => {
	test("selection starts at the newest live block", () => {
		const cursor = new BlockExpansionCursor();
		const blocks = [new FakeBlock("oldest"), new FakeBlock("middle"), new FakeBlock("newest")];
		const selection = cursor.current(blocks)!;
		expect(selection.block.blockExpandLabel()).toBe("newest");
		expect(selection.position).toBe(3);
		expect(selection.total).toBe(3);
		expect(selection.atNewest).toBe(true);
	});

	test("an unpinned cursor follows the newest block as turns append", () => {
		const cursor = new BlockExpansionCursor();
		const blocks = [new FakeBlock("a"), new FakeBlock("b")];
		expect(cursor.current(blocks)!.block.blockExpandLabel()).toBe("b");
		blocks.push(new FakeBlock("c"));
		expect(cursor.current(blocks)!.block.blockExpandLabel()).toBe("c");
	});

	test("moving past the oldest live block stops instead of wrapping into scrollback", () => {
		const cursor = new BlockExpansionCursor();
		const blocks = [new FakeBlock("oldest"), new FakeBlock("newest")];
		expect(cursor.move(blocks, -1)!.block.blockExpandLabel()).toBe("oldest");
		const stuck = cursor.move(blocks, -1)!;
		expect(stuck.block.blockExpandLabel()).toBe("oldest");
		expect(stuck.atOldest).toBe(true);
		expect(cursor.move(blocks, 1)!.block.blockExpandLabel()).toBe("newest");
		const capped = cursor.move(blocks, 1)!;
		expect(capped.block.blockExpandLabel()).toBe("newest");
		expect(capped.atNewest).toBe(true);
	});

	test("the scrollback notice is offered once, not once per block", () => {
		const cursor = new BlockExpansionCursor();
		expect(cursor.takeCommittedNotice()).toBe(true);
		expect(cursor.takeCommittedNotice()).toBe(false);
		expect(cursor.takeCommittedNotice()).toBe(false);
	});

	test("a pin that retired into scrollback falls back to the newest live block", () => {
		const cursor = new BlockExpansionCursor();
		const oldest = new FakeBlock("oldest");
		const newest = new FakeBlock("newest");
		cursor.move([oldest, newest], -1);
		expect(cursor.current([oldest, newest])!.block.blockExpandLabel()).toBe("oldest");
		expect(cursor.current([newest])!.block.blockExpandLabel()).toBe("newest");
	});

	test("ctrl+o walks only the selected block's own cycle", () => {
		const cursor = new BlockExpansionCursor();
		const older = new FakeBlock("older");
		const newer = new FakeBlock("newer");
		const blocks = [older, newer];
		expect(cursor.cycle(blocks)!.level).toBe(2);
		expect(newer.level).toBe(2);
		expect(older.level).toBe(0);
		expect(cursor.cycle(blocks)!.level).toBe(0);
		expect(newer.level).toBe(0);
		expect(older.level).toBe(0);
	});

	test("an expanded group puts its calls in reach; collapsing takes them back out", () => {
		const cursor = new BlockExpansionCursor();
		const calls = [new FakeBlock("call 1"), new FakeBlock("call 2")];
		const group = new FakeBlock("group", [0, 1, 2], calls);
		const blocks = [group];
		expect(cursor.current(blocks)!.total).toBe(1);

		const expanded = cursor.cycle(blocks)!;
		expect(expanded.level).toBe(1);
		expect(expanded.total).toBe(3);
		expect(expanded.block.blockExpandLabel()).toBe("group");

		expect(cursor.move(blocks, 1)!.block.blockExpandLabel()).toBe("call 1");
		expect(cursor.move(blocks, 1)!.block.blockExpandLabel()).toBe("call 2");
		expect(cursor.cycle(blocks)!.level).toBe(2);
		expect(calls[1]!.level).toBe(2);
		expect(calls[0]!.level).toBe(0);
		expect(group.level).toBe(1);

		cursor.move(blocks, -1);
		cursor.move(blocks, -1);
		expect(cursor.current(blocks)!.block.blockExpandLabel()).toBe("group");
		const collapsed = cursor.cycle(blocks)!;
		expect(collapsed.level).toBe(2);
		expect(cursor.cycle(blocks)!.level).toBe(0);
		expect(cursor.current(blocks)!.total).toBe(1);
	});

	test("reset collapses every reachable block and re-anchors on the newest", () => {
		const cursor = new BlockExpansionCursor();
		const calls = [new FakeBlock("call 1")];
		const group = new FakeBlock("group", [0, 1, 2], calls);
		const older = new FakeBlock("older");
		const blocks = [older, group];
		cursor.cycle(blocks);
		cursor.move(blocks, -1);
		cursor.reset(blocks);
		expect(group.level).toBe(0);
		expect(calls[0]!.level).toBe(0);
		expect(cursor.current(blocks)!.block.blockExpandLabel()).toBe("group");
	});
});

describe("block expansion rendering", () => {
	beforeAll(async () => {
		await initTheme();
		await Settings.init({ inMemory: true });
	});
	afterAll(() => {
		setToolCallExpandLevel(0);
		resetSettingsForTest();
	});

	function fixture(): { group: ToolCallGroupComponent; calls: ToolExecutionComponent[] } {
		const calls = [
			makeCall(
				"bash",
				{ command: "a" },
				{ label: "Bash", intent: () => "Restarting the gateway" },
				{ text: "1\n2" },
			),
			makeCall("read", { path: "/tmp/x.md" }, { label: "Read" }, { text: "x" }),
			makeCall("bash", { command: "c" }, { label: "Bash" }, { text: "no", isError: true, details: { exitCode: 2 } }),
		];
		const group = new ToolCallGroupComponent();
		for (const call of calls) group.addCall(call);
		return { group, calls };
	}

	test("a group walks three levels: summary row, per-call lines, full cards", () => {
		settings.set("display.toolCalls", "grouped");
		settings.set("display.expandScope", "block");
		const cursor = new BlockExpansionCursor();
		const { group, calls } = fixture();
		const blocks: ExpandableBlock[] = [group];

		const summary = group.render(120);
		expect(summary).toHaveLength(1);
		expect(summary[0]).toContain("Ran 2 commands, read 1 file");

		cursor.cycle(blocks);
		const perCall = group.render(120).filter(row => row.trim().length > 0);
		expect(perCall).toHaveLength(3);
		expect(perCall.join("\n")).toContain("Restarting the gateway");
		expect(group.expandedBlockCalls()).toHaveLength(3);

		cursor.cycle(blocks);
		const cards = group.render(120);
		expect(cards.length).toBeGreaterThan(perCall.length);
		expect(calls.every(call => call.blockExpandLevel() === 2)).toBe(true);

		cursor.cycle(blocks);
		expect(group.render(120)).toEqual(summary);
	});

	test("expanding one call inside a group leaves its siblings byte-identical", () => {
		settings.set("display.toolCalls", "grouped");
		settings.set("display.expandScope", "block");
		const cursor = new BlockExpansionCursor();
		const { group, calls } = fixture();
		const blocks: ExpandableBlock[] = [group];
		cursor.cycle(blocks);

		const before = calls.map(call => call.render(120));
		cursor.move(blocks, 1);
		cursor.move(blocks, 1);
		expect(cursor.current(blocks)!.block).toBe(calls[1]!);
		cursor.cycle(blocks);

		expect(calls[1]!.render(120).length).toBeGreaterThan(1);
		expect(calls[0]!.render(120)).toEqual(before[0]!);
		expect(calls[2]!.render(120)).toEqual(before[2]!);
	});

	test("block scope expands the selected block only; session scope moves every block", () => {
		const older = makeCall("bash", { command: "old" }, { label: "Bash" }, { text: "1\n2\n3" });
		const newer = makeCall("bash", { command: "new" }, { label: "Bash" }, { text: "4\n5\n6" });
		const blocks: ExpandableBlock[] = [older, newer];

		settings.set("display.toolCalls", "compact");
		settings.set("display.expandScope", "block");
		setToolCallExpandLevel(0);
		const collapsed = older.render(120);
		expect(collapsed).toHaveLength(1);

		const cursor = new BlockExpansionCursor();
		cursor.cycle(blocks);
		expect(newer.render(120).length).toBeGreaterThan(1);
		expect(older.render(120)).toEqual(collapsed);
	});

	test("session scope: every block follows the module level, none carries its own", () => {
		settings.set("display.toolCalls", "compact");
		settings.set("display.expandScope", "session");
		const { group, calls } = fixture();

		setToolCallExpandLevel(0);
		expect(group.blockExpandLevel()).toBe(0);
		expect(group.render(120)).toHaveLength(1);
		expect(calls.map(call => call.render(120).length)).toEqual([1, 1, 1]);

		setToolCallExpandLevel(1);
		expect(calls.every(call => call.blockExpandLevel() === 1)).toBe(true);
		expect(group.render(120).filter(row => row.trim().length > 0)).toHaveLength(3);
		expect(calls.map(call => call.render(120).length)).toEqual([1, 1, 1]);

		setToolCallExpandLevel(2);
		expect(calls.every(call => call.render(120).length > 1)).toBe(true);
		setToolCallExpandLevel(0);
	});
});
