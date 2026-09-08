import { type Component, Container } from "@oh-my-pi/pi-tui";
import { buildGroupedToolCallLine, type CollapsedToolCall, toolCallExpandLevel } from "../../tools/tool-call-display";
import { theme } from "../theme/theme";
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
		if (toolCallExpandLevel() > 0 || this.children.length < 2) return super.render(width);
		const calls: CollapsedToolCall[] = [];
		for (const child of this.children) {
			const call = (child as Partial<ToolExecutionComponent>).collapsedCall?.();
			if (call) calls.push(call);
		}
		if (calls.length === 0) return super.render(width);
		return [buildGroupedToolCallLine(calls, theme, width)];
	}
}
