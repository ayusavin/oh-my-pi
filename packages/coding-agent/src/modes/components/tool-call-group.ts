import { type Component, Container } from "@oh-my-pi/pi-tui";
import {
	buildGroupedToolCallLine,
	type CollapsedToolCall,
	summarizeToolCalls,
	toolCallExpandLevel,
} from "../../tools/tool-call-display";
import { theme } from "../theme/theme";
import type { ExpandableBlock } from "../utils/block-expansion";
import type { ToolActivityComponent } from "./tool-activity";
import type { ToolExecutionComponent } from "./tool-execution";

/**
 * One transcript row for a run of consecutive tool calls in a turn
 * (`display.toolCalls: grouped`). The group owns the real
 * {@link ToolExecutionComponent}s rather than re-rendering their content, so
 * ctrl+o still reaches each call's own per-call line (level 1) and its
 * untouched card (level 2); only the collapsed level draws anything of its own.
 *
 * Results keep routing to the individual components through `pendingTools` —
 * the group is a parent, not a handle.
 */
export class ToolCallGroupComponent extends Container implements ToolActivityComponent {
	#sealed = false;
	#toolActivityVisible = true;
	// Set only under `display.expandScope: block`; `undefined` follows the session.
	#blockExpandLevel: number | undefined;

	addCall(component: ToolExecutionComponent): void {
		this.addChild(component);
	}

	get callCount(): number {
		return this.children.length;
	}

	/** No further calls join this group; it may retire once its calls settle. */
	seal(): void {
		this.#sealed = true;
		this.invalidate();
	}

	isTranscriptBlockFinalized(): boolean {
		if (!this.#sealed) return false;
		return this.children.every(child => {
			const block = child as Component & { isTranscriptBlockFinalized?(): boolean };
			return block.isTranscriptBlockFinalized?.() ?? true;
		});
	}

	/**
	 * Forward ctrl+o to the calls: the transcript's expansion traversal only
	 * visits top-level children, so without this the grouped calls would freeze
	 * at their insertion-time expansion state.
	 */
	setExpanded(expanded: boolean): void {
		for (const child of this.children) {
			const expandable = child as Partial<{ setExpanded(expanded: boolean): void }>;
			expandable.setExpanded?.(expanded);
		}
	}

	// ── ExpandableBlock (display.expandScope: block) ─────────────────────────
	// The three levels the user walks live here, not on a single call: 0 = the
	// summary row, 1 = one line per call (and the cursor may descend into them),
	// 2 = every call's full card.

	blockExpandLevel(): number {
		return this.#blockExpandLevel ?? toolCallExpandLevel();
	}

	setBlockExpandLevel(level: number | undefined): void {
		this.#blockExpandLevel = level === undefined ? undefined : Math.max(0, Math.min(2, level));
		// Level 1 hands the rows back to the calls at *their* collapsed level; an
		// individually expanded call is reset by this deliberate group gesture.
		for (const child of this.children) {
			(child as Partial<ExpandableBlock>).setBlockExpandLevel?.(
				this.#blockExpandLevel === undefined ? undefined : this.#blockExpandLevel === 2 ? 2 : 0,
			);
		}
		this.invalidate();
	}

	blockExpandCycle(): readonly number[] {
		return [0, 1, 2];
	}

	expandedBlockCalls(): readonly ExpandableBlock[] {
		if (this.blockExpandLevel() === 0) return [];
		return this.children.filter(
			(child): child is Component & ExpandableBlock =>
				typeof (child as Partial<ExpandableBlock>).blockExpandLevel === "function",
		);
	}

	blockExpandLabel(): string {
		const calls: CollapsedToolCall[] = [];
		for (const child of this.children) {
			const call = (child as Partial<ToolExecutionComponent>).collapsedCall?.();
			if (call) calls.push(call);
		}
		return calls.length > 0 ? summarizeToolCalls(calls) : "Tool calls";
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		for (const child of this.children) {
			const activity = child as Partial<ToolActivityComponent>;
			activity.setToolActivityVisible?.(visible);
		}
		this.invalidate();
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return [];
		// A lone call reads better as its own collapsed line than as a summary of
		// one, and any expansion hands the rows back to the calls themselves.
		if (this.blockExpandLevel() > 0 || this.children.length < 2) return super.render(width);
		const calls: CollapsedToolCall[] = [];
		for (const child of this.children) {
			const call = (child as Partial<ToolExecutionComponent>).collapsedCall?.();
			if (call) calls.push(call);
		}
		if (calls.length === 0) return super.render(width);
		return [buildGroupedToolCallLine(calls, theme, width)];
	}
}
