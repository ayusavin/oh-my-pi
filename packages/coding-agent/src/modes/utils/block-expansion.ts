/**
 * Per-block expansion (`display.expandScope: block`).
 *
 * Under the default `session` scope one flag — `InteractiveMode.toolOutputExpanded`,
 * plus the module-level level in `tools/tool-call-display.ts` — drives every live
 * tool block at once, so ctrl+o expands blocks the user scrolled past long ago.
 * Under `block` scope expansion lives on the component instead, and this cursor
 * decides which component a keypress reaches.
 *
 * The cursor holds no index: an index would drift every time a turn appends a
 * block. It pins the selected component itself and re-derives its position from
 * the live list, so a block that retires into terminal scrollback simply stops
 * being reachable — `TranscriptContainer` cannot re-render a committed block
 * (see `transcript-container.ts`, `acknowledgeFinalizedBatch` marks the range
 * `committed`), and pretending otherwise is what produced churn per block.
 */

/** A transcript block whose expansion ctrl+o can drive on its own. */
export interface ExpandableBlock {
	/** 0 = collapsed. Higher levels are block-specific; see {@link blockExpandCycle}. */
	blockExpandLevel(): number;
	/** `undefined` hands the block back to the session-wide level (`session` scope). */
	setBlockExpandLevel(level: number | undefined): void;
	/** The levels ctrl+o walks, in order, wrapping back to the first. */
	blockExpandCycle(): readonly number[];
	/** Calls the cursor may descend into while this block is expanded; empty for a single call. */
	expandedBlockCalls(): readonly ExpandableBlock[];
	/** Short wording naming this block on the status line. */
	blockExpandLabel(): string;
}

export function isExpandableBlock(value: unknown): value is ExpandableBlock {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as ExpandableBlock).blockExpandLevel === "function" &&
		typeof (value as ExpandableBlock).setBlockExpandLevel === "function" &&
		typeof (value as ExpandableBlock).blockExpandCycle === "function" &&
		typeof (value as ExpandableBlock).expandedBlockCalls === "function" &&
		typeof (value as ExpandableBlock).blockExpandLabel === "function"
	);
}

export interface BlockSelection {
	block: ExpandableBlock;
	/** 1-based position among the reachable entries, for the status line. */
	position: number;
	total: number;
	/** No entry is older than this one; a further move would need scrollback. */
	atOldest: boolean;
	atNewest: boolean;
}

export interface BlockExpansionChange extends BlockSelection {
	level: number;
	/** How many levels this block cycles through (2 for a call, 3 for a group). */
	levels: number;
}

/** Selection cursor over the live tool blocks, newest-anchored until moved. */
export class BlockExpansionCursor {
	#pinned: ExpandableBlock | undefined;
	#committedNoticeShown = false;

	/**
	 * The reachable entries in transcript order: every live block, with an
	 * expanded group's calls immediately after it. A collapsed group hides its
	 * calls, so the cursor cannot land on something the user cannot see.
	 */
	static flatten(live: readonly ExpandableBlock[]): ExpandableBlock[] {
		const entries: ExpandableBlock[] = [];
		for (const block of live) {
			entries.push(block);
			entries.push(...block.expandedBlockCalls());
		}
		return entries;
	}

	/** The newest reachable entry until a move pins one; a pin that scrolled out is dropped. */
	current(live: readonly ExpandableBlock[]): BlockSelection | undefined {
		const entries = BlockExpansionCursor.flatten(live);
		if (entries.length === 0) {
			this.#pinned = undefined;
			return undefined;
		}
		const pinnedIndex = this.#pinned ? entries.indexOf(this.#pinned) : -1;
		if (pinnedIndex < 0) this.#pinned = undefined;
		const index = pinnedIndex < 0 ? entries.length - 1 : pinnedIndex;
		return {
			block: entries[index]!,
			position: index + 1,
			total: entries.length,
			atOldest: index === 0,
			atNewest: index === entries.length - 1,
		};
	}

	/** `-1` selects one entry older, `+1` one newer. Stops at either end; never wraps. */
	move(live: readonly ExpandableBlock[], delta: number): BlockSelection | undefined {
		const entries = BlockExpansionCursor.flatten(live);
		const from = this.current(live);
		if (!from) return undefined;
		const index = Math.min(entries.length - 1, Math.max(0, from.position - 1 + Math.sign(delta)));
		this.#pinned = entries[index]!;
		return {
			block: this.#pinned,
			position: index + 1,
			total: entries.length,
			atOldest: index === 0,
			atNewest: index === entries.length - 1,
		};
	}

	/** Advance the selected block one expansion level, wrapping to collapsed. */
	cycle(live: readonly ExpandableBlock[]): BlockExpansionChange | undefined {
		const selection = this.current(live);
		if (!selection) return undefined;
		const cycle = selection.block.blockExpandCycle();
		if (cycle.length === 0) return undefined;
		const at = cycle.indexOf(selection.block.blockExpandLevel());
		const level = cycle[(at + 1) % cycle.length]!;
		selection.block.setBlockExpandLevel(level);
		// Expanding pins the block: the next ctrl+o must reach the same one even
		// though a turn may have appended a newer block in between.
		this.#pinned = selection.block;
		// A group that just collapsed took its calls out of reach; re-derive the
		// position so the status line reports where the cursor actually is.
		return { ...(this.current(live) ?? selection), level, levels: cycle.length };
	}

	/**
	 * True the first time an edge move happens with blocks already in scrollback.
	 * The notice is stated once — repeating it per block is the churn this scope
	 * exists to remove.
	 */
	takeCommittedNotice(): boolean {
		if (this.#committedNoticeShown) return false;
		this.#committedNoticeShown = true;
		return true;
	}

	/** Hand every live block back to the session level and re-anchor on the newest. */
	reset(live: readonly ExpandableBlock[] = []): void {
		for (const block of BlockExpansionCursor.flatten(live)) block.setBlockExpandLevel(undefined);
		this.#pinned = undefined;
	}
}
