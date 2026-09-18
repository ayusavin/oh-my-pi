/**
 * Per-action Normal tool-call rendering for `display.toolCalls`.
 *
 * Compact mode mounts one row for every call. Each row is admitted immediately,
 * remains transcript-live only while its own result is pending, and can expand
 * its own full card without affecting adjacent calls. `ReadToolGroupComponent`
 * remains the Verbose-only read path.
 */
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
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
import type { AnimationFrame, TranscriptPresentationTarget } from "./transcript-container";

type CallOutcome = "pending" | "success" | "error";

/** Content shape `updateResult` accepts and stores verbatim so an expanded row
 * replays the exact `ToolExecutionComponent` card, including image blocks. */
export interface CompactCallResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
}

interface CompactCallEntry {
	toolCallId: string;
	/** Canonical renderer key (`toolRenderName`'s output). */
	toolName: string;
	label: string;
	tool: AgentTool | undefined;
	args: unknown;
	/** Human-readable per-action purpose. */
	intent: string;
	intentSource: "live" | "argument" | "summary";
	/** A live execution event takes precedence over streamed `args.i`. */
	liveIntent?: string;
	outcome: CallOutcome;
	/** Full joined text of the settled result; errors show only its first line. */
	resultText?: string;
	/** A renderer-defined one-line success summary. */
	resultSummary?: string;
	/** Verbatim settled result, replayed into the full card while expanded. */
	rawResult?: CompactCallResult;
	durationMs?: number;
	startedAtNow?: number;
}

/** Tools whose settled completion is worth a duration on the row. */
const SUBAGENT_TOOL_NAMES: Record<string, true> = { task: true };

const GENERIC_ARG_KEYS = ["command", "path", "input"] as const;

/** Tools whose useful primary argument is not the generic first scalar. */
const PRIMARY_ARG_KEYS: Record<string, readonly string[]> = {
	glob: ["path", "pattern"],
	grep: ["pattern", "path"],
	web_search: ["query"],
};

/** The primary action target keeps this many columns before intent begins. */
const PRIMARY_TARGET_WIDTH = 40;

/** Full cards sit under their compact row. */
const NEST_INDENT = "   ";

function isPlainArgs(args: unknown): args is Record<string, unknown> {
	return !!args && typeof args === "object" && !Array.isArray(args);
}

/** The same scalar target fallback used by `ToolExecutionComponent`. */
function genericPrimaryArgument(toolName: string, args: unknown): string | undefined {
	if (!isPlainArgs(args)) return undefined;
	for (const key of PRIMARY_ARG_KEYS[toolName] ?? GENERIC_ARG_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value.split("\n", 1)[0];
	}
	return undefined;
}

/** Reuse each tool renderer's own activity target before falling back. */
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
			if (summary) {
				const label = summary.label.toLowerCase() === entry.toolName.toLowerCase() ? entry.label : summary.label;
				return { ...summary, label };
			}
		} catch {
			// A renderer hint must never break transcript rendering.
		}
	}
	const detail = genericPrimaryArgument(entry.toolName, entry.args);
	return detail ? { label: entry.label, detail } : { label: entry.label };
}

/** Bound the action target independently so a long intent cannot hide it. */
function formatPrimaryText(summary: ToolActivitySummary): string {
	const flattened = summary.detail?.replace(/\s+/g, " ").trim();
	const text = flattened ? `${summary.label}(${flattened})` : summary.label;
	return truncateToWidth(text, PRIMARY_TARGET_WIDTH, Ellipsis.Unicode);
}

interface CompactIntent {
	text: string;
	source: CompactCallEntry["intentSource"];
}

function normalizedIntentText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/g, " ").trim();
	return text || undefined;
}

function resolveCompactIntent(
	entry: Pick<CompactCallEntry, "toolName" | "label" | "args" | "outcome">,
	liveIntent?: unknown,
): CompactIntent {
	const live = normalizedIntentText(liveIntent);
	if (live) return { text: live, source: "live" };
	const argumentIntent = isPlainArgs(entry.args) ? normalizedIntentText(entry.args[INTENT_FIELD]) : undefined;
	if (argumentIntent) return { text: argumentIntent, source: "argument" };
	const summary = resolveActivitySummary(entry);
	return { text: normalizedIntentText(summary.detail) ?? summary.label, source: "summary" };
}

function formatIntentText(entry: CompactCallEntry): string {
	return truncateToWidth(entry.intent, TRUNCATE_LENGTHS.TITLE, Ellipsis.Unicode);
}

/** Text state + action target first, followed by a bounded explanation. */
function activityTitle(entry: CompactCallEntry): string {
	const state =
		entry.outcome === "pending"
			? entry.startedAtNow === undefined
				? "queued"
				: "running"
			: entry.outcome === "error"
				? "failed"
				: "done";
	const primary = formatPrimaryText(resolveActivitySummary(entry));
	const action = entry.intentSource === "summary" ? primary : `${primary} — ${formatIntentText(entry)}`;
	return `${state} ${action}`;
}

/** First line of a failed call's error text, bounded like a regular row. */
function firstErrorLine(text: string | undefined): string | undefined {
	const line = (text ?? "")
		.replace(/^Error:\s*/, "")
		.split("\n", 1)[0]
		?.trim();
	return line ? truncateToWidth(line, TRUNCATE_LENGTHS.LINE, Ellipsis.Unicode) : undefined;
}

/** Compact row state, target, intent, and settled result/error summary. */
function renderCallLine(entry: CompactCallEntry, expanded: boolean): string {
	const status: ToolUIStatus = entry.outcome === "pending" ? "pending" : entry.outcome === "error" ? "error" : "done";
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
	return `${theme.fg("dim", expanded ? "▾" : "▸")} ${renderStatusLine({ icon: status, title: activityTitle(entry), titleColor: "toolTitle", meta }, theme)}`;
}

/** No-op `ToolExecutionUi` for compact-row full cards. */
const EMBEDDED_CARD_UI: ToolExecutionUi = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
};

let nextCompactToggleId = 1;

class CompactToolCallHistoryTarget {
	constructor(readonly component: CompactToolCallComponent) {}
}

export function resolveCompactToolCallHistoryTarget(target: object): CompactToolCallComponent | undefined {
	return target instanceof CompactToolCallHistoryTarget ? target.component : undefined;
}

/**
 * One admitted compact tool call. A component cannot accept a second call, so
 * no generic transcript frontier can be held by multiple actions.
 */
export class CompactToolCallComponent
	extends Container
	implements ToolExecutionHandle, HistoryRowTargetProvider, TranscriptPresentationTarget
{
	#entry: CompactCallEntry | undefined;
	#lastParentRowCount = 0;
	#allocation = Number.MAX_SAFE_INTEGER;
	#parentText: Text;
	#parentRow = "";
	/** Kept id-keyed so a streamed provisional id can migrate atomically. */
	#cards = new Map<string, ToolExecutionComponent>();
	/** Session-wide Verbose expansion. */
	#expanded = false;
	/** Local click override; a global expansion always dominates it. */
	#rowExpanded: boolean | undefined;
	#clickId = `@omp:compact-toggle:${nextCompactToggleId++}`;
	#historyTarget = new CompactToolCallHistoryTarget(this);
	#toolActivityVisible = true;
	/** Admission ends as soon as this component receives its sole call. */
	#admissionFinalized = false;
	/** Explicit abandoned-turn terminal state. */
	#sealed = false;
	#blockVersion = 0;

	constructor() {
		super();
		this.#parentText = new Text("", 0, 0);
		this.addChild(this.#parentText);
	}

	/** Admit this component's sole call. A second admission is a programmer error. */
	addCall(
		toolCallId: string,
		toolName: string,
		label: string,
		args: unknown,
		tool: AgentTool | undefined,
		liveIntent?: string,
	): void {
		if (this.#entry) throw new Error("CompactToolCallComponent accepts exactly one tool call");
		const entry: CompactCallEntry = {
			toolCallId,
			toolName,
			label,
			tool,
			args,
			intent: "",
			intentSource: "summary",
			liveIntent: normalizedIntentText(liveIntent),
			outcome: "pending",
		};
		this.#refreshIntent(entry);
		this.#entry = entry;
		this.#admissionFinalized = true;
		this.#updateDisplay();
	}

	/** Rename a streamed provisional id before completion routing settles it. */
	migrateToolCallId(oldId: string, newId: string): boolean {
		const entry = this.#entry;
		if (!entry || entry.toolCallId !== oldId || oldId === newId || !newId) return false;
		entry.toolCallId = newId;
		const card = this.#cards.get(oldId);
		if (card) {
			this.#cards.delete(oldId);
			this.#cards.set(newId, card);
		}
		this.#updateDisplay();
		return true;
	}

	/**
	 * Keep this streamed row at its original transcript position while adopting
	 * the authoritative final-id call that started or settled first.
	 */
	adoptAuthoritativeCall(authoritative: CompactToolCallComponent, provisionalId: string, finalId: string): boolean {
		const entry = this.#entry;
		const authoritativeEntry = authoritative.#entry;
		if (
			this === authoritative ||
			!entry ||
			!authoritativeEntry ||
			entry.toolCallId !== provisionalId ||
			authoritativeEntry.toolCallId !== finalId ||
			provisionalId === finalId ||
			!finalId
		) {
			return false;
		}
		entry.toolCallId = finalId;
		entry.toolName = authoritativeEntry.toolName;
		entry.label = authoritativeEntry.label;
		entry.tool = authoritativeEntry.tool;
		entry.args = authoritativeEntry.args;
		entry.intent = authoritativeEntry.intent;
		entry.intentSource = authoritativeEntry.intentSource;
		entry.liveIntent = authoritativeEntry.liveIntent;
		entry.outcome = authoritativeEntry.outcome;
		entry.resultText = authoritativeEntry.resultText;
		entry.resultSummary = authoritativeEntry.resultSummary;
		entry.rawResult = authoritativeEntry.rawResult;
		entry.durationMs = authoritativeEntry.durationMs;
		entry.startedAtNow = authoritativeEntry.startedAtNow;
		this.#admissionFinalized = authoritative.#admissionFinalized;
		this.#sealed = authoritative.#sealed;
		this.#disposeCards();
		this.#blockVersion++;
		this.#updateDisplay();
		return true;
	}

	updateArgs(args: unknown, toolCallId?: string): void {
		const entry = this.#entry;
		if (!toolCallId || !entry || entry.toolCallId !== toolCallId || entry.args === args) return;
		entry.args = args;
		if (!entry.liveIntent) this.#refreshIntent(entry);
		this.#cards.get(toolCallId)?.updateArgs(args, toolCallId);
		this.#updateDisplay();
	}

	/** Refine a streamed fallback with the authoritative execution intent. */
	updateIntent(intent: unknown, toolCallId?: string): void {
		const entry = this.#entry;
		const liveIntent = normalizedIntentText(intent);
		if (!toolCallId || !entry || entry.toolCallId !== toolCallId || !liveIntent || entry.liveIntent === liveIntent)
			return;
		entry.liveIntent = liveIntent;
		this.#refreshIntent(entry);
		this.#updateDisplay();
	}

	setArgsComplete(_toolCallId?: string): void {}

	setExecutionStarted(toolCallId?: string): void {
		const entry = this.#entry;
		if (!toolCallId || !entry || entry.toolCallId !== toolCallId || entry.startedAtNow !== undefined) return;
		entry.startedAtNow = performance.now();
		this.#cards.get(toolCallId)?.setExecutionStarted(toolCallId);
		this.#updateDisplay();
	}

	/** Settle this call once; later duplicate terminal events are harmless. */
	updateResult(result: CompactCallResult, isPartial = false, toolCallId?: string): void {
		const entry = this.#entry;
		if (!toolCallId || isPartial || !entry || entry.toolCallId !== toolCallId || entry.outcome !== "pending") return;
		entry.outcome = result.isError ? "error" : "success";
		entry.resultText = result.content
			.filter(block => block.type === "text")
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

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) this.#blockVersion++;
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	setTranscriptAllocation(rows: number, _frame: AnimationFrame): void {
		this.#allocation = Math.max(0, Math.trunc(rows));
	}

	/** Toggle only this call's full card. */
	toggleExpanded(fullRepaintRequested = false): void {
		if (!this.#entry) return;
		const expanded = !this.#effectiveExpanded();
		if (this.#rowExpanded === expanded) return;
		this.#rowExpanded = expanded;
		this.#blockVersion++;
		logger.debug("compact tool row toggle", { toolCallId: this.#entry.toolCallId, expanded, fullRepaintRequested });
		this.#updateDisplay();
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
		super.invalidate();
	}

	#effectiveExpanded(): boolean {
		return this.#expanded || this.#rowExpanded === true;
	}

	#isParentRow(local: number): boolean {
		if (!this.#toolActivityVisible || !this.#entry || !Number.isInteger(local) || local < 0 || !this.#parentRow) {
			return false;
		}
		return this.#lastParentRowCount === 0 ? local === 0 : local < this.#lastParentRowCount;
	}

	historyRowTarget(local: number): object | undefined {
		return this.#isParentRow(local) ? this.#historyTarget : undefined;
	}

	#rowTarget(local: number, fullRepaintRequested = false): { id: string; onClick: () => void } | undefined {
		if (!this.#isParentRow(local)) return undefined;
		return { id: this.#clickId, onClick: () => this.toggleExpanded(fullRepaintRequested) };
	}

	getClickFocusAgentIds(local?: number): string[] {
		const row = Number.isInteger(local) && (local as number) >= 0 ? (local as number) : 0;
		const target = this.#rowTarget(row);
		return target ? [target.id] : [];
	}

	getViewportClickAction(): ((local: number, fullRepaintRequested?: boolean) => void) | undefined {
		if (!this.#entry) return undefined;
		return (local: number, fullRepaintRequested?: boolean) => {
			const row = Number.isInteger(local) && local >= 0 ? local : 0;
			this.#rowTarget(row, fullRepaintRequested)?.onClick();
		};
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible || this.#allocation === 0) {
			this.#lastParentRowCount = 0;
			return [];
		}
		const parentLines = this.#parentText.render(width);
		const parentRows = Math.min(parentLines.length, this.#allocation);
		this.#lastParentRowCount = parentRows;
		if (parentRows < parentLines.length) return parentLines.slice(0, parentRows);
		if (!this.#effectiveExpanded()) return parentLines;

		const details = this.#fullCardLines(width);
		const output = [...parentLines, ...details];
		if (output.length <= this.#allocation) return output;

		const detailRows = this.#allocation - parentLines.length;
		if (detailRows === 0) return parentLines;
		const visibleDetails = Math.max(0, detailRows - 1);
		const omittedDetails = details.length - visibleDetails;
		const indicator = truncateToWidth(
			`${NEST_INDENT}${theme.fg("dim", `… ${omittedDetails} detail row${omittedDetails === 1 ? "" : "s"} omitted`)}`,
			Math.max(0, width),
		);
		return [...parentLines, indicator, ...details.slice(details.length - visibleDetails)];
	}

	parkAsBackground(): void {}

	/** Admission is automatic; retained for the generic handle lifecycle. */
	finalize(): void {
		this.#admissionFinalized = true;
	}

	/** An abandoned turn has no result to wait for. */
	seal(): void {
		this.#sealed = true;
	}

	isTranscriptBlockFinalized(): boolean {
		const entry = this.#entry;
		return this.#sealed || (this.#admissionFinalized && entry !== undefined && entry.outcome !== "pending");
	}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	getComponent(): Component {
		return this;
	}

	#refreshIntent(entry: CompactCallEntry): void {
		const intent = resolveCompactIntent(entry, entry.liveIntent);
		entry.intent = intent.text;
		entry.intentSource = intent.source;
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
		if (entry.startedAtNow !== undefined) card.setExecutionStarted(entry.toolCallId);
		if (entry.rawResult) card.updateResult(entry.rawResult, false, entry.toolCallId);
		return card;
	}

	#syncCards(expanded: boolean): void {
		const entry = this.#entry;
		if (!expanded || !entry) {
			this.#disposeCards();
			return;
		}
		for (const [toolCallId, card] of this.#cards) {
			if (toolCallId === entry.toolCallId) continue;
			card.dispose();
			this.#cards.delete(toolCallId);
		}
		if (!this.#cards.has(entry.toolCallId)) this.#cards.set(entry.toolCallId, this.#createCard(entry));
	}

	#disposeCards(): void {
		for (const card of this.#cards.values()) card.dispose();
		this.#cards.clear();
	}

	#fullCardLines(width: number): string[] {
		const entry = this.#entry;
		if (!entry) return [];
		const card = this.#cards.get(entry.toolCallId);
		if (!card) return [];
		return card.render(Math.max(1, width - NEST_INDENT.length)).map(line => `${NEST_INDENT}${line}`);
	}

	#updateDisplay(): void {
		this.#lastParentRowCount = 0;
		const entry = this.#entry;
		this.#parentRow = entry ? renderCallLine(entry, this.#effectiveExpanded()) : "";
		this.#parentText.setText(this.#parentRow);
		this.#syncCards(this.#effectiveExpanded());
		this.clear();
		this.addChild(this.#parentText);
		if (entry) {
			const card = this.#cards.get(entry.toolCallId);
			if (card) this.addChild(card);
		}
	}
}

/** `compact` is the sole Normal mode; every other value uses full cards. */
export function compactToolCallMode(value: unknown): "compact" | undefined {
	return value === "compact" ? value : undefined;
}

/** Mount one finalized-to-admission compact component for one tool call. */
export function mountCompactToolCall(
	container: Container,
	expanded: boolean,
	toolCallId: string,
	toolName: string,
	args: unknown,
	tool: AgentTool | undefined,
	intent?: string,
	immediateError?: string,
): { component: CompactToolCallComponent; pending: boolean } {
	const component = new CompactToolCallComponent();
	component.addCall(toolCallId, toolName, tool?.label ?? toolName, args, tool, intent);
	component.finalize();
	component.setExpanded(expanded);
	container.addChild(component);
	if (immediateError === undefined) return { component, pending: true };
	component.updateResult({ content: [{ type: "text", text: immediateError }], isError: true }, false, toolCallId);
	return { component, pending: false };
}
