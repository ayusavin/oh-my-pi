/**
 * Live proof for compact tool rows restored from a completed session. The row
 * starts above the mutable viewport in native history; hover must repaint that
 * physical row and click must raise its expanded group at the live bottom.
 *
 * Usage: bun scripts/.pty-resume-history-probe.ts <absolute-omp> <session-jsonl>
 */
import { spawn } from "node:child_process";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const COLS = 150;
const ROWS = 60;
const BIN = process.argv[2];
const SESSION = process.argv[3];
if (!BIN || !SESSION || !BIN.startsWith("/") || !SESSION.startsWith("/")) {
	throw new Error("absolute omp and session paths are required");
}

const term = new VirtualTerminal(COLS, ROWS);
term.start(
	() => {},
	() => {},
);
let raw = "";
const child = spawn(
	"python3",
	[`${import.meta.dir}/.pty-bridge.py`, String(ROWS), String(COLS), BIN, `--resume=${SESSION}`],
	{
		cwd: "/tmp/harness/harness/click-repro",
		env: { ...process.env, TERM: "xterm-256color", HARNESS_COMMAND_REVIEW: "off", HARNESS_OMP_GUARDS: "off" },
		stdio: ["pipe", "pipe", "pipe"],
	},
);
for (const stream of [child.stdout, child.stderr]) {
	stream.on("data", (data: Buffer) => {
		const text = data.toString("utf8");
		raw += text;
		term.write(text);
	});
}

const screen = (): string[] => term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
const groupRow = (): number => screen().findIndex(row => /3 shell commands/.test(row));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(150);
	}
	throw new Error(`timeout waiting for ${label}\n${screen().filter(Boolean).join("\n")}`);
}

await waitFor(() => groupRow() >= 0 && screen().some(row => row.startsWith("╰─")), "resumed transcript");
// The splash/startup handoff arms inline reporting after the first composer input.
child.stdin.write("x\x7f");
await waitFor(() => raw.includes("\x1b[?1003h"), "inline mouse capture");
// Change the component's current presentation after its immutable row was
// emitted. The click must still mean what the visible collapsed row says.
child.stdin.write("\x0f");
await Bun.sleep(500);

const row = groupRow();
child.stdin.write(`\x1b[<35;3;${row + 1}M`);
await waitFor(
	() =>
		term.getViewportRowUnderlineColumns(row).length === COLS &&
		term.getViewportRowBackgroundColumns(row).length === COLS,
	"history hover band",
);
const hoveredText = screen()[row];
const hoverUnderlineCells = term.getViewportRowUnderlineColumns(row).length;
const hoverBandCells = term.getViewportRowBackgroundColumns(row).length;

child.stdin.write(`\x1b[<0;3;${row + 1}M\x1b[<0;3;${row + 1}m`);
await waitFor(() => screen().filter(line => /^\s*[▸▾].*Bash\(/.test(line)).length >= 3, "raised expanded group");
const firstCallRows = screen().filter(line => /^\s*[▸▾].*Bash\(/.test(line));
const checks: [string, boolean][] = [
	["restored group is visible", /3 shell commands/.test(hoveredText ?? "")],
	["history hover underlines the full row", hoverUnderlineCells === COLS],
	["history hover paints the full band", hoverBandCells === COLS],
	["history click follows emitted state after ctrl+o", firstCallRows.length >= 3],
	["raised copy contains the original first call", firstCallRows.some(line => line.includes("echo one"))],
];
let failed = false;
for (const [label, ok] of checks) {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failed = true;
}

child.stdin.write("\x03");
await Bun.sleep(300);
child.kill("SIGKILL");
process.exit(failed ? 1 : 0);
