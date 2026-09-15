/**
 * Drives the installed omp binary on a real pseudo-terminal and proves that a
 * settled grouped tool row expands and collapses only from its parent row.
 *
 * Usage: OMP_BIN=packages/coding-agent/dist/omp bun scripts/.pty-parent-toggle-probe.ts
 */
import { spawn } from "node:child_process";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const COLS = 150;
const ROWS = 45;
const BIN = process.env.OMP_BIN ?? `${process.env.HOME}/.local/bin/omp`;
const PROMPT =
	"Run exactly these six bash commands, one bash call each, in this order, no other tools: 'echo toggle-command-one', 'echo toggle-command-two', 'echo toggle-command-three', 'echo toggle-command-four', 'echo toggle-command-five', 'echo toggle-command-six'. Then answer with an enumerated list of exactly twelve full-sentence entries, and do not use tools again.";
const PUSH_PROMPT =
	"Without using tools, write an enumerated list of exactly one hundred short entries, one per line, each containing the text viewport-push.";
const GROUP_ROW = /shell commands?/;
const CALL_ROW = /\$ echo toggle-command-(?:one|two|three|four|five|six)\b/;
const term = new VirtualTerminal(COLS, ROWS);
term.start(
	() => {},
	() => {},
);

const child = spawn(
	"python3",
	[`${import.meta.dir}/.pty-bridge.py`, String(ROWS), String(COLS), BIN, "--model", "@chinese-low"],
	{
		cwd: "/tmp/harness/harness/click-repro",
		env: { ...process.env, TERM: "xterm-256color", HARNESS_COMMAND_REVIEW: "off", HARNESS_OMP_GUARDS: "off" },
		stdio: ["pipe", "pipe", "pipe"],
	},
);
child.stdout.on("data", (data: Buffer) => term.write(data.toString("utf8")));
child.stderr.on("data", (data: Buffer) => term.write(data.toString("utf8")));

function screen(): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

async function waitFor(label: string, match: RegExp, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (screen().some(row => match.test(row))) return;
		await Bun.sleep(500);
	}
	console.log(`!! ${label}: never appeared`);
}

async function waitStable(label: string, timeoutMs: number): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	let previous = screen().join("\n");
	while (Date.now() < deadline) {
		await Bun.sleep(900);
		const current = screen().join("\n");
		if (current === previous) return screen();
		previous = current;
	}
	console.log(`!! ${label}: frame never settled`);
	return screen();
}

function show(label: string, rows: string[]): void {
	console.log(`\n----- ${label} -----`);
	rows.forEach((row, index) => {
		if (row.length > 0) console.log(String(index).padStart(2) + " | " + row.slice(0, 110));
	});
}

/** Press+release of the left button on a 1-based terminal row. */
function click(row: number, column = 3): void {
	child.stdin.write(`\x1b[<0;${column};${row + 1}M`);
	child.stdin.write(`\x1b[<0;${column};${row + 1}m`);
}

/** Motion report with no button held, which is what a hover sends. */
function hover(row: number, column = 3): void {
	child.stdin.write(`\x1b[<35;${column};${row + 1}M`);
}

function summaryCount(rows: string[]): number {
	return rows.filter(row => GROUP_ROW.test(row)).length;
}

await Bun.sleep(6000);
child.stdin.write(`${PROMPT}\r`);

await waitFor("group row", GROUP_ROW, 120_000);

const settled = await waitStable("first turn", 180_000);
const parentRow = settled.findIndex(row => GROUP_ROW.test(row));
console.log(`step 1 parent row: index ${parentRow}; text: ${JSON.stringify(settled[parentRow] ?? "")}`);
console.log(`step 1 summary row count: ${summaryCount(settled)}`);

if (parentRow >= 0) hover(parentRow);
await Bun.sleep(400);
console.log(
	`step 2 hover background-highlighted columns: ${parentRow >= 0 ? term.getViewportRowBackgroundColumns(parentRow).length : 0}`,
);
console.log(`step 2 summary row count: ${summaryCount(screen())}`);

if (parentRow >= 0) click(parentRow);
await Bun.sleep(1200);
const expanded = screen();
const hasCommandArgument = expanded.some(row => CALL_ROW.test(row));
const hasCommandOutput = expanded.some(row => row.includes("toggle-command-one") && !CALL_ROW.test(row));
console.log(`step 3 expansion shows command argument and output: ${hasCommandArgument && hasCommandOutput}`);
console.log(`step 3 total viewport row count: ${expanded.length}`);
console.log(`step 3 summary row count: ${summaryCount(expanded)}`);
show("step 3 expanded group frame", expanded);

const cardRow = expanded.findIndex(row => CALL_ROW.test(row));
const beforeCardClick = expanded.join("\n");
if (cardRow >= 0) click(cardRow);
await Bun.sleep(1200);
const afterCardClick = screen();
console.log(`step 4 card row index: ${cardRow}`);
console.log(`step 4 card row click changed screen: ${afterCardClick.join("\n") !== beforeCardClick}`);
console.log(`step 4 summary row count: ${summaryCount(afterCardClick)}`);

const expandedParentRow = afterCardClick.findIndex(row => GROUP_ROW.test(row));
if (expandedParentRow >= 0) click(expandedParentRow);
await Bun.sleep(1200);
const collapsed = screen();
const restoredSummary = collapsed.some(row => GROUP_ROW.test(row)) && !collapsed.some(row => CALL_ROW.test(row));
console.log(`step 5 second parent click restores collapsed summary: ${restoredSummary}`);
console.log(`step 5 summary row count: ${summaryCount(collapsed)}`);

child.stdin.write(`${PUSH_PROMPT}\r`);
const afterPush = await waitStable("viewport push turn", 180_000);
const visibleSummaryRow = afterPush.findIndex(row => GROUP_ROW.test(row));
console.log(`step 6 visible summary row index after transcript push: ${visibleSummaryRow}`);
if (visibleSummaryRow >= 0) {
	click(visibleSummaryRow);
	await Bun.sleep(1200);
	const afterScrolledClick = screen();
	console.log(`step 6 summary row count after visible-row click: ${summaryCount(afterScrolledClick)}`);
	console.log(`step 6 card text appeared after visible-row click: ${afterScrolledClick.some(row => CALL_ROW.test(row))}`);
} else {
	console.log(`step 6 summary row count after transcript push: ${summaryCount(afterPush)}`);
	console.log("step 6 visible summary row click: skipped because no summary row is visible");
}

child.stdin.write("\x03");
await Bun.sleep(400);
child.kill("SIGTERM");
