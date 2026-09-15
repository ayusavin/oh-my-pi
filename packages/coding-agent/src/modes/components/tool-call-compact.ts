/**
 * Compact and grouped tool-call rendering for `display.toolCalls`.
 *
 * `compact` shows one parent row per call. `grouped` folds a consecutive run
 * into one parent summary row. The parent row is the only interactive surface:
 * expanding it renders the full `ToolExecutionComponent` card for every call
 * beneath it; collapsing it removes every card. `compact` instances never
 * accrete past one entry, so their call row is the parent.
 *
 * Row and group content follow the "Compact rendering contract" (C1-C8) in
 * `.downstream/spec/transcript.md`: a row is the tool's name and its primary
 * argument in parentheses, never a `key=value` dump of raw arguments and
 * never the model's intent sentence (that stays in narration above the run,
 * drawn elsewhere by `tools.intentTracing`); no row carries a status word or
 * byte count; a group row names the work, never a bare call count.
 *
 * Read calls that collapse into `ReadToolGroupComponent` keep that richer,
 * path-aware rendering unconditionally — the `display.toolCalls` branch
 * points (event-controller.ts, chat-transcript-builder.ts, ui-helpers.ts)
 * never route a collapsible read here.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { formatDuration, logger } from "@oh-my-pi/pi-utils";
import type { HistoryRowTargetProvider } from "../types";
import { theme } from "../../modes/theme/theme";
import { TRUNCATE_LENGTHS, type ToolUIStatus } from "../../tools/render-utils";
import { type ToolActivitySummary, toolRenderers } from "../../tools/renderers";
import { Ellipsis, renderStatusLine, truncateToWidth } from "../../tui";
import { type ToolExecutionHandle, ToolExecutionComponent, type ToolExecutionUi } from "./tool-execution";

type CallOutcome = "pending" | "success" | "error";

/** Content shape `updateResult` accepts and stores verbatim — matches
 * `ToolExecutionHandle.updateResult`'s own declared type (image blocks
 * included) so an expanded parent can replay every call into the exact
 * `ToolExecutionComponent` card `full` mode would have built, not a
 * text-only reconstruction that drops images. */
export interface CompactCallResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
}

interface CompactCallEntry {
	toolCallId: string;
	/** Canonical renderer key (`toolRenderName`'s output) — looks up the
	 * per-tool `activitySummary` hint and drives group naming (C5). */
	toolName: string;
	label: string;
	tool: AgentTool | undefined;
	args: unknown;
	outcome: CallOutcome;
	/** Full joined text of the settled result — `firstErrorLine` reads its
	 * first line for a failed call's parent row. */
	resultText?: string;
	/** One-line answer summary from the tool's `resultSummary` hook (e.g.
	 * ask's chosen option, B) — the renderer's own resolved data, never
	 * derived from `resultText`. */
	resultSummary?: string;
	/** Verbatim settled result, replayed into the full card while the parent
	 * row is expanded. Undefined until settled. */
	rawResult?: CompactCallResult;
	durationMs?: number;
	startedAtNow?: number;
}

/** Tools whose settled completion is worth a duration on the row — a
 * subagent dispatch, where the run really took measurable time (C3). Every
 * other tool's duration disappears once it settles. */
const SUBAGENT_TOOL_NAMES: Record<string, true> = { task: true };

const GENERIC_ARG_KEYS = ["command", "path", "input"] as const;

/** Tools whose primary argument is not any of the generic keys, or whose
 * generic key is the less informative one: a `grep` row that reads `Grep` or
 * `Grep(src)` hides the only thing the call was about. */
const PRIMARY_ARG_KEYS: Record<string, readonly string[]> = {
	glob: ["path", "pattern"],
	grep: ["pattern", "path"],
	web_search: ["query"],
};

function isPlainArgs(args: unknown): args is Record<string, unknown> {
	return !!args && typeof args === "object" && !Array.isArray(args);
}

/**
 * The same `command`/`path`/`input` scan `ToolExecutionComponent`'s own
 * squeeze fallback uses for a tool with no bespoke `activitySummary`,
 * restricted to scalar strings — an array or object value is skipped rather
 * than serialized, so a collection argument never reaches the row (C1, C6).
 */
function genericPrimaryArgument(toolName: string, args: unknown): string | undefined {
	if (!isPlainArgs(args)) return undefined;
	for (const key of PRIMARY_ARG_KEYS[toolName] ?? GENERIC_ARG_KEYS) {
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
	const detail = genericPrimaryArgument(entry.toolName, entry.args);
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
	const line = (text ?? "")
		.replace(/^Error:\s*/, "")
		.split("\n", 1)[0]
		?.trim();
	return line ? truncateToWidth(line, TRUNCATE_LENGTHS.LINE, Ellipsis.Unicode) : undefined;
}

/**
 * Leading column for the parent row: `▸` expands its cards and `▾` collapses
 * them. Cards have no markers or click affordances of their own.
 */
function rowMarker(state: "open" | "closed"): string {
	return theme.fg("dim", state === "open" ? "▾" : "▸");
}

/** Full cards nest one marker column plus one glyph beneath their parent row. */
const NEST_INDENT = "   ";

/**
 * Parent row for a single call. No status word or byte count (C3): the icon
 * carries success/failure/pending. A duration shows only while the call is
 * running, or once a `task` completion settles; failures show their first
 * error line and a `resultSummary` hook can show its resolved detail.
 */
function renderCallLine(entry: CompactCallEntry, prefix: string): string {
	const status: ToolUIStatus = entry.outcome === "pending" ? "pending" : entry.outcome === "error" ? "error" : "done";
	const title = formatPrimaryText(resolveActivitySummary(entry));
	const meta: string[] = [];
	if (entry.outcome === "pending") {
		if (entry.startedAtNow !== undefined) {
			meta.push(formatDuration(Math.round(performance.now() - entry.startedAtNow)));
		}
	} else if (entry.outcome === "error") {
		const line = firstErrorLine(entry.resultText);
		if (line) meta.push(line);
	} else {
		if (SUBAGENT_TOOL_NAMES[entry.toolName] && entry.durationMs !== undefined) {
			meta.push(formatDuration(Math.round(entry.durationMs)));
		}
		if (entry.resultSummary) {
			meta.push(
				truncateToWidth(entry.resultSummary.replace(/\s+/g, " ").trim(), TRUNCATE_LENGTHS.LINE, Ellipsis.Unicode),
			);
		}
	}
	return `${prefix}${renderStatusLine({ icon: status, title, titleColor: "toolTitle", meta }, theme)}`;
}

interface GroupNoun {
	singular: string;
	plural: string;
}

/**
 * Evidenced collective nouns for a group row (C5): a count and an object
 * naming what happened (`3 shell commands`), not how many calls there were.
 * Covers every built-in tool that can appear in a real run, so the fallback
 * below is reserved for a genuinely unknown (MCP) tool — never a built-in.
 * A tool with no mapping falls back to the MCP-call convention Claude Code
 * itself uses for an unnamed tool (`Called <label> N times`) — still a named
 * tool, never a bare, contentless call count.
 */
const GROUP_NOUNS: Record<string, GroupNoun> = {
	bash: { singular: "shell command", plural: "shell commands" },
	read: { singular: "file read", plural: "files read" },
	write: { singular: "file written", plural: "files written" },
	edit: { singular: "file edited", plural: "files edited" },
	apply_patch: { singular: "file edited", plural: "files edited" },
	grep: { singular: "search", plural: "searches" },
	glob: { singular: "glob", plural: "globs" },
	eval: { singular: "eval", plural: "evals" },
	hub: { singular: "hub call", plural: "hub calls" },
	task: { singular: "agent finished", plural: "agents finished" },
	ask: { singular: "question asked", plural: "questions asked" },
	todo: { singular: "todo update", plural: "todo updates" },
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
function renderGroupLine(entries: readonly CompactCallEntry[], expanded: boolean): string {
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
	const succeeded = entries.some(entry => entry.outcome === "success");
	// A run is only red when nothing in it worked. One failed call among
	// successes reads as "the whole group failed", which is wrong and is the
	// single most misleading thing a collapsed row can say; the failure is
	// still visible on its own line once the row is expanded.
	const status: ToolUIStatus = pending ? "pending" : succeeded ? "done" : "error";
	return `${rowMarker(expanded ? "open" : "closed")} ${renderStatusLine({ icon: status, title, titleColor: "toolTitle" }, theme)}`;
}

/** No-op `ToolExecutionUi` for cards embedded beneath an expanded parent row.
 * The parent click already requests the enclosing render. */
const EMBEDDED_CARD_UI: ToolExecutionUi = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
};

/** Monotonic per-parent hover id. */
let nextCompactToggleId = 1;

/** Opaque per-instance token retained by a committed parent row. */
class CompactToolCallHistoryTarget {
	constructor(readonly component: CompactToolCallComponent) {}
}

/** Resolves a committed-row token without retaining a separate target registry. */
export function resolveCompactToolCallHistoryTarget(target: object): CompactToolCallComponent | undefined {
	return target instanceof CompactToolCallHistoryTarget ? target.component : undefined;
}

/**
 * Compact (`display.toolCalls: "compact"`) and grouped (`"grouped"`) tool-call
 * row. A one-call instance uses its call row as the parent; a multi-call
 * instance uses a summary row. Expanding either parent renders every call's
 * full card in order beneath it. `setExpanded` receives the session-wide
 * `ctrl+o` baseline; parent clicks record a local override through
 * {@link getViewportClickAction}.
 *
 * Multi-entry, toolCallId-keyed `ToolExecutionHandle`, mirroring
 * `ReadToolGroupComponent`'s `finalize()`/`seal()` pair: `finalize()` closes
 * the group to new entries without forcing a still-pending entry done;
 * `seal()` forces it done regardless.
 */
export class CompactToolCallComponent extends Container implements ToolExecutionHandle, HistoryRowTargetProvider {
	#entries = new Map<string, CompactCallEntry>();
	/** Number of width-aware physical segments occupied by the parent row in
	 * the latest live render. */
	#lastParentRowCount = 0;
	#parentText: Text;
	#parentRow = "";
	/** Cards exist only while the effective parent state is expanded. */
	#cards = new Map<string, ToolExecutionComponent>();
	#expanded = false;
	/** Local state set only by a parent-row click. `undefined` follows the
	 * session-wide `#expanded` baseline. */
	#rowExpanded: boolean | undefined;
	#clickId = `@omp:compact-toggle:${nextCompactToggleId++}`;
	#historyTarget = new CompactToolCallHistoryTarget(this);
	#toolActivityVisible = true;
	// Closed to new entries. Distinct from `#sealed`: a `finalize()`d group
	// with a still-pending entry is not yet transcript-finalized because its
	// live result must still resolve in place.
	#finalized = false;
	#sealed = false;
	#blockVersion = 0;

	constructor() {
		super();
		this.#parentText = new Text("", 0, 0);
		this.addChild(this.#parentText);
	}

	/** Add a new call to this row/group. */
	addCall(toolCallId: string, toolName: string, label: string, args: unknown, tool: AgentTool | undefined): void {
		this.#entries.set(toolCallId, {
			toolCallId,
			toolName,
			label,
			tool,
			args,
			outcome: "pending",
		});
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
		this.#cards.get(toolCallId)?.updateArgs(args, toolCallId);
		this.#updateDisplay();
	}

	setArgsComplete(_toolCallId?: string): void {}

	setExecutionStarted(toolCallId?: string): void {
		if (!toolCallId) return;
		const entry = this.#entries.get(toolCallId);
		if (!entry || entry.startedAtNow !== undefined) return;
		entry.startedAtNow = performance.now();
		this.#cards.get(toolCallId)?.setExecutionStarted(toolCallId);
		// The row's only observable transition into "running" (C3's live
		// duration) — nothing else would otherwise repaint it.
		this.#updateDisplay();
	}

	/**
	 * Settle one call. The result is retained verbatim so an expanded parent
	 * can replay it into the same `ToolExecutionComponent` card `full` mode
	 * uses, including image blocks.
	 */
	updateResult(result: CompactCallResult, isPartial = false, toolCallId?: string): void {
		if (!toolCallId || isPartial) return;
		const entry = this.#entries.get(toolCallId);
		if (!entry) return;
		entry.outcome = result.isError ? "error" : "success";
		entry.resultText = result.content
			?.filter(block => block.type === "text")
			.map(block => block.text ?? "")
			.join("\n");
		const summary = result.isError ? undefined : toolRenderers[entry.toolName]?.resultSummary?.(result);
		entry.resultSummary = summary?.detail ?? summary?.label;
		entry.durationMs = entry.startedAtNow !== undefined ? performance.now() - entry.startedAtNow : undefined;
		entry.rawResult = result;
		this.#cards.get(toolCallId)?.updateResult(result, false, toolCallId);
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

	/** Toggle the parent relative to its currently visible state. */
	toggleExpanded(fullRepaintRequested = false): void {
		const expanded = !this.#effectiveExpanded();
		this.#setClickedExpansion(expanded);
		logger.debug("tool row toggle", { calls: this.#entries.size, expanded, fullRepaintRequested });
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
		super.invalidate();
	}

	#effectiveExpanded(): boolean {
		return this.#rowExpanded ?? this.#expanded;
	}

	/** Record the local state chosen by a live parent-row click. */
	#setClickedExpansion(expanded: boolean): void {
		if (this.#rowExpanded === expanded) return;
		this.#rowExpanded = expanded;
		this.#blockVersion++;
		this.#updateDisplay();
	}

	/** A completed render gives every physical parent segment a target. Before
	 * that render, only the logical parent row at local zero is addressable. */
	#isParentRow(local: number): boolean {
		if (!this.#toolActivityVisible || !Number.isInteger(local) || local < 0 || !this.#parentRow) return false;
		return this.#lastParentRowCount === 0 ? local === 0 : local < this.#lastParentRowCount;
	}

	/** Stable target for the parent row's physical segments; cards have no target. */
	historyRowTarget(local: number): object | undefined {
		return this.#isParentRow(local) ? this.#historyTarget : undefined;
	}

	/** Resolve a live parent-row target. Cards are never click or hover targets. */
	#rowTarget(local: number, fullRepaintRequested = false): { id: string; onClick: () => void } | undefined {
		if (!this.#isParentRow(local)) return undefined;
		return { id: this.#clickId, onClick: () => this.toggleExpanded(fullRepaintRequested) };
	}

	/** Every physical segment of the parent shares one hover candidate; cards
	 * return no candidate. */
	getClickFocusAgentIds(local?: number): string[] {
		const row = Number.isInteger(local) && (local as number) >= 0 ? (local as number) : 0;
		const target = this.#rowTarget(row);
		return target ? [target.id] : [];
	}

	/** Parent-row click action. */
	getViewportClickAction(): ((local: number, fullRepaintRequested?: boolean) => void) | undefined {
		if (this.#entries.size === 0) return undefined;
		return (local: number, fullRepaintRequested?: boolean) => {
			const row = Number.isInteger(local) && local >= 0 ? local : 0;
			this.#rowTarget(row, fullRepaintRequested)?.onClick();
		};
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) {
			this.#lastParentRowCount = 0;
			return [];
		}
		const parentLines = this.#parentText.render(width);
		this.#lastParentRowCount = parentLines.length;
		const cardLines: string[] = [];
		if (this.#effectiveExpanded()) {
			for (const entry of this.#entries.values()) {
				const card = this.#cards.get(entry.toolCallId);
				if (!card) continue;
				for (const line of card.render(Math.max(1, width - NEST_INDENT.length))) {
					cardLines.push(`${NEST_INDENT}${line}`);
				}
			}
		}
		return [...parentLines, ...cardLines];
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
		// Only a click-created expansion keeps an otherwise final block mutable:
		// ctrl+o's session-wide baseline may expand cards in scrollback.
		if (this.#rowExpanded === true && this.#entries.size > 0) return false;
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

	#createCard(entry: CompactCallEntry): ToolExecutionComponent {
		const card = new ToolExecutionComponent(
			entry.toolName,
			entry.args,
			{},
			entry.tool,
			EMBEDDED_CARD_UI,
			undefined,
			entry.toolCallId,
		);
		card.setExpanded(true);
		card.setArgsComplete(entry.toolCallId);
		card.setExecutionStarted(entry.toolCallId);
		if (entry.rawResult) card.updateResult(entry.rawResult, false, entry.toolCallId);
		return card;
	}

	#syncCards(entries: readonly CompactCallEntry[], expanded: boolean): void {
		if (!expanded) {
			this.#disposeCards();
			return;
		}
		for (const [toolCallId, card] of this.#cards) {
			if (this.#entries.has(toolCallId)) continue;
			card.dispose();
			this.#cards.delete(toolCallId);
		}
		for (const entry of entries) {
			if (!this.#cards.has(entry.toolCallId)) this.#cards.set(entry.toolCallId, this.#createCard(entry));
		}
	}

	#disposeCards(): void {
		for (const card of this.#cards.values()) card.dispose();
		this.#cards.clear();
	}

	/** Update the sole parent row, then create or dispose the complete ordered
	 * card set according to its effective expansion. */
	#updateDisplay(): void {
		// A layout change invalidates the prior physical parent segment count.
		this.#lastParentRowCount = 0;
		const entries = [...this.#entries.values()];
		const expanded = this.#effectiveExpanded();
		if (entries.length > 1) {
			this.#parentRow = renderGroupLine(entries, expanded);
		} else {
			const entry = entries[0];
			this.#parentRow = entry ? renderCallLine(entry, `${rowMarker(expanded ? "open" : "closed")} `) : "";
		}
		this.#parentText.setText(this.#parentRow);
		this.#syncCards(entries, expanded);
		this.#syncChildren(entries);
	}

	/** Keep every live card in the inherited child list so generic disposal
	 * reaches it and stops any spinner registration. */
	#syncChildren(entries: readonly CompactCallEntry[]): void {
		this.clear();
		this.addChild(this.#parentText);
		for (const entry of entries) {
			const card = this.#cards.get(entry.toolCallId);
			if (card) this.addChild(card);
		}
	}
}

/** Mutable reference to the currently active group; owned by each call site. */
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
