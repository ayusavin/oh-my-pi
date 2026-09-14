/**
 * Live check of the compact group's click surface on the real binary over a
 * real pseudo-terminal: hover affordance (band + underline), a click on the
 * group row, a click on one call inside the expanded group, and the summary
 * icon of a run where one call failed among successes (C7, C9, C10).
 *
 * Usage: bun scripts/.pty-scrollback-probe.ts [path-to-omp]   (absolute path)
 */
import { spawn } from "node:child_process";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const COLS = 150;
const ROWS = 40;
const BIN = process.argv[2] ?? `${process.env.HOME}/.local/bin/omp`;
// One call fails (a missing binary), the rest succeed: the summary must not be red.
const PROMPT =
	"Run exactly these three bash commands, one bash call each, in this order, no other tools: 'echo one', 'definitely-not-a-real-binary-xyz', 'echo three'. Then answer with the single word done.";
const GROUP_ROW = /shell commands?/;
const CALL_ROW = /echo (one|three)|definitely-not-a-real-binary/;

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

function show(label: string): void {
	console.log(`\n----- ${label} -----`);
	screen().forEach((row, index) => {
		if (row.length > 0) console.log(String(index).padStart(2) + " | " + row.slice(0, 130));
	});
}

async function settle(label: string, budgetMs = 180_000): Promise<void> {
	// "Working…" is replaced by the per-tool activity line and the frame stays
	// byte-stable between spinner ticks, so settle on the loader marker: the ⎋
	// row exists only while a turn is in flight.
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		await Bun.sleep(1000);
		if (!screen().some(row => /^\s*⎋ /.test(row))) break;
	}
	let previous = screen().join("\n");
	for (let tick = 0; tick < 20; tick++) {
		await Bun.sleep(800);
		const current = screen().join("\n");
		if (current === previous) return;
		previous = current;
	}
	console.log(`!! ${label}: frame never settled`);
}

function click(row: number, column = 3): void {
	child.stdin.write(`\x1b[<0;${column};${row + 1}M`);
	child.stdin.write(`\x1b[<0;${column};${row + 1}m`);
}

function hover(row: number, column = 3): void {
	child.stdin.write(`\x1b[<35;${column};${row + 1}M`);
}

function findRow(pattern: RegExp): number {
	return screen().findIndex(row => pattern.test(row));
}

await Bun.sleep(6000);
child.stdin.write(`${PROMPT}\r`);
await settle("tool turn");
show("settled turn");

const groupRow = findRow(GROUP_ROW);
const summary = screen()[groupRow] ?? "";
console.log(`\ngroup row ${groupRow}: ${JSON.stringify(summary)}`);
console.log(`summary is not red (no ✗ on the collapsed row): ${!summary.includes("✗")}`);

hover(groupRow);
await Bun.sleep(700);
console.log(`hover band cells: ${term.getViewportRowBackgroundColumns(groupRow).length}`);
console.log(`hover underline cells: ${term.getViewportRowUnderlineColumns(groupRow).length}`);

click(groupRow);
await settle("group click", 15000);
const callRows = screen().filter(row => CALL_ROW.test(row) && !GROUP_ROW.test(row));
console.log(`\nper-call rows after clicking the group: ${callRows.length}`);
console.log(`the failed call is marked on its own row: ${callRows.some(row => row.includes("✗"))}`);
show("expanded group");

const firstCall = findRow(/^\s*[▸▾].*Bash\(echo one\)/);
click(firstCall);
await settle("call click", 15000);
const opened = screen();
console.log(`\nclicked call row ${firstCall}: ${JSON.stringify(opened[firstCall] ?? "")}`);
console.log(`row now marked open: ${(opened[firstCall] ?? "").includes("▾")}`);
console.log(`card shows the command and its output: ${opened.some(row => /\bone\b/.test(row) && !/Bash\(/.test(row))}`);
show("opened call card");

child.stdin.write("\x03");
await Bun.sleep(400);
child.kill("SIGTERM");
