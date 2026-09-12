/**
 * Compact and grouped tool-call rendering for `display.toolCalls`.
 *
 * `compact` shows one line per call — its resolved intent, outcome, output
 * size, and duration — instead of the full framed card. `grouped` additionally
 * folds a run of consecutive same-turn calls into a single collapsed row with
 * a count; expanding it reveals the same per-call lines `compact` always
 * shows. Both settings share this one component: a `compact` instance never
 * accretes past one entry, so it always renders the single-call line.
 *
 * Read calls that collapse into `ReadToolGroupComponent` keep that richer,
 * path-aware rendering unconditionally — the `display.toolCalls` branch
 * points (event-controller.ts, chat-transcript-builder.ts, ui-helpers.ts)
 * never route a collapsible read here.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { formatBytes, formatDuration } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { theme } from "../../modes/theme/theme";
import { formatArgsInline } from "../../tools/json-tree";
import type { ToolUIStatus } from "../../tools/render-utils";
import { renderStatusLine } from "../../tui";
import type { ToolExecutionHandle } from "./tool-execution";

/** Budget for the inline args preview that stands in for a missing intent. */
const ARGS_PREVIEW_WIDTH = 60;

type CallOutcome = "pending" | "success" | "error";

interface CompactCallEntry {
	toolCallId: string;
	label: string;
	tool: AgentTool | undefined;
	args: unknown;
	outcome: CallOutcome;
	sizeBytes?: number;
	durationMs?: number;
	startedAtNow?: number;
}

function isPlainArgs(args: unknown): args is Record<string, unknown> {
	return !!args && typeof args === "object" && !Array.isArray(args);
}

/** `tool.intent(args)`/the model's `i` field, or the label plus an args preview. */
function resolveCallIntent(entry: Pick<CompactCallEntry, "label" | "args" | "tool">): string {
	const { label, args, tool } = entry;
	if (isPlainArgs(args)) {
		const raw = args[INTENT_FIELD];
		if (typeof raw === "string" && raw.trim()) return raw.trim();
	}
	if (typeof tool?.intent === "function") {
		try {
			const derived = tool.intent(args as never)?.trim();
			if (derived) return derived;
		} catch {
			// Intent derivation must never break rendering.
		}
	}
	const preview = isPlainArgs(args) ? formatArgsInline(args, ARGS_PREVIEW_WIDTH) : "";
	return preview ? `${label} ${preview}` : label;
}

/** One line for one call: `⏺ Restarting the gateway  error · 128B · 2.2s`. */
function renderCallLine(entry: CompactCallEntry): string {
	const status: ToolUIStatus = entry.outcome === "pending" ? "pending" : entry.outcome === "error" ? "error" : "done";
	const meta = [entry.outcome === "pending" ? "running" : entry.outcome === "error" ? "error" : "ok"];
	if (entry.sizeBytes !== undefined) meta.push(formatBytes(entry.sizeBytes));
	if (entry.durationMs !== undefined) meta.push(formatDuration(Math.round(entry.durationMs)));
	return ` ${renderStatusLine({ icon: status, title: resolveCallIntent(entry), titleColor: "toolTitle", meta }, theme)}`;
}

/** One collapsed row for a run of calls: `⏺ 3 tool calls  1 failed · 6.1s`. */
function renderGroupLine(entries: readonly CompactCallEntry[]): string {
	const failed = entries.filter(entry => entry.outcome === "error").length;
	const pending = entries.filter(entry => entry.outcome === "pending").length;
	const meta: string[] = [];
	if (failed > 0) meta.push(`${failed} failed`);
	if (pending > 0) meta.push(`${pending} running`);
	if (failed === 0 && pending === 0) meta.push("ok");
	const totalBytes = entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
	if (totalBytes > 0) meta.push(formatBytes(totalBytes));
	const totalMs = entries.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0);
	if (totalMs > 0) meta.push(formatDuration(Math.round(totalMs)));
	const status: ToolUIStatus = pending > 0 ? "pending" : failed > 0 ? "error" : "done";
	return ` ${renderStatusLine({ icon: status, title: `${entries.length} tool calls`, titleColor: "toolTitle", meta }, theme)}`;
}

/**
 * Compact (`display.toolCalls: "compact"`) and grouped (`"grouped"`) tool-call
 * row: one line per call, or — once a second call joins the same group — one
 * collapsed summary row carrying the call count. Expanded (ctrl+o), a group
 * always renders one line per call. Multi-entry, toolCallId-keyed
 * `ToolExecutionHandle`, mirroring `ReadToolGroupComponent`'s shape.
 */
export class CompactToolCallComponent extends Container implements ToolExecutionHandle {
	#entries = new Map<string, CompactCallEntry>();
	#text: Text;
	#expanded = false;
	#toolActivityVisible = true;
	#sealed = false;
	#blockVersion = 0;

	constructor() {
		super();
		this.#text = new Text("", 0, 0);
		this.addChild(this.#text);
	}

	/** Add a new call to this row/group. */
	addCall(toolCallId: string, label: string, args: unknown, tool: AgentTool | undefined): void {
		this.#entries.set(toolCallId, { toolCallId, label, tool, args, outcome: "pending" });
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
		if (entry && entry.startedAtNow === undefined) entry.startedAtNow = performance.now();
	}

	updateResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		isPartial = false,
		toolCallId?: string,
	): void {
		if (!toolCallId || isPartial) return;
		const entry = this.#entries.get(toolCallId);
		if (!entry) return;
		const text = result.content
			?.filter(block => block.type === "text")
			.map(block => block.text ?? "")
			.join("\n");
		entry.sizeBytes = text ? Buffer.byteLength(text, "utf-8") : undefined;
		entry.outcome = result.isError ? "error" : "success";
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

	seal(): void {
		this.#sealed = true;
	}

	isTranscriptBlockFinalized(): boolean {
		if (this.#sealed) return true;
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
 * Get-or-create the `display.toolCalls` handle for a new call, add the call
 * to it, and — for the three creation sites that can settle a call before it
 * ever goes pending (an assistant turn that starts with an error) — apply
 * that immediate result. `grouped` extends `holder.current` while it is
 * still `container`'s tail (nothing else was appended since); anything else,
 * including `compact`, starts a fresh one. Returns `pending: false` when
 * `immediateError` already settled the call, so the caller skips tracking it
 * as pending.
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
	const reused = mode === "grouped" && !!holder.current && container.children.at(-1) === holder.current;
	const group = reused ? holder.current! : new CompactToolCallComponent();
	if (!reused) {
		group.setExpanded(expanded);
		container.addChild(group);
	}
	holder.current = mode === "grouped" ? group : undefined;
	group.addCall(toolCallId, tool?.label ?? toolName, args, tool);
	if (immediateError === undefined) return { group, pending: true };
	group.updateResult({ content: [{ type: "text", text: immediateError }], isError: true }, false, toolCallId);
	return { group, pending: false };
}
