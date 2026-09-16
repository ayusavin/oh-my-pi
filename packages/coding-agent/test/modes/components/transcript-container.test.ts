import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import {
	TranscriptContainer,
	type TranscriptStableRow,
} from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Container, type Component } from "@oh-my-pi/pi-tui";

class Block implements Component {
	#rows: string[];
	#finalized: boolean;
	allocations: number[] = [];

	constructor(rows: string[], finalized: boolean) {
		this.#rows = rows;
		this.#finalized = finalized;
	}

	finalize(rows: string[]): void {
		this.#rows = rows;
		this.#finalized = true;
	}

	reopen(rows: string[]): void {
		this.#rows = rows;
		this.#finalized = false;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	setTranscriptAllocation(rows: number): void {
		this.allocations.push(rows);
	}

	render(): readonly string[] {
		return this.#rows;
	}
}

class AppendGroupWrapper extends Container {
	readonly transcriptBlockMode = "appendOnly" as const;

	constructor(private readonly stableRows: readonly string[]) {
		super();
	}

	isTranscriptBlockFinalized(): boolean {
		return false;
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return this.stableRows.map(literalStableRow);
	}

	renderTranscriptStableRows(count: number, _width: number): readonly string[] {
		return this.stableRows.slice(0, count);
	}
}

/** A live block the container recognizes as dynamic tool-activity. */
class ToolBlock extends Block {
	setToolActivityVisible(): void {}
}

class EmergencyBlock extends Block {
	#allocation = Number.MAX_SAFE_INTEGER;
	emergencyRenderAllocations: number[] = [];

	constructor(
		rows: string[],
		private readonly emergencyRow: string,
	) {
		super(rows, true);
	}

	override setTranscriptAllocation(rows: number): void {
		super.setTranscriptAllocation(rows);
		this.#allocation = rows;
	}

	renderTranscriptBlockEmergencyRow(_width: number): string {
		this.emergencyRenderAllocations.push(this.#allocation);
		return this.emergencyRow;
	}
}

function literalStableRow(row: string): TranscriptStableRow {
	return { key: row };
}

class AppendBlock extends Block {
	readonly transcriptBlockMode = "appendOnly" as const;
	#stable: readonly TranscriptStableRow[];
	#stableRender: readonly string[];

	constructor(rows: string[], stable: readonly string[], finalized = false) {
		super(rows, finalized);
		this.#stable = stable.map(literalStableRow);
		this.#stableRender = stable;
	}

	publish(rows: readonly string[]): void {
		this.#stable = rows.map(literalStableRow);
		this.#stableRender = rows;
	}

	publishStable(rows: readonly TranscriptStableRow[], rendered: readonly string[]): void {
		this.#stable = rows;
		this.#stableRender = rendered;
	}

	/** Change the block's full render without finalizing (e.g. hiding thinking). */
	revise(rows: string[]): void {
		this.finalize(rows);
	}

	resetTranscriptStableRows(): void {
		this.#stable = [];
		this.#stableRender = [];
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return this.#stable;
	}

	renderTranscriptStableRows(count: number, _width: number): readonly string[] {
		return this.#stableRender.slice(0, count);
	}
}

class ReflowingAppendBlock implements Component {
	readonly transcriptBlockMode = "appendOnly" as const;
	#finalized = false;
	readonly #stable: TranscriptStableRow = { key: "abcdefgh" };

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	finalize(): void {
		this.#finalized = true;
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return [this.#stable];
	}

	renderTranscriptStableRows(count: number, width: number): readonly string[] {
		if (count <= 0) return [];
		const rows: string[] = [];
		for (let offset = 0; offset < 8; offset += width) rows.push("abcdefgh".slice(offset, offset + width));
		return rows;
	}

	render(width: number): readonly string[] {
		return [...this.renderTranscriptStableRows(1, width), this.#finalized ? "final" : "partial"];
	}
}
const finalAnswer: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "Reasoning first" },
		{ type: "text", text: "## Implemented" },
	],
	api: "openai-codex-responses",
	provider: "openai-codex",
	model: "gpt-5.6-sol",
	stopReason: "stop",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 1,
};

const frame = { tick: 0, now: 0 };

describe("TranscriptContainer", () => {
	it("preserves retirement while externally reordered and replaced live children settle", () => {
		const transcript = new TranscriptContainer();
		const archived = new Block(["archived"], true);
		transcript.addChild(archived);
		const history = transcript.peekFlushBatch(80);
		if (!history) throw new Error("Expected history batch");
		transcript.acknowledgeFinalizedBatch(history.id);
		const first = new Block(["first"], false);
		const second = new Block(["second"], false);
		transcript.addChild(first);
		transcript.addChild(second);
		transcript.children.splice(1, 2, second, first);
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["second", "", "first"]);
		const replacement = new Block(["replacement"], false);
		const external = [archived, second, replacement];
		transcript.children = external;
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["second", "", "replacement"]);
		external[1] = first;
		first.finalize(["first done"]);
		replacement.finalize(["replacement done"]);
		const final = transcript.peekFlushBatch(80);
		expect(final?.rows).toEqual(["first done", "", "replacement done", ""]);
		if (!final) throw new Error("Expected live retirement batch");
		transcript.acknowledgeFinalizedBatch(final.id);
		expect(transcript.peekFlushBatch(80)).toBeUndefined();
		transcript.beginReplay();
		expect(transcript.peekReplayBatch(80)?.rows).toEqual(["archived", "", "first done", "", "replacement done", ""]);
	});

	it("captures mutable by default and append-only declarations permanently", () => {
		const transcript = new TranscriptContainer();
		const mutable = new Block(["mutable"], false) as Block & {
			transcriptBlockMode?: "appendOnly";
			getTranscriptStableRows?: () => readonly TranscriptStableRow[];
		};
		transcript.addChild(mutable);
		mutable.transcriptBlockMode = "appendOnly";
		mutable.getTranscriptStableRows = () => [literalStableRow("mutable")];
		transcript.addChild(new AppendBlock(["stable", "partial"], ["stable"]));

		expect(transcript.blockModes()).toEqual(["mutable", "appendOnly"]);
	});

	it("freezes a retracting publication and keeps rendering the block", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two"], ["one"]);
		transcript.addChild(block);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);

		// Retraction cannot be honored (rows may already sit in scrollback):
		// the block demotes to finalize-time retirement but never fails a render.
		block.publish(["changed"]);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);
		expect(transcript.blockModes()).toEqual(["appendOnly"]);
	});

	it("freezes drifted stable bytes, keeps the emitted slice, and retires the remainder once", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two"], ["one"]);
		transcript.addChild(block);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);

		const emitted = transcript.peekFinalizedBatch(80, 0)!;
		expect(emitted.rows).toEqual(["one"]);
		transcript.acknowledgeFinalizedBatch(emitted.id);

		// Published bytes drift (e.g. a mid-stream theme change): the emitted
		// slice stays retired, the live tail keeps rendering, and no further
		// mid-stream row is offered.
		block.publishStable([literalStableRow("one"), literalStableRow("two")], ["one", "changed physical row"]);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["two"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();

		// Finalization retires exactly the un-emitted suffix.
		block.finalize(["one", "two"]);
		expect(transcript.peekFinalizedBatch(80, 0)?.rows).toEqual(["two", ""]);
	});

	it("separates the next block from rows the previous block already streamed out", () => {
		const transcript = new TranscriptContainer();
		const streamed = new AppendBlock(["one", "two"], ["one", "two"]);
		transcript.addChild(streamed);

		// The whole block leaves through mid-stream emission under pressure —
		// batched as large as the overflow needs, not one row per cycle — so the
		// commit that later retires it contributes nothing further.
		const drained: string[] = [];
		for (;;) {
			const emitted = transcript.peekFinalizedBatch(80, 0);
			if (!emitted) break;
			drained.push(...emitted.rows);
			transcript.acknowledgeFinalizedBatch(emitted.id);
		}
		expect(drained).toEqual(["one", "two"]);

		streamed.finalize(["one", "two"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();

		const next = new Block(["next block"], true);
		transcript.addChild(next);
		// Without a leading blank the new block would touch the streamed rows
		// already printed into native scrollback.
		expect(transcript.peekFinalizedBatch(80, 0)?.rows).toEqual(["", "next block", ""]);
	});

	it("emits only the stable current head under row pressure", () => {
		const transcript = new TranscriptContainer();
		const head = new Block(["mutable head"], false);
		const later = new AppendBlock(["later stable", "later partial"], ["later stable"]);
		transcript.addChild(head);
		transcript.addChild(later);

		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();

		head.finalize(["mutable head"]);
		const retired = transcript.peekFinalizedBatch(80, 1);
		expect(retired?.rows).toEqual(["mutable head", ""]);
		transcript.acknowledgeFinalizedBatch(retired!.id);

		const emitted = transcript.peekFinalizedBatch(80, 1);
		expect(emitted?.rows).toEqual(["later stable"]);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["later partial"]);
	});

	it("retires only the un-emitted final suffix", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two", "partial"], ["one", "two"]);
		transcript.addChild(block);

		const first = transcript.peekFinalizedBatch(80, 2)!;
		expect(first.rows).toEqual(["one"]);
		transcript.acknowledgeFinalizedBatch(first.id);
		const second = transcript.peekFinalizedBatch(80, 1)!;
		expect(second.rows).toEqual(["two"]);
		transcript.acknowledgeFinalizedBatch(second.id);

		block.finalize(["one", "two", "final"]);
		const suffix = transcript.peekFinalizedBatch(80, 0)!;
		expect(suffix.rows).toEqual(["final", ""]);
	});

	it("advances a fully emitted finalized head without a physical write", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["complete"], ["complete"]);
		transcript.addChild(block);
		const emitted = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(emitted.id);

		block.finalize(["complete"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
		expect(transcript.blockStates()).toEqual(["committed"]);
	});

	it("replays and retires semantic stable rows after they reflow at a new width", () => {
		const transcript = new TranscriptContainer();
		const block = new ReflowingAppendBlock();
		transcript.addChild(block);

		const emitted = transcript.peekFinalizedBatch(4, 2)!;
		expect(emitted.rows).toEqual(["abcd", "efgh"]);
		transcript.acknowledgeFinalizedBatch(emitted.id);
		expect(transcript.renderViewport(8, 1, frame)).toEqual(["partial"]);

		transcript.beginReplay();
		const replay = transcript.peekReplayBatch(8)!;
		expect(replay.rows).toEqual(["abcdefgh"]);
		transcript.acknowledgeFinalizedBatch(replay.id);

		block.finalize();
		const suffix = transcript.peekFinalizedBatch(8, 0)!;
		expect(suffix.rows).toEqual(["final", ""]);
	});

	it("drops emitted stable rows on reset so a replay honors a hidden presentation (#10177)", () => {
		const transcript = new TranscriptContainer();
		// A thinking block whose reasoning prefix streams into scrollback ahead of
		// its answer while the whole block is still the live frontier head.
		const block = new AppendBlock(["reasoning one", "reasoning two", "answer"], ["reasoning one", "reasoning two"]);
		transcript.addChild(block);

		// Under pressure the finished rows the overflow needs retire in one batch.
		const first = transcript.peekFinalizedBatch(80, 1)!;
		expect(first.rows).toEqual(["reasoning one", "reasoning two"]);
		transcript.acknowledgeFinalizedBatch(first.id);
		expect(transcript.emittedStableRows()).toEqual([2]);

		// Ctrl+T hides thinking: the block now renders only its answer and drops
		// its published reasoning snapshots. resetStableEmission forgets the
		// emitted prefix so the paired destructive replay does not resurrect the
		// captured reasoning that visibly streamed into scrollback.
		block.revise(["answer"]);
		transcript.resetStableEmission();
		expect(transcript.emittedStableRows()).toEqual([0]);

		transcript.beginReplay();
		expect(transcript.peekReplayBatch(80)).toBeUndefined();
		expect(transcript.renderViewport(80, 5, frame)).toEqual(["answer"]);
	});

	beforeAll(async () => {
		await initTheme(false);
	});

	it("keeps settled blocks live while the viewport has room", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled"], true));
		transcript.addChild(new Block(["streaming"], false));

		// Both fit: nothing retires, the settled block still renders live.
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["settled", "", "streaming"]);
	});

	it("retires the settled prefix only under capacity pressure, in order", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["first final"], true);
		const second = new Block(["second live", "row", "row"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		// 5 rows fit everything (1 + separator + 3).
		expect(transcript.peekFinalizedBatch(80, 5)).toBeUndefined();
		// 3 rows force the settled prefix out.
		expect(transcript.peekFinalizedBatch(80, 3)?.rows).toEqual(["first final", ""]);
	});

	it("never retires a finalized successor past an active predecessor", () => {
		const transcript = new TranscriptContainer();
		const active = new Block(["active live"], false);
		const settled = new Block(["settled final"], true);
		transcript.addChild(active);
		transcript.addChild(settled);

		// Pressure exists but the prefix starts with an active block: no batch,
		// and both blocks still render (clipped by the viewport).
		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["active live", "", "settled final"]);

		active.finalize(["active final"]);
		// Capacity 1 fits the remaining settled block, so only the first retires.
		expect(transcript.peekFinalizedBatch(80, 1)?.rows).toEqual(["active final", ""]);
	});

	it("reoffers an unacknowledged batch and retires it exactly once", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final one"], true));
		transcript.addChild(new Block(["final two"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		const second = transcript.peekFinalizedBatch(80, 50);

		expect(second).toEqual(first);
		if (first === undefined) throw new Error("expected a batch under zero capacity");
		transcript.acknowledgeFinalizedBatch(first.id);
		// Committed blocks leave the live tail and never render again.
		expect(transcript.renderViewport(80, 10, frame)).toEqual([]);
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
	});

	it("excludes an offered batch from the live viewport in the same frame", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["old settled"], true));
		transcript.addChild(new Block(["fresh live"], false));

		const batch = transcript.peekFinalizedBatch(80, 1);
		expect(batch?.rows).toEqual(["old settled", ""]);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["fresh live"]);
	});

	it("keeps a newest row and count-bearing backlog at capacities one and two", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["first"], false));
		transcript.addChild(new Block(["newest one", "newest two"], false));

		expect(transcript.renderViewport(80, 1, frame)).toEqual(["newest two"]);
		expect(transcript.canAdmit(2)).toBe(false);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["1 more transcript blocks", "newest two"]);
	});

	it("keeps the newest current row at capacity one despite settled entries", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled one"], true));
		transcript.addChild(new Block(["settled two"], true));
		transcript.addChild(new Block(["current tool"], false));

		// The welcome header can consume the first history offer, leaving the
		// settled transcript prefix live for one frame while it drains next.
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["current tool"]);
	});

	it("sets zero allocation on every uncommitted block at zero capacity", () => {
		const transcript = new TranscriptContainer();
		const settled = new Block(["settled"], true);
		const active = new Block(["active"], false);
		transcript.addChild(settled);
		transcript.addChild(active);

		expect(transcript.renderViewport(80, 0, frame)).toEqual([]);
		expect(settled.allocations).toEqual([0]);
		expect(active.allocations).toEqual([0]);
	});

	it("keeps the newest row when a hidden emergency candidate has one visible slot", () => {
		for (const capacity of [2, 3, 4]) {
			const transcript = new TranscriptContainer();
			const emergency = new EmergencyBlock(["settled detail"], "settled summary");
			const middle = new Block(["middle"], false);
			const newest = new Block(["newest"], false);
			transcript.addChild(emergency);
			transcript.addChild(middle);
			transcript.addChild(newest);

			const rows = transcript.renderViewport(80, capacity, frame);
			expect(rows).toEqual(
				capacity === 2 ? ["2 more transcript blocks", "newest"] : ["2 more transcript blocks", "", "newest"],
			);
			expect(rows.length).toBeLessThanOrEqual(capacity);
			expect(transcript.getLastViewportSpans()).toEqual([
				{ component: newest, start: capacity === 2 ? 1 : 2, end: capacity === 2 ? 2 : 3, offset: 0 },
			]);
			expect(emergency.emergencyRenderAllocations).toEqual([]);
			expect(emergency.allocations.at(-1)).toBe(0);
			expect(middle.allocations.at(-1)).toBe(0);
			expect(newest.allocations.at(-1)).toBe(1);
		}
	});

	it("counts hidden settled and active blocks in the backlog", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled"], true));
		transcript.addChild(new Block(["active"], false));
		transcript.addChild(new Block(["current one", "current two"], false));

		expect(transcript.renderViewport(80, 3, frame)).toEqual(["2 more transcript blocks", "", "current two"]);
	});

	it("ignores empty blocks while preserving boundaries under pressure (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		// Text blocks interleaved with empty (hidden tool-activity) blocks that
		// render nothing but stay live until retired.
		for (let i = 0; i < 6; i++) {
			transcript.addChild(new Block([`t${i}a`, `t${i}b`, `t${i}c`], true));
			for (let j = 0; j < 8; j++) transcript.addChild(new Block([], true));
		}
		expect(transcript.renderViewport(80, 12, frame)).toEqual([
			"t0c",
			"",
			"t1c",
			"",
			"t2c",
			"",
			"t3c",
			"",
			"t4c",
			"",
			"t5b",
			"t5c",
		]);
	});

	it("does not reserve empty blocks while allocating separated text (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["A1", "A2", "A3", "A4"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new Block(["B1", "B2", "B3", "B4"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new Block(["C1", "C2", "C3", "C4"], true));
		expect(transcript.renderViewport(80, 10, frame)).toEqual([
			"A4",
			"",
			"B2",
			"B3",
			"B4",
			"",
			"C1",
			"C2",
			"C3",
			"C4",
		]);
	});

	it("keeps a completed assistant answer represented under backlog pressure", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["stale active"], false));
		transcript.addChild(new AssistantMessageComponent(finalAnswer));
		transcript.addChild(new Block(["continued turn"], false));
		transcript.addChild(new Block(["task running"], false));

		expect(transcript.peekFinalizedBatch(80, 3)).toBeUndefined();
		const rows = transcript.renderViewport(80, 5, frame);
		expect(rows[0]).toBe("2 more transcript blocks");
		expect(rows[1]).toBe("");
		expect(Bun.stripANSI(rows[2] ?? "").trim()).toBe("Implemented");
		expect(rows[3]).toBe("");
		expect(rows[4]).toBe("task running");
	});

	it("keeps blank boundaries in ordinary multiline overflow", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["A1", "A2", "A3"], false));
		transcript.addChild(new Block(["B1", "B2", "B3"], false));

		expect(transcript.renderViewport(80, 5, frame)).toEqual(["A3", "", "B1", "B2", "B3"]);
	});

	it("gives surplus rows to assistant text before a growing tool card (issue 9718)", () => {
		const transcript = new TranscriptContainer();
		const assistant = new Block(["A1", "A2", "A3", "A4"], false);
		const tool = new ToolBlock(["T1", "T2", "T3", "T4"], false);
		transcript.addChild(assistant);
		transcript.addChild(tool);
		// The separator leaves four content rows. Surplus goes to the assistant
		// block first, leaving the tool card at its one-row minimum.
		const out = transcript.renderViewport(80, 5, frame);
		expect(out).toEqual(["A2", "A3", "A4", "", "T4"]);
		expect(assistant.allocations.at(-1)).toBe(3);
		expect(tool.allocations.at(-1)).toBe(1);
	});

	it("keeps a reopened settled block live under pressure", () => {
		const transcript = new TranscriptContainer();
		const expandable = new Block(["parent row", "expanded detail"], true);
		const live = new Block(["live row"], false);
		transcript.addChild(expandable);
		transcript.addChild(live);

		transcript.renderViewport(80, 3, frame);
		expect(transcript.blockStates()).toEqual(["settled", "active"]);

		expandable.reopen(["parent row", "expanded detail"]);

		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["1 more transcript blocks", "live row"]);
		expect(live.allocations.at(-1)).toBe(1);
	});

	it("preserves a hidden settled emergency row in chronological order", () => {
		const transcript = new TranscriptContainer();
		const settled = new EmergencyBlock(["settled detail"], "settled summary");
		const middle = new Block(["middle"], false);
		const later = new Block(["later"], false);
		const current = new Block(["current"], false);
		transcript.addChild(settled);
		transcript.addChild(middle);
		transcript.addChild(later);
		transcript.addChild(current);

		expect(transcript.renderViewport(80, 1, frame)).toEqual(["current"]);

		expect(transcript.renderViewport(80, 5, frame)).toEqual([
			"2 more transcript blocks",
			"",
			"settled summary",
			"",
			"current",
		]);
		expect(transcript.getLastViewportSpans()).toEqual([
			{ component: settled, start: 2, end: 3, offset: 0 },
			{ component: current, start: 4, end: 5, offset: 0 },
		]);
		expect(settled.emergencyRenderAllocations.at(-1)).toBe(1);
		expect(middle.allocations.at(-1)).toBe(0);
		expect(later.allocations.at(-1)).toBe(0);
		expect(current.allocations.at(-1)).toBe(1);
	});

	it("permits removing settled blocks until they are offered or committed", () => {
		const transcript = new TranscriptContainer();
		const settled = new Block(["settled snapshot"], true);
		const live = new Block(["live", "live", "live"], false);
		transcript.addChild(settled);
		transcript.addChild(live);

		// Settled but still in the mutable viewport: removable without a trace,
		// so a follow-up displaceable snapshot can retract it.
		expect(transcript.canRemoveBlock(settled)).toBe(true);

		// Offered to the terminal: mid-write, no longer removable.
		const batch = transcript.peekFinalizedBatch(80, 2);
		expect(batch?.rows).toEqual(["settled snapshot", ""]);
		expect(transcript.canRemoveBlock(settled)).toBe(false);

		// Committed: immutable history; removal must be refused outright.
		transcript.acknowledgeFinalizedBatch(batch!.id);
		expect(transcript.canRemoveBlock(settled)).toBe(false);
		transcript.removeChild(settled);
		expect(transcript.blockStates()).toEqual(["committed", "active"]);
	});

	it("reports fresh and unknown blocks as unemitted", () => {
		const transcript = new TranscriptContainer();
		const fresh = new Block(["fresh"], false);
		transcript.addChild(fresh);

		expect(transcript.isBlockEmitted(fresh)).toBe(false);
		expect(transcript.isBlockEmitted(new Block(["unknown"], false))).toBe(false);
	});

	it("reports offered append rows as emitted before acknowledgment", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["stable", "partial"], ["stable"]);
		transcript.addChild(block);

		expect(transcript.isBlockEmitted(block)).toBe(false);
		const offered = transcript.peekFinalizedBatch(80, 0);
		expect(offered?.kind).toBe("append");
		expect(offered?.rows).toEqual(["stable"]);
		expect(transcript.isBlockEmitted(block)).toBe(true);
		transcript.acknowledgeFinalizedBatch(offered!.id);
		expect(transcript.isBlockEmitted(block)).toBe(true);
	});

	it("reports blocks with emitted stable rows", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["stable", "partial"], ["stable"]);
		transcript.addChild(block);

		const batch = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(batch.id);

		expect(transcript.isBlockEmitted(block)).toBe(true);
	});

	it("reports committed blocks as emitted", () => {
		const transcript = new TranscriptContainer();
		const block = new Block(["committed"], true);
		transcript.addChild(block);

		const batch = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(batch.id);

		expect(transcript.isBlockEmitted(block)).toBe(true);
	});

	it("reports nested components of emitted group wrappers", () => {
		const transcript = new TranscriptContainer();
		const group = new AppendGroupWrapper(["nested"]);
		const nested = new Block(["nested"], false);
		group.addChild(nested);
		transcript.addChild(group);

		const batch = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(batch.id);

		expect(transcript.isBlockEmitted(nested)).toBe(true);
	});

	it("replays committed history without rewinding lifecycle state", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		if (first === undefined) throw new Error("expected initial batch");
		transcript.acknowledgeFinalizedBatch(first.id);
		expect(transcript.blockStates()).toEqual(["committed"]);

		transcript.beginReplay();
		expect(transcript.renderViewport(80, 10, frame)).toEqual([]);
		const replay = transcript.peekFinalizedBatch(80, 10);
		expect(replay?.id).toBeGreaterThan(first.id);
		expect(replay?.rows).toEqual(["final", ""]);
		transcript.acknowledgeFinalizedBatch(replay!.id);
		expect(transcript.blockStates()).toEqual(["committed"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
	});

	it("flushes a finalized prefix without viewport pressure", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["fits"], true));

		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
		expect(transcript.peekFlushBatch(80)?.rows).toEqual(["fits", ""]);
	});

	it("keeps the live viewport while an independent replay is offered", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["committed"], true));
		const committed = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["active"], false));

		transcript.beginReplay();
		expect(transcript.peekFinalizedBatch(80, 10)?.rows).toEqual(["committed", ""]);
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["active"]);
	});
	it("renders exactly the trailing semantic rows without walking the full ledger", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["a1", "a2"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new AppendBlock(["b1", "b2"], ["b1"], true));
		transcript.addChild(new Block(["c1"], false));

		const full = transcript.render(80);
		for (const cap of [1, 3, 4, full.length, full.length + 5]) {
			expect(transcript.renderTail(80, cap)).toEqual(full.slice(-Math.min(cap, full.length)));
		}
		expect(transcript.renderTail(80, 0)).toEqual([]);
	});

	it("cancels a pending replay so shutdown flush emits only un-retired rows", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["committed"], true));
		const committed = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["tail"], true));

		transcript.beginReplay();
		transcript.cancelReplay();
		expect(transcript.peekFlushBatch(80)?.rows).toEqual(["tail", ""]);
	});
});

describe("TranscriptContainer viewport click spans", () => {
	it("maps uncapped viewport rows to their blocks, skipping separators", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["a1", "a2"], false);
		const second = new Block(["b1"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["a1", "a2", "", "b1"]);
		expect(transcript.getLastViewportSpans()).toEqual([
			{ component: first, start: 0, end: 2, offset: 0 },
			{ component: second, start: 3, end: 4, offset: 0 },
		]);
	});

	it("maps allocation-clipped rows to their surviving tails across a boundary", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["a1", "a2", "a3", "a4"], false);
		const second = new Block(["b1", "b2", "b3", "b4"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		expect(transcript.renderViewport(80, 5, frame)).toEqual(["a4", "", "b2", "b3", "b4"]);
		expect(transcript.getLastViewportSpans()).toEqual([
			{ component: first, start: 0, end: 1, offset: 3 },
			{ component: second, start: 2, end: 5, offset: 1 },
		]);
	});

	it("leaves backlog and separator rows unmapped", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled"], true));
		transcript.addChild(new Block(["active"], false));
		const current = new Block(["current one", "current two"], false);
		transcript.addChild(current);

		expect(transcript.renderViewport(80, 3, frame)).toEqual(["2 more transcript blocks", "", "current two"]);
		expect(transcript.getLastViewportSpans()).toEqual([{ component: current, start: 2, end: 3, offset: 1 }]);
	});

	it("clears spans when the tail is empty or cleared", () => {
		const transcript = new TranscriptContainer();
		const block = new Block(["a1"], false);
		transcript.addChild(block);
		transcript.renderViewport(80, 10, frame);
		expect(transcript.getLastViewportSpans()).toHaveLength(1);

		expect(transcript.renderViewport(80, 0, frame)).toEqual([]);
		expect(transcript.getLastViewportSpans()).toEqual([]);

		transcript.renderViewport(80, 10, frame);
		transcript.clear();
		expect(transcript.getLastViewportSpans()).toEqual([]);
	});
});
