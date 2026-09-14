/**
 * Drives the installed omp binary on a real pseudo-terminal and clicks compact
 * rows with raw SGR bytes, reading the screen back through the same VT engine
 * the TUI tests use. In-process harnesses pass while the live binary does
 * nothing, so the only trustworthy check is this one: real terminal, real event
 * loop, real mouse reports.
 *
 * Usage: bun scripts/.pty-click-probe.ts
 */
import { spawn } from "node:child_process";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const COLS = 150;
const ROWS = 45;
const BIN = `${process.env.HOME}/.local/bin/omp`;
const PROMPT =
	"Run exactly these six bash commands, one bash call each, in this order, no other tools: 'sleep 4', 'echo one', 'sleep 4', 'echo two', 'sleep 4', 'echo three'. Then answer with the word done.";
/** The group row while the turn is still running. */
const GROUP_ROW = /shell commands?/;
/** A per-call line of an expanded group names its own command. */
const CALL_ROW = /echo one|echo two|sleep 4/;
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

await Bun.sleep(6000);
child.stdin.write(`${PROMPT}\r`);

// Click while the turn is in flight: the group carries a pending call, which is
// the state on the user's screen (hourglass icon, nothing opens).
let pendingRow = -1;
for (let attempt = 0; attempt < 60; attempt++) {
	await Bun.sleep(700);
	const rows = screen();
	const row = rows.findIndex(line => GROUP_ROW.test(line));
	if (row >= 0 && /⏳|◐|◓|◑|◒|\u231b/.test(rows[row]!)) {
		pendingRow = row;
		break;
	}
	if (row >= 0) pendingRow = row;
}
const live = screen();
show("frame with the running group", live);
console.log(`\npending group row: ${pendingRow}; text: ${JSON.stringify(live[pendingRow] ?? "")}`);

hover(pendingRow);
await Bun.sleep(400);
console.log(`hover background cells on that row: ${term.getViewportRowBackgroundColumns(pendingRow).length}`);

click(pendingRow);
await Bun.sleep(1200);
const afterPending = screen();
const openedWhileRunning = afterPending.some(row => CALL_ROW.test(row) && !GROUP_ROW.test(row));
console.log(`per-call lines visible after clicking the RUNNING group: ${openedWhileRunning}`);
show("after clicking the running group", afterPending);

// Now let the turn finish and click the same group again.
const settled = await waitStable("after the turn", 90000);
const settledRow = settled.findIndex(row => GROUP_ROW.test(row));
console.log(`\nsettled group row: ${settledRow}; text: ${JSON.stringify(settled[settledRow] ?? "")}`);
click(settledRow);
await Bun.sleep(1200);
const afterSettled = screen();
console.log(
	`per-call lines visible after clicking the SETTLED group: ${afterSettled.some(row => CALL_ROW.test(row) && !GROUP_ROW.test(row))}`,
);
show("after clicking the settled group", afterSettled);

child.stdin.write("\x03");
await Bun.sleep(400);
child.kill("SIGTERM");
