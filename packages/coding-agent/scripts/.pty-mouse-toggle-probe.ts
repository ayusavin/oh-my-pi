/**
 * Proves `app.mouse.toggle` on the real binary: mouse reporting is a terminal
 * mode, so the only trustworthy evidence is the escape sequences omp writes to
 * the pty. Sniffs raw stdout for DECSET/DECRST of 1000/1003 around two presses
 * of the toggle key, and reads the status notice back through the VT engine.
 *
 * Usage: bun scripts/.pty-mouse-toggle-probe.ts [path-to-omp]
 */
import { spawn } from "node:child_process";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const COLS = 150;
const ROWS = 40;
const BIN = process.argv[2] ?? `${import.meta.dir}/../dist/omp`;
/** alt+s as terminals deliver it: ESC prefix + the plain key. */
const ALT_S = "\x1bs";
const term = new VirtualTerminal(COLS, ROWS);
term.start(
	() => {},
	() => {},
);

let raw = "";
const child = spawn("python3", [`${import.meta.dir}/.pty-bridge.py`, String(ROWS), String(COLS), BIN], {
	cwd: "/tmp/harness/harness/click-repro",
	env: { ...process.env, TERM: "xterm-256color", HARNESS_COMMAND_REVIEW: "off", HARNESS_OMP_GUARDS: "off" },
	stdio: ["pipe", "pipe", "pipe"],
});
for (const stream of [child.stdout, child.stderr]) {
	stream.on("data", (data: Buffer) => {
		const text = data.toString("utf8");
		raw += text;
		term.write(text);
	});
}

function screen(): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

async function waitLoaded(timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await Bun.sleep(600);
		if (screen().some(row => row.startsWith("╰─"))) return;
	}
	console.log(screen().filter(row => row.length > 0).join("\n"));
	throw new Error("omp never reached the idle prompt");
}

/** Mouse-mode transitions seen since `from`, in order, e.g. ["1003h", "1003l"]. */
function modeEvents(from: number): string[] {
	return [...raw.slice(from).matchAll(/\x1b\[\?(1000|1003)([hl])/g)].map(match => match[1] + match[2]);
}

/**
 * Waits for a notice in the pty byte stream rather than the rendered frame:
 * dropping mouse reporting triggers a full repaint that can retire the notice
 * row into scrollback before the next snapshot.
 */
async function awaitNotice(from: number, expected: string, windowMs: number): Promise<boolean> {
	const deadline = Date.now() + windowMs;
	while (Date.now() < deadline) {
		if (raw.slice(from).includes(expected)) return true;
		await Bun.sleep(150);
	}
	return false;
}

await waitLoaded(60_000);
// The splash screen holds the mouse off; capture is armed by the first key the
// composer sees, so type and erase one character before measuring.
child.stdin.write("x\x7f");
for (let waited = 0; waited < 20_000 && !modeEvents(0).includes("1003h"); waited += 500) await Bun.sleep(500);
const armed = modeEvents(0);
const afterStart = raw.length;
console.log("startup modes:", armed.join(" ") || "(none)");

child.stdin.write(ALT_S);
const offNotice = await awaitNotice(afterStart, "Mouse capture: off", 4000);
const offModes = modeEvents(afterStart);
const afterOff = raw.length;

child.stdin.write(ALT_S);
const onNotice = await awaitNotice(afterOff, "Mouse capture: on", 4000);
await Bun.sleep(800);
const onModes = modeEvents(afterOff);

console.log("after 1st alt+s:", offModes.join(" ") || "(none)", "| off notice:", offNotice);
console.log("after 2nd alt+s:", onModes.join(" ") || "(none)", "| on notice:", onNotice);

const checks: [string, boolean][] = [
	["capture armed before the toggle", armed.includes("1003h") && armed.includes("1000h")],
	["1st press disables reporting", offModes.includes("1003l") && offModes.includes("1000l")],
	["1st press reports capture off", offNotice],
	["2nd press re-enables reporting", onModes.includes("1003h") && onModes.includes("1000h")],
	["2nd press reports capture on", onNotice],
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
