import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "../../src/modes/composer";
import { TranscriptContainer } from "../../src/modes/components/transcript-container";
import { initTheme } from "../../src/modes/theme/theme";
import { Container, type Component } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { routeViewportClick, routeViewportClickAction, type ViewportClickSpan } from "../../src/modes/composer";
import {
	type CompactToolGroupHolder,
	mountCompactToolCall,
} from "../../src/modes/components/tool-call-compact";

function span(start: number, end: number, ids: string[]): ViewportClickSpan {
	return { start, end, candidates: () => ids };
}

describe("routeViewportClick", () => {
	it("returns the hit span's candidates with the span-local row", () => {
		let local = -1;
		const spans: ViewportClickSpan[] = [
			{
				start: 0,
				end: 2,
				candidates: row => {
					local = row;
					return ["CardAgent"];
				},
			},
			{ start: 3, end: 5, candidates: () => ["HudAgent"] },
		];
		expect(routeViewportClick(spans, 1)).toEqual(["CardAgent"]);
		expect(local).toBe(1);
		expect(routeViewportClick(spans, 4)).toEqual(["HudAgent"]);
	});

	it("misses separators, out-of-range rows, and non-integer indexes", () => {
		const spans = [span(0, 2, ["A"]), span(3, 4, ["B"])];
		expect(routeViewportClick(spans, 2)).toEqual([]);
		expect(routeViewportClick(spans, -1)).toEqual([]);
		expect(routeViewportClick(spans, Number.NaN)).toEqual([]);
		expect(routeViewportClick(spans, 99)).toEqual([]);
	});

	it("lets the first overlapping span win", () => {
		const spans = [span(0, 5, ["A"]), span(2, 4, ["B"])];
		expect(routeViewportClick(spans, 3)).toEqual(["A"]);
	});
});

describe("routeViewportClickAction", () => {
	it("returns the hit span's action, mirroring routeViewportClick's span lookup", () => {
		let hitLocal = -1;
		const spans: ViewportClickSpan[] = [
			{
				start: 0,
				end: 2,
				candidates: () => [],
				action: local => {
					hitLocal = local;
				},
			},
			{ start: 3, end: 5, candidates: () => ["B"] },
		];
		expect(routeViewportClickAction(spans, 1)).toBe(spans[0]!.action);
		spans[0]!.action!(1);
		expect(hitLocal).toBe(1);
		// A span without an action yields undefined, not the next span's.
		expect(routeViewportClickAction(spans, 4)).toBeUndefined();
	});

	it("misses separators, out-of-range rows, and non-integer indexes", () => {
		const action = (local: number) => void local;
		const spans: ViewportClickSpan[] = [
			{ start: 0, end: 2, candidates: () => [], action },
			{ start: 3, end: 4, candidates: () => [] },
		];
		expect(routeViewportClickAction(spans, 2)).toBeUndefined();
		expect(routeViewportClickAction(spans, -1)).toBeUndefined();
		expect(routeViewportClickAction(spans, Number.NaN)).toBeUndefined();
		expect(routeViewportClickAction(spans, 99)).toBeUndefined();
	});
});

class ClickableBlock implements Component {
	constructor(
		private readonly rows: readonly string[],
		private readonly ids: readonly string[],
	) {}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	render(): readonly string[] {
		return this.rows;
	}
	getClickFocusAgentIds(): string[] {
		return [...this.ids];
	}
}

describe("composer hover band", () => {
	beforeAll(() => {
		initTheme();
	});

	it("bands only the hovered target's rows and clears byte-identically", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(new ClickableBlock(["card one", "card two"], ["AgentA"]));
			transcript.addChild(new ClickableBlock(["plain"], []));
			composer.setRuntimeChildren([transcript]);
			const plain = composer.renderFrame({ columns: 80, rows: 24 });
			expect(plain.viewport.join("\n")).not.toContain("\x1b[48");

			composer.setHoveredClickId("AgentA");
			const hovered = composer.renderFrame({ columns: 80, rows: 24 });
			const banded = hovered.viewport.filter(line => line.includes("\x1b[48"));
			expect(banded).toHaveLength(2);
			expect(Bun.stripANSI(banded.join("\n"))).toContain("card one");
			expect(Bun.stripANSI(banded.join("\n"))).toContain("card two");
			expect(hovered.viewport.filter(line => line.includes("plain") && line.includes("\x1b[48"))).toHaveLength(0);

			composer.setHoveredClickId("Nobody");
			expect(composer.renderFrame({ columns: 80, rows: 24 }).viewport).toEqual(plain.viewport);

			composer.setHoveredClickId(undefined);
			expect(composer.renderFrame({ columns: 80, rows: 24 }).viewport).toEqual(plain.viewport);
		} finally {
			composer.stop();
		}
	});

	it("drops nested background opens so the band wins tinted rows", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const esc = String.fromCharCode(27);
			const tinted = `${esc}[48;2;15;18;22mcard tinted${esc}[49m`;
			const transcript = new TranscriptContainer();
			transcript.addChild(new ClickableBlock([tinted], ["AgentT"]));
			composer.setRuntimeChildren([transcript]);
			composer.setHoveredClickId("AgentT");
			const hovered = composer.renderFrame({ columns: 80, rows: 24 });
			const banded = hovered.viewport.filter(line => line.includes("card tinted"));
			expect(banded).toHaveLength(1);
			expect(banded[0]).toContain(`${esc}[48`);
			expect(banded[0]).not.toContain("48;2;15;18;22");
		} finally {
			composer.stop();
		}
	});
});
class RowTarget implements Component {
	constructor(
		private readonly rows: readonly string[],
		private readonly ids: readonly string[],
	) {}
	render(): readonly string[] {
		return this.rows;
	}
	getClickAgentAtRow(row: number): string | undefined {
		return this.ids[row];
	}
}

describe("composer click-span clipping", () => {
	beforeAll(() => {
		initTheme();
	});

	it("offsets hit-testing past clipped viewport rows", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			const ids = Array.from({ length: 10 }, (_, index) => `row${index}`);
			chrome.addChild(
				new RowTarget(
					ids.map(id => `line ${id}`),
					ids,
				),
			);
			composer.setRuntimeChildren([transcript, chrome]);

			// Ten chrome rows in a six-row viewport: the first four scroll off,
			// so viewport row 0 must hit-test as component row 4.
			const frame = composer.renderFrame({ columns: 80, rows: 6 });
			expect(frame.viewport).toHaveLength(6);
			expect(composer.viewportClickCandidates(0)).toEqual(["row4"]);
			expect(composer.viewportClickCandidates(5)).toEqual(["row9"]);
		} finally {
			composer.stop();
		}
	});
});

class CountingBlock implements Component {
	renders = 0;
	constructor(private readonly rows: readonly string[]) {}
	render(): readonly string[] {
		this.renders++;
		return this.rows;
	}
}

describe("composer chrome span recording", () => {
	beforeAll(() => {
		initTheme();
	});

	it("does not re-render chrome without click targets", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			const first = new CountingBlock(["status one"]);
			const second = new CountingBlock(["status two"]);
			chrome.addChild(first);
			chrome.addChild(second);
			composer.setRuntimeChildren([transcript, chrome]);

			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			expect(frame.viewport.join("\n")).toContain("status two");
			expect([first.renders, second.renders]).toEqual([1, 1]);
			expect(composer.viewportClickCandidates(0)).toEqual([]);
		} finally {
			composer.stop();
		}
	});

	it("renders target-bearing chrome children once per frame", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			const first = new CountingBlock(["status one"]);
			const hud = new RowTarget(["hud row"], ["AgentH"]);
			chrome.addChild(first);
			chrome.addChild(hud);
			composer.setRuntimeChildren([transcript, chrome]);

			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const hudRow = frame.viewport.findIndex(line => line.includes("hud row"));
			expect(hudRow).toBeGreaterThanOrEqual(0);
			expect(composer.viewportClickCandidates(hudRow)).toEqual(["AgentH"]);
			expect(first.renders).toBe(1);
		} finally {
			composer.stop();
		}
	});
});

describe("composer click-to-toggle through a real renderFrame", () => {
	beforeAll(() => {
		initTheme();
	});

	// Regression: `renderFrame`'s `shift()` used to rebuild every clipped/
	// repositioned span without copying its `action` — every click-to-toggle
	// row (a compact tool group, a settled single-call row) silently lost its
	// action once `renderFrame` ran, even though `getViewportClickAction()`
	// itself was correct. `viewportClickAction` only ever reads `#lastClickSpans`,
	// which `renderFrame` always rebuilds through `shift()` — so this exercises
	// the real production `renderFrame` pass, not a hand-built span.
	it("a rendered CompactToolCallComponent group's click action survives renderFrame's clipping and toggles the row", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const holder: CompactToolGroupHolder = { current: undefined };
			mountCompactToolCall(transcript, holder, "grouped", false, "call-1", "bash", { command: "echo one" }, undefined);
			mountCompactToolCall(transcript, holder, "grouped", false, "call-2", "bash", { command: "echo two" }, undefined);
			composer.setRuntimeChildren([transcript]);

			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const groupRow = frame.viewport.findIndex(line => line.includes("shell command"));
			expect(groupRow).toBeGreaterThanOrEqual(0);
			expect(Bun.stripANSI(frame.viewport[groupRow]!)).toContain("2 shell commands");

			const action = composer.viewportClickAction(groupRow);
			expect(action).toBeDefined();
			action!(groupRow);

			const expanded = Bun.stripANSI(composer.renderFrame({ columns: 80, rows: 24 }).viewport.join("\n"));
			expect(expanded).toContain("echo one");
			expect(expanded).toContain("echo two");

			// A second click collapses it back (C7).
			composer.viewportClickAction(groupRow)!(groupRow);
			const collapsed = Bun.stripANSI(composer.renderFrame({ columns: 80, rows: 24 }).viewport.join("\n"));
			expect(collapsed).toContain("2 shell commands");
			expect(collapsed).not.toContain("echo one");
		} finally {
			composer.stop();
		}
	});

	// Regression: a compact group's own row-to-entry mapping must stay
	// correct when the group's rendered span does not start at viewport row
	// 0 — `routeViewportClickAction`'s span-local offset composes with the
	// group's own per-row dispatch (`CompactToolCallComponent`'s row target
	// resolution), so a click well below the group's first row still opens
	// the entry that row actually belongs to.
	it("opens the correct subordinate call when the group's span does not start at viewport row 0", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const holder: CompactToolGroupHolder = { current: undefined };
			mountCompactToolCall(transcript, holder, "grouped", false, "call-1", "bash", { command: "echo one" }, undefined);
			mountCompactToolCall(transcript, holder, "grouped", false, "call-2", "bash", { command: "echo two" }, undefined);
			const group = holder.current!;
			group.updateResult({ content: [{ type: "text", text: "out one" }], isError: false }, false, "call-1");
			group.updateResult({ content: [{ type: "text", text: "out two" }], isError: false }, false, "call-2");
			// Padding rows ahead of the transcript push the group's own span off viewport row 0.
			composer.setRuntimeChildren([new CountingBlock(["padding a", "padding b", "padding c"]), transcript]);

			let frame = composer.renderFrame({ columns: 80, rows: 24 });
			const groupRow = frame.viewport.findIndex(line => line.includes("shell command"));
			expect(groupRow).toBeGreaterThan(0);
			composer.viewportClickAction(groupRow)!(groupRow); // expand the group

			frame = composer.renderFrame({ columns: 80, rows: 24 });
			const call2Row = frame.viewport.findIndex(line => Bun.stripANSI(line).includes("echo two"));
			expect(call2Row).toBeGreaterThan(groupRow);
			composer.viewportClickAction(call2Row)!(call2Row); // click call-2's own dimmed line

			const opened = Bun.stripANSI(composer.renderFrame({ columns: 80, rows: 24 }).viewport.join("\n"));
			expect(opened).toContain("out two");
			expect(opened).not.toContain("out one");
		} finally {
			composer.stop();
		}
	});
});
