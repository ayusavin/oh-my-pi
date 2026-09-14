/**
 * Compact and grouped tool-call rendering for `display.toolCalls`.
 *
 * `compact` shows one line per call; `grouped` additionally folds a run of
 * consecutive calls into one collapsed row with a count, expanding (ctrl+o
 * or a click on the group's own row) to the same per-call lines `compact`
 * always shows — the group row itself stays, dimmed calls list beneath it
 * (two-level expansion, C7). Both settings share this one component: a
 * `compact` instance never accretes past one entry, so it always renders
 * the single-call line.
 *
 * Clicking one call's own row — a dimmed row inside an expanded group, or a
 * standalone `compact` row once it has settled — swaps that one line for the
 * exact `ToolExecutionComponent` card `full` mode would have built for it
 * (command/arguments plus output), reusing the class rather than
 * duplicating its rendering; a second click on any of that card's own rows
 * returns it to the one-line form. Only one call can be open per instance.
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
import { type ToolExecutionHandle, ToolExecutionComponent, type ToolExecutionUi } from "./tool-execution";

type CallOutcome = "pending" | "success" | "error";

/** Content shape `updateResult` accepts and stores verbatim — matches
 * `ToolExecutionHandle.updateResult`'s own declared type (image blocks
 * included) so a call opened later (req 4) replays into its
 * `ToolExecutionComponent` card exactly as `full` mode would have built it,
 * not a text-only reconstruction that drops images. */
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
	 * first line for a failed call's row (C3), and per-row clickability (C7)
	 * gates on it being non-empty ("more to show"). */
	resultText?: string;
	/** One-line answer summary from the tool's `resultSummary` hook (e.g.
	 * ask's chosen option, B) — the renderer's own resolved data, never
	 * derived from `resultText`. */
	resultSummary?: string;
	/** Verbatim settled result, replayed into a `ToolExecutionComponent` when
	 * this call opens (req 4). Undefined until settled. */
	rawResult?: CompactCallResult;
	durationMs?: number;
	startedAtNow?: number;
	/** This entry's own click-candidate id (C7 hover banding): distinct from
	 * every other entry's and from the group's own summary-row id, so
	 * hovering or clicking one dimmed subordinate line — or its open card,
	 * once opened (req 4) — never bands/toggles a sibling row. */
	clickId: string;
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
	const line = (text ?? "").replace(/^Error:\s*/, "").split("\n", 1)[0]?.trim();
	return line ? truncateToWidth(line, TRUNCATE_LENGTHS.LINE, Ellipsis.Unicode) : undefined;
}

/**
 * One line for one call: `⏺ Bash(echo hi)`. No status word or byte count
 * (C3) — the icon alone carries success/failure/pending. A duration shows
 * only while the call is still running, or once settled for a subagent
 * (`task`) completion where the run really took measurable time; a failure
 * instead shows its first error line, and a settled call with a
 * `resultSummary` hook (ask's chosen answer, B) shows that instead.
 */
/**
 * Leading column that says what a click on this row does, so the affordance
 * is readable from a still screenshot instead of discovered by trial: `▸`
 * opens (a collapsed group, or a call whose full card is closed), `▾` closes
 * what is currently open. Every row of a group carries one: each call is
 * clickable whether or not it has settled.
 */
function rowMarker(state: "open" | "closed"): string {
	return theme.fg("dim", state === "open" ? "▾" : "▸");
}

/** Subordinate rows of an expanded group, and the open card, sit one marker
 * column plus one glyph in from the summary, so nesting is visible without
 * relying on hover. */
const NEST_INDENT = "   ";

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
			meta.push(truncateToWidth(entry.resultSummary.replace(/\s+/g, " ").trim(), TRUNCATE_LENGTHS.LINE, Ellipsis.Unicode));
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

/**
 * SGR dim (faint) wrapping a fully-rendered subordinate call line (C7's
 * two-level expansion): reopens faint after every embedded reset so the
 * row's own icon/title colors do not cancel it partway through — same idiom
 * as the composer's own focus-proxied dimming (`interactive-mode.ts`'s
 * editor-border wrap, `status-line/component.ts`'s `#dimWhileFocusProxied`).
 */
function dimLine(line: string): string {
	if (!line) return line;
	return `\x1b[2m${line.replaceAll("\x1b[0m", "\x1b[0m\x1b[2m")}\x1b[22m`;
}

/**
 * No-op `ToolExecutionUi` for a card embedded by opening one call's row
 * (req 4). The click that opens it flows through `input-controller.ts`'s
 * own handler, which already requests a render immediately after invoking
 * the row's action, and an embedded card only ever wraps an already-settled
 * call (opening gates on `entryClickable`) — so none of `ToolExecutionUi`'s
 * supplementary repaint hooks (spinner ticks, an async Kitty image
 * conversion completing) have a live case to serve here.
 */
const EMBEDDED_CARD_UI: ToolExecutionUi = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
};

/** Per-instance click-candidate id counter (C7 hover banding) — monotonic,
 * process-lifetime unique so a retired row's id can never alias a live one. */
let nextToolRowClickId = 1;

/**
 * Compact (`display.toolCalls: "compact"`) and grouped (`"grouped"`) tool-call
 * row: one line per call, or — once a second call joins the same group — one
 * collapsed summary row carrying what happened. Expanded (ctrl+o, or a click
 * on the group row itself), the group row stays and the per-call lines list
 * beneath it, visually subordinate (dimmed) — two-level expansion (C7).
 * Clicking one call's own line swaps that one line for the exact
 * `ToolExecutionComponent` card `full` mode builds for that call; a second
 * click on any of the open card's rows returns it to the one-line form.
 * Multi-entry, toolCallId-keyed `ToolExecutionHandle`, mirroring
 * `ReadToolGroupComponent`'s shape, including its `finalize()`/`seal()` pair:
 * `finalize()` closes the group to new entries without forcing a
 * still-pending one done; `seal()` forces it done regardless (turn end,
 * abandonment). `setExpanded` drives the session-wide `ctrl+o` baseline
 * unchanged; clicks dispatch per row through {@link getViewportClickAction}.
 */
export class CompactToolCallComponent extends Container implements ToolExecutionHandle {
	#entries = new Map<string, CompactCallEntry>();
	#beforeText: Text;
	#afterText: Text;
	#expanded = false;
	/** Per-row click override (C7) for the group's own summary line,
	 * independent of `#expanded` (the session-wide `ctrl+o` flag
	 * `setExpanded` tracks): `undefined` follows `#expanded`; a boolean here
	 * wins until the next click on the summary row. Only meaningful once a
	 * second call joins the group — a standalone row's open/closed state
	 * lives entirely in `#openCallId` instead. */
	#rowExpanded: boolean | undefined;
	/** Click-candidate id for the group's own summary row (C7 hover
	 * banding) — never a real agent id (the `@…:…` charset cannot collide
	 * with one; same precedent as `PINNED_HUD_TOGGLE_ID`).
	 * `getViewportClickAction` resolves before any registry lookup would
	 * see it. Each entry carries its own separate id (`CompactCallEntry.clickId`)
	 * so a per-call subordinate line never shares a hover target with the
	 * summary or with a sibling call. */
	#clickId = `@omp:tool-row:${nextToolRowClickId++}`;
	#toolActivityVisible = true;
	// Closed to new entries. Distinct from `#sealed`: a `finalize()`d group
	// with a still-pending entry (e.g. a background task the turn ended
	// without) is not yet transcript-finalized — the live update can still
	// resolve it in place.
	#finalized = false;
	#sealed = false;
	#blockVersion = 0;
	/** toolCallId of the entry whose full `ToolExecutionComponent` card is
	 * currently embedded in place of its one-line row (req 4). At most one
	 * entry open per instance — opening a second closes the first. */
	#openCallId: string | undefined;
	#openCard: ToolExecutionComponent | undefined;
	/** Row count the open card's last actual render produced, at the width
	 * that render used. `getClickFocusAgentIds`/`getViewportClickAction`
	 * take no width, so they cannot re-render to learn this — they rely on
	 * this cache instead. Always fresh where it matters: `Composer.renderFrame`
	 * only ever calls them immediately after it renders this component for
	 * the same frame. */
	#lastCardRows = 0;

	constructor() {
		super();
		this.#beforeText = new Text("", 0, 0);
		this.#afterText = new Text("", 0, 0);
		this.addChild(this.#beforeText);
		this.addChild(this.#afterText);
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
			clickId: `@omp:tool-row:${nextToolRowClickId++}`,
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

	/**
	 * Settle one call. `result`'s shape matches `CompactCallResult` (image
	 * blocks included) so it stores verbatim into `rawResult` and, once this
	 * call opens (req 4), replays into its `ToolExecutionComponent` card
	 * exactly as `full` mode would have built it — not a text-only
	 * reconstruction that drops images. Forwards to the open card in place
	 * when this is the entry currently open (a hub/todo-style displaceable
	 * result can settle more than once).
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
		if (this.#openCallId === toolCallId) this.#openCard?.updateResult(result, false, toolCallId);
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

	/**
	 * Click-to-expand (C7) for the group's own summary line: flips this
	 * row's own expansion of its per-call breakdown, independent of the
	 * session-wide flag `setExpanded` tracks (`ctrl+o`) — clicking the
	 * summary never expands a sibling group, and a later `ctrl+o` still
	 * drives every untouched group's baseline exactly as before. Collapsing
	 * retracts any open subordinate call's card: a collapsed row has no
	 * room left to keep showing one (Component lifecycle constraints).
	 */
	toggleExpanded(): void {
		const effective = this.#rowExpanded ?? this.#expanded;
		this.#rowExpanded = !effective;
		this.#blockVersion++;
		this.#updateDisplay();
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
		super.invalidate();
	}

	/** C7's clickability predicate: every call is clickable, settled or not.
	 * Its card always shows more than the row — full arguments instead of the
	 * row's truncated `Tool(arg…)`, plus the result once there is one; a call
	 * opened while still running fills in its result in place, because
	 * {@link updateResult} forwards to the open card. */
	#clickable(): boolean {
		return this.#entries.size > 0;
	}

	/**
	 * Resolve the click target for one row-local index within this
	 * component's own last rendered output (0-indexed from its first row):
	 * the group's own summary line, a still-dimmed subordinate call line, or
	 * one of the currently open call's own card rows. `undefined` when that
	 * row carries no click target at all (a collapsed group's hidden rows).
	 * Shared by {@link getClickFocusAgentIds} and
	 * {@link getViewportClickAction} so hover and click always agree on
	 * exactly which row a given index means.
	 */
	#rowTarget(local: number): { id: string; onClick: () => void } | undefined {
		const entries = [...this.#entries.values()];
		if (entries.length <= 1) {
			const entry = entries[0];
			if (!entry) return undefined;
			if (this.#openCallId === entry.toolCallId) {
				// Any row of the open card closes it — mirrors "a second click on
				// any of that card's own rows returns it to the one-line form".
				return { id: entry.clickId, onClick: () => this.#closeOpenCard() };
			}

			return { id: entry.clickId, onClick: () => this.#openCall(entry.toolCallId) };
		}
		if (local <= 0) return { id: this.#clickId, onClick: () => this.toggleExpanded() };
		if (!(this.#rowExpanded ?? this.#expanded)) return undefined; // collapsed: only row 0 exists.
		let row = 1;
		for (const entry of entries) {
			const isOpen = this.#openCallId === entry.toolCallId;
			// An open call owns its header row plus every row of its card; a
			// click anywhere in that run closes it again.
			const span = isOpen ? 1 + Math.max(0, this.#lastCardRows) : 1;
			if (local < row + span) {
				if (isOpen) return { id: entry.clickId, onClick: () => this.#closeOpenCard() };
				return { id: entry.clickId, onClick: () => this.#openCall(entry.toolCallId) };
			}
			row += span;
		}
		return undefined;
	}

	/** Click-candidate id for hover banding (C7), resolved per row so
	 * hovering one call's own line inside an expanded group — or its open
	 * card, once opened (req 4) — bands only that line/card, never the
	 * whole group span (req 1). `local` is the row-local index within this
	 * component's own last rendered output; the single no-arg pre-check
	 * `Composer.renderFrame` makes resolves against row 0 (always the
	 * summary, or the only row, when nothing is hovered yet). */
	getClickFocusAgentIds(local?: number): string[] {
		const row = Number.isInteger(local) && (local as number) >= 0 ? (local as number) : 0;
		const target = this.#rowTarget(row);
		return target ? [target.id] : [];
	}

	/** Click action (C7), resolved per row: a click on the group's own
	 * summary line toggles the group; a click on one call's own line (or its
	 * open card) opens/closes just that call (req 4). `undefined` when
	 * nothing in this row/group is clickable. */
	getViewportClickAction(): ((local: number) => void) | undefined {
		if (!this.#clickable()) return undefined;
		return (local: number) => {
			const row = Number.isInteger(local) && local >= 0 ? local : 0;
			this.#rowTarget(row)?.onClick();
		};
	}

	/**
	 * Embed the stock `ToolExecutionComponent` card `full` mode would have
	 * built for this call (req 4), replacing its own one-line row. Reuses the
	 * class rather than duplicating its rendering; a no-op UI stands in for
	 * the live composer (`EMBEDDED_CARD_UI`) since opening flows entirely
	 * through a click, and `input-controller.ts`'s own handler already
	 * requests a render immediately after invoking it. A call still in flight
	 * opens to its arguments; its result lands via {@link updateResult},
	 * which forwards to the open card.
	 */
	#openCall(toolCallId: string): void {
		const entry = this.#entries.get(toolCallId);
		if (!entry || this.#openCallId === toolCallId) return;
		this.#closeOpenCardInternal();
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
		this.#openCallId = toolCallId;
		this.#openCard = card;
		this.#blockVersion++;
		this.#updateDisplay();
	}

	/** Close the open call's card (the "second click" of req 4). */
	#closeOpenCard(): void {
		if (this.#openCallId === undefined) return;
		this.#closeOpenCardInternal();
		this.#blockVersion++;
		this.#updateDisplay();
	}

	/** Dispose and detach the open card without touching `#blockVersion` or
	 * repainting — the caller (an explicit close, a group collapse, or a
	 * pruned entry) owns that. Disposing stops its spinner/ticker
	 * registration (Component lifecycle constraints); idempotent. */
	#closeOpenCardInternal(): void {
		if (this.#openCard) {
			this.#openCard.dispose();
			this.#openCard = undefined;
		}
		this.#openCallId = undefined;
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return [];
		const beforeLines = this.#beforeText.render(width);
		const cardLines = this.#openCard
			? this.#openCard.render(Math.max(1, width - NEST_INDENT.length)).map(line => `${NEST_INDENT}${line}`)
			: [];
		this.#lastCardRows = cardLines.length;
		const afterLines = this.#afterText.render(width);
		if (beforeLines.length === 0 && cardLines.length === 0 && afterLines.length === 0) return [];
		return [...beforeLines, ...cardLines, ...afterLines];
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
		// An open card holds the block in the mutable viewport even past a seal:
		// retirement prints the rows into native scrollback, where nothing can
		// retract them — the group would stay frozen open, unclickable, with no
		// way back to its one-liner. The closing click releases the hold.
		if (this.#openCallId !== undefined) return false;
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

	/**
	 * Lay out the group's collapsed summary and expanded per-call rows (C7's
	 * two-level expansion), then reconcile the child list with the open
	 * card, if any. `#openCallId` pointing at an entry that no longer exists
	 * (pruned via `removeEntry`) or at a now-collapsed group retracts the
	 * card here rather than at every call site that could cause it — this is
	 * the one place display state actually gets read for rendering.
	 */
	#updateDisplay(): void {
		if (this.#openCallId !== undefined && !this.#entries.has(this.#openCallId)) {
			this.#closeOpenCardInternal();
		}
		const entries = [...this.#entries.values()];
		let beforeLines: string[];
		const afterLines: string[] = [];
		if (entries.length > 1) {
			const expanded = this.#rowExpanded ?? this.#expanded;
			if (!expanded) {
				if (this.#openCallId !== undefined) this.#closeOpenCardInternal();
				beforeLines = [renderGroupLine(entries, false)];
			} else {
				beforeLines = [renderGroupLine(entries, true)];
				let sink = beforeLines;
				for (const entry of entries) {
					const isOpen = entry.toolCallId === this.#openCallId;
					const marker = rowMarker(isOpen ? "open" : "closed");
					// The open call keeps its own header above the card, so the row
					// that closes it again is on screen and marked `▾`.
					sink.push(dimLine(renderCallLine(entry, `${NEST_INDENT}${marker} `)));
					if (isOpen) sink = afterLines;
				}
			}
		} else {
			const entry = entries[0];
			if (!entry) beforeLines = [];
			else {
				const isOpen = this.#openCallId === entry.toolCallId;
				const marker = rowMarker(isOpen ? "open" : "closed");
				beforeLines = [renderCallLine(entry, `${marker} `)];
			}
		}
		this.#beforeText.setText(beforeLines.join("\n"));
		this.#afterText.setText(afterLines.join("\n"));
		this.#syncChildren();
	}

	/** Reconcile `this.children` with the open card's presence, through the
	 * base class's own `addChild`/`clear` so its `ignoreTight` propagation
	 * stays correct — `render` above reads `#beforeText`/`#openCard`/
	 * `#afterText` directly, but `dispose()` (inherited, cascading to every
	 * child) needs the open card in the child list to reach it. */
	#syncChildren(): void {
		this.clear();
		this.addChild(this.#beforeText);
		if (this.#openCard) this.addChild(this.#openCard);
		this.addChild(this.#afterText);
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
