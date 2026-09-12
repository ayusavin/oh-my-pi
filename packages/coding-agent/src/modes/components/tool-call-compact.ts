/**
 * Compact and grouped tool-call rendering for `display.toolCalls`.
 *
 * `compact` shows one line per call; `grouped` additionally folds a run of
 * consecutive calls into one collapsed row with a count, expanding (ctrl+o)
 * to the same per-call lines `compact` always shows. Both settings share
 * this one component: a `compact` instance never accretes past one entry, so
 * it always renders the single-call line.
 *
 * Row and group content follow the "Compact rendering contract" (C1-C8) in
 * `.downstream/spec/transcript.md`: a row is the tool's name and its primary
 * argument in parentheses, never a `key=value` dump of the raw arguments and
 * never the model's own intent sentence (that stays in the narration above
 * the run, drawn elsewhere by `tools.intentTracing`); no row carries a
 * status word or a byte count; a group row names the work, never a bare call
 * count.
 *
 * Read calls that collapse into `ReadToolGroupComponent` keep that richer,
 * path-aware rendering unconditionally — the `display.toolCalls` branch
 * points (event-controller.ts, chat-transcript-builder.ts, ui-helpers.ts)
 * never route a collapsible read here.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";
import { TRUNCATE_LENGTHS, type ToolUIStatus } from "../../tools/render-utils";
import { type ToolActivitySummary, toolRenderers } from "../../tools/renderers";
import { Ellipsis, renderStatusLine, truncateToWidth } from "../../tui";
import type { ToolExecutionHandle } from "./tool-execution";

type CallOutcome = "pending" | "success" | "error";

interface CompactCallEntry {
	toolCallId: string;
	/** Canonical renderer key (`toolRenderName`'s output) — looks up the
	 * per-tool `activitySummary` hint and drives group naming (C5). */
	toolName: string;
	label: string;
	tool: AgentTool | undefined;
	args: unknown;
	outcome: CallOutcome;
	/** First line of a failed call's result text (C3's "first error line"). */
	errorText?: string;
	durationMs?: number;
	startedAtNow?: number;
}

/** Tools whose settled completion is worth a duration on the row — a
 * subagent dispatch, where the run really took measurable time (C3). Every
 * other tool's duration disappears once it settles. */
const SUBAGENT_TOOL_NAMES: Record<string, true> = { task: true };

const GENERIC_ARG_KEYS = ["command", "path", "input"] as const;

function isPlainArgs(args: unknown): args is Record<string, unknown> {
	return !!args && typeof args === "object" && !Array.isArray(args);
}

/**
 * The same `command`/`path`/`input` scan `ToolExecutionComponent`'s own
 * squeeze fallback uses for a tool with no bespoke `activitySummary`,
 * restricted to scalar strings — an array or object value is skipped rather
 * than serialized, so a collection argument never reaches the row (C1, C6).
 */
function genericPrimaryArgument(args: unknown): string | undefined {
	if (!isPlainArgs(args)) return undefined;
	for (const key of GENERIC_ARG_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value.split("\n", 1)[0];
	}
	return undefined;
}

/**
 * The row's tool name and primary argument (C1) — never the model's own
 * intent sentence (C2 reserves that for the narration above the run) and
 * never a `key=value` dump of the argument object. Reuses each tool's own
 * `ToolRenderer.activitySummary`, the same per-tool hint the framed card
 * already draws when squeezed for space (`hub`'s own op+target summary,
 * `write`/`edit`'s own op+path summary, …), falling back to the generic
 * scalar-argument scan and then the bare label.
 */
function resolveActivitySummary(
	entry: Pick<CompactCallEntry, "toolName" | "label" | "args" | "outcome">,
): ToolActivitySummary {
	const renderer = toolRenderers[entry.toolName];
	if (renderer?.activitySummary) {
		try {
			const summary = renderer.activitySummary(entry.args, {
				expanded: false,
				isPartial: entry.outcome === "pending",
			});
			if (summary) return summary;
		} catch {
			// A renderer hint must never break rendering.
		}
	}
	const detail = genericPrimaryArgument(entry.args);
	return detail ? { label: entry.label, detail } : { label: entry.label };
}

/**
 * `Label(detail)` (C1): the detail flattened to one line and cut to a fixed
 * budget with a single ellipsis that never splits an escape sequence or a
 * multi-byte character (C8), via the native width-aware truncator. A tool
 * with no primary argument renders its label alone.
 */
function formatPrimaryText(summary: ToolActivitySummary): string {
	const flattened = summary.detail?.replace(/\s+/g, " ").trim();
	if (!flattened) return summary.label;
	return `${summary.label}(${truncateToWidth(flattened, TRUNCATE_LENGTHS.TITLE, Ellipsis.Unicode)})`;
}

/** First line of a failed call's error text (C3), bounded the same way. */
function firstErrorLine(text: string | undefined): string | undefined {
	const line = (text ?? "").replace(/^Error:\s*/, "").split("\n", 1)[0]?.trim();
	return line ? truncateToWidth(line, TRUNCATE_LENGTHS.LINE, Ellipsis.Unicode) : undefined;
}

/**
 * One line for one call: `⏺ Bash(echo hi)`. No status word or byte count
 * (C3) — the icon alone carries success/failure/pending. A duration shows
 * only while the call is still running, or once settled for a subagent
 * (`task`) completion where the run really took measurable time; a failure
 * instead shows its first error line.
 */
function renderCallLine(entry: CompactCallEntry): string {
	const status: ToolUIStatus = entry.outcome === "pending" ? "pending" : entry.outcome === "error" ? "error" : "done";
	const title = formatPrimaryText(resolveActivitySummary(entry));
	const meta: string[] = [];
	if (entry.outcome === "pending") {
		if (entry.startedAtNow !== undefined) {
			meta.push(formatDuration(Math.round(performance.now() - entry.startedAtNow)));
		}
	} else if (entry.outcome === "error") {
		const line = firstErrorLine(entry.errorText);
		if (line) meta.push(line);
	} else if (SUBAGENT_TOOL_NAMES[entry.toolName] && entry.durationMs !== undefined) {
		meta.push(formatDuration(Math.round(entry.durationMs)));
	}
	return ` ${renderStatusLine({ icon: status, title, titleColor: "toolTitle", meta }, theme)}`;
}

interface GroupNoun {
	singular: string;
	plural: string;
}

/**
 * Evidenced collective nouns for a group row (C5): a count and an object
 * naming what happened (`3 shell commands`), not how many calls there were.
 * A tool with no specific mapping falls back to the MCP-call convention
 * Claude Code itself uses for an unnamed tool (`Called <label> N times`) —
 * still a named tool, never a bare, contentless call count.
 */
const GROUP_NOUNS: Record<string, GroupNoun> = {
	bash: { singular: "shell command", plural: "shell commands" },
	write: { singular: "file written", plural: "files written" },
	edit: { singular: "file edited", plural: "files edited" },
	apply_patch: { singular: "file edited", plural: "files edited" },
	task: { singular: "agent finished", plural: "agents finished" },
};

function groupPhrase(toolName: string, label: string, count: number): string {
	const noun = GROUP_NOUNS[toolName];
	if (noun) return `${count} ${count === 1 ? noun.singular : noun.plural}`;
	return count === 1 ? `Called ${label} once` : `Called ${label} ${count} times`;
}

/**
 * One collapsed row for a run of calls (C5): a verb/count/object phrase per
 * distinct tool, comma-joined when the run spans more than one — `2 tool
 * calls` is exactly the row a developer cannot read, and is never produced
 * here. A mixed-tool run names the tools (`2 shell commands, 1 file
 * written`), not the total.
 */
function renderGroupLine(entries: readonly CompactCallEntry[]): string {
	const byTool = new Map<string, { label: string; count: number }>();
	for (const entry of entries) {
		const bucket = byTool.get(entry.toolName);
		if (bucket) bucket.count++;
		else byTool.set(entry.toolName, { label: entry.label, count: 1 });
	}
	const title = [...byTool.entries()]
		.map(([toolName, { label, count }]) => groupPhrase(toolName, label, count))
		.join(", ");
	const pending = entries.some(entry => entry.outcome === "pending");
	const failed = entries.some(entry => entry.outcome === "error");
	const status: ToolUIStatus = pending ? "pending" : failed ? "error" : "done";
	return ` ${renderStatusLine({ icon: status, title, titleColor: "toolTitle" }, theme)}`;
}

/**
 * Compact (`display.toolCalls: "compact"`) and grouped (`"grouped"`) tool-call
 * row: one line per call, or — once a second call joins the same group — one
 * collapsed summary row carrying what happened. Expanded (ctrl+o), a group
 * always renders one line per call. Multi-entry, toolCallId-keyed
 * `ToolExecutionHandle`, mirroring `ReadToolGroupComponent`'s shape,
 * including its `finalize()`/`seal()` pair: `finalize()` closes the group to
 * new entries without forcing a still-pending one done; `seal()` forces it
 * done regardless (turn end, abandonment). `setExpanded` is the same toggle
 * a future click handler can call (C7) — ctrl+o already drives it via
 * `setExpanded`, unchanged.
 */
export class CompactToolCallComponent extends Container implements ToolExecutionHandle {
	#entries = new Map<string, CompactCallEntry>();
	#text: Text;
	#expanded = false;
	#toolActivityVisible = true;
	// Closed to new entries. Distinct from `#sealed`: a `finalize()`d group
	// with a still-pending entry (e.g. a background task the turn ended
	// without) is not yet transcript-finalized — the live update can still
	// resolve it in place.
	#finalized = false;
	#sealed = false;
	#blockVersion = 0;

	constructor() {
		super();
		this.#text = new Text("", 0, 0);
		this.addChild(this.#text);
	}

	/** Add a new call to this row/group. */
	addCall(toolCallId: string, toolName: string, label: string, args: unknown, tool: AgentTool | undefined): void {
		this.#entries.set(toolCallId, { toolCallId, toolName, label, tool, args, outcome: "pending" });
		this.#updateDisplay();
	}

	get size(): number {
		return this.#entries.size;
	}

	updateArgs(args: unknown, toolCallId?: string): void {
		if (!toolCallId) return;
		const entry = this.#entries.get(toolCallId);
		if (!entry || entry.args === args) return;
		entry.args = args;
		this.#updateDisplay();
	}

	setArgsComplete(_toolCallId?: string): void {}

	setExecutionStarted(toolCallId?: string): void {
		if (!toolCallId) return;
		const entry = this.#entries.get(toolCallId);
		if (!entry || entry.startedAtNow !== undefined) return;
		entry.startedAtNow = performance.now();
		// The row's only observable transition into "running" (C3's live
		// duration) — nothing else would otherwise repaint it.
		this.#updateDisplay();
	}

	updateResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		isPartial = false,
		toolCallId?: string,
	): void {
		if (!toolCallId || isPartial) return;
		const entry = this.#entries.get(toolCallId);
		if (!entry) return;
		entry.outcome = result.isError ? "error" : "success";
		entry.errorText = result.isError
			? result.content
					?.filter(block => block.type === "text")
					.map(block => block.text ?? "")
					.join("\n")
			: undefined;
		entry.durationMs = entry.startedAtNow !== undefined ? performance.now() - entry.startedAtNow : undefined;
		this.#blockVersion++;
		this.#updateDisplay();
	}

	/** Remove one call without discarding settled siblings; `true` once empty. */
	removeEntry(toolCallId: string): boolean {
		if (!this.#entries.delete(toolCallId)) return this.#entries.size === 0;
		this.#updateDisplay();
		return this.#entries.size === 0;
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) this.#blockVersion++;
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
		super.invalidate();
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return [];
		return super.render(width);
	}

	/** Calls never park as background tasks; the handle method is a no-op. */
	parkAsBackground(): void {}

	/** Close the group to new entries; a still-pending entry keeps updating
	 * live until it settles. */
	finalize(): void {
		this.#finalized = true;
	}

	seal(): void {
		this.#sealed = true;
	}

	isTranscriptBlockFinalized(): boolean {
		if (this.#sealed) return true;
		if (!this.#finalized) return false;
		for (const entry of this.#entries.values()) {
			if (entry.outcome === "pending") return false;
		}
		return true;
	}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	getComponent(): Component {
		return this;
	}

	#updateDisplay(): void {
		const entries = [...this.#entries.values()];
		const lines = entries.length <= 1 || this.#expanded ? entries.map(renderCallLine) : [renderGroupLine(entries)];
		this.#text.setText(lines.join("\n"));
	}
}

/** Mutable reference to the currently open group; owned by each call site. */
export interface CompactToolGroupHolder {
	current: CompactToolCallComponent | undefined;
}

/**
 * Narrow a `display.toolCalls` value to the two modes this component draws.
 * Anything else — `"full"`, an unset key, a settings stub that does not know
 * the key — yields `undefined`, so the caller keeps the stock tool card.
 */
export function compactToolCallMode(value: unknown): "compact" | "grouped" | undefined {
	return value === "compact" || value === "grouped" ? value : undefined;
}

/**
 * Close the held `display.toolCalls: "grouped"` group so the next call
 * starts a fresh one instead of extending a stale one — the reset half of
 * the signal `mountCompactToolCall` relies on instead of container-tail
 * identity (a per-message streaming placeholder with no visible content can
 * change the container's tail without the run actually breaking). Callers
 * reset at a user message, visible assistant prose, a turn boundary, or a
 * read call joining `ReadToolGroupComponent` instead — mirroring
 * `ReadToolGroupComponent`'s own `#resetReadGroup()` signal.
 *
 * `sealed` forces the held group done even with an entry still pending — the
 * rebuild paths (`ui-helpers.ts`, `chat-transcript-builder.ts`), which have
 * no further live update to apply to it. The live event-controller path
 * passes `false`: a still-running call keeps resolving in place after its
 * group closes to new entries. Idempotent.
 */
export function resetCompactToolGroup(holder: CompactToolGroupHolder, sealed: boolean): void {
	if (sealed) holder.current?.seal();
	else holder.current?.finalize();
	holder.current = undefined;
}

/**
 * Get-or-create the `display.toolCalls` handle for a new call, add the call
 * to it, and — for the three creation sites that can settle a call before it
 * ever goes pending (an assistant turn that starts with an error) — apply
 * that immediate result. `grouped` extends `holder.current` for as long as
 * the caller keeps it set (see {@link resetCompactToolGroup}); `compact`
 * never reuses a held group — each call gets its own, `finalize()`d
 * immediately since it will never receive a second entry. Returns
 * `pending: false` when `immediateError` already settled the call, so the
 * caller skips tracking it as pending.
 */
export function mountCompactToolCall(
	container: Container,
	holder: CompactToolGroupHolder,
	mode: "compact" | "grouped",
	expanded: boolean,
	toolCallId: string,
	toolName: string,
	args: unknown,
	tool: AgentTool | undefined,
	immediateError?: string,
): { group: CompactToolCallComponent; pending: boolean } {
	const reused = mode === "grouped" && holder.current !== undefined;
	const group = reused ? holder.current! : new CompactToolCallComponent();
	if (!reused) {
		group.setExpanded(expanded);
		container.addChild(group);
	}
	if (mode === "grouped") holder.current = group;
	else group.finalize();
	group.addCall(toolCallId, toolName, tool?.label ?? toolName, args, tool);
	if (immediateError === undefined) return { group, pending: true };
	group.updateResult({ content: [{ type: "text", text: immediateError }], isError: true }, false, toolCallId);
	return { group, pending: false };
}
