/**
 * One-line ("compact") and per-turn ("grouped") tool-call rendering.
 *
 * `display.toolCalls` selects between the CLI's own card (`full`, the default —
 * nothing here runs), a single collapsed line per call (`compact`), and one
 * summary row per run of consecutive calls in a turn (`grouped`). The builders
 * below are pure string formatters so they can be exercised without a TUI; the
 * choke points that call them are ToolExecutionComponent.render (every tool,
 * bespoke frame or not) and ToolCallGroupComponent.render.
 */

import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { pluralize } from "@oh-my-pi/pi-utils";
import { isSettingsInitialized, settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";
import type { Theme } from "../modes/theme/theme";
import { formatStatusIcon } from "./render-utils";

export type ToolCallDisplayMode = "full" | "compact" | "grouped";

/** Active `display.toolCalls`; `full` before settings are initialized. */
export function resolveToolCallDisplay(): ToolCallDisplayMode {
	const activeSettings = isSettingsInitialized() ? settings : undefined;
	return activeSettings?.get("display.toolCalls") ?? getDefault("display.toolCalls");
}

/**
 * Ctrl+O steps through three levels when `display.toolCalls` is not `full`:
 * 0 = collapsed (group row, or one line per call under `compact`), 1 = one line
 * per call, 2 = the CLI's own expanded card. Level 2 is the only level that
 * sets the existing `toolOutputExpanded` flag, so expanded rendering is
 * byte-identical to today's. Module state rather than context state because the
 * renderers that consume it are reached through no context (same reason
 * `resolveCollapsedPreviewLines` reads `settings` directly).
 */
let expandLevel = 0;

export function toolCallExpandLevel(): number {
	return expandLevel;
}

export function setToolCallExpandLevel(level: number): void {
	expandLevel = Math.max(0, Math.min(2, level));
}

export type ToolCallOutcome = "ok" | "error" | "running" | "pending" | "skipped";

/** Everything one collapsed line says about a call. */
export interface CollapsedToolCall {
	/** Tool label, used when no intent is available and for group phrasing. */
	label: string;
	/** Registry name, used to bucket calls in a group summary. */
	toolName: string;
	/** `tool.intent(args)` or the model-supplied `i` field, when present. */
	intent?: string;
	/** Inline args preview standing in for a missing intent. */
	argsPreview?: string;
	outcome: ToolCallOutcome;
	/** First line of the failure message, when the call failed. */
	errorFirstLine?: string;
	exitCode?: number;
	/** Output size in lines; omitted when there is no output. */
	lines?: number;
	durationMs?: number;
	spinnerFrame?: number;
}

function statusIconFor(call: CollapsedToolCall, theme: Theme): string {
	switch (call.outcome) {
		case "error":
			return formatStatusIcon("error", theme);
		case "running":
			return formatStatusIcon("running", theme, call.spinnerFrame);
		case "pending":
			return formatStatusIcon("pending", theme);
		case "skipped":
			return formatStatusIcon("info", theme);
		default:
			return formatStatusIcon("done", theme);
	}
}

/** Below this a duration reads as 0.0s, which is noise on every line. */
const MIN_REPORTED_MS = 50;

function formatSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Outcome word: an exit code where the tool reports one, else ok/failed/state. */
function outcomeText(call: CollapsedToolCall): string {
	switch (call.outcome) {
		case "running":
			return "running";
		case "pending":
			return "pending";
		case "skipped":
			return "skipped";
		case "error": {
			if (typeof call.exitCode === "number") return `exit ${call.exitCode}`;
			const detail = call.errorFirstLine?.trim();
			return detail ? `failed: ${detail}` : "failed";
		}
		default:
			return "ok";
	}
}

/** Title half of the line: the call's intent, or the tool label plus its args preview. */
function callTitle(call: CollapsedToolCall): string {
	const intent = call.intent?.trim();
	if (intent) return intent;
	const preview = call.argsPreview?.trim();
	return preview ? `${call.label} ${preview}` : call.label;
}

/**
 * One line for one call: `⏺ Reading the memory-provider docs · ok · 25 lines · 0.4s`.
 * Never wraps — the caller's width is a hard cap.
 */
export function buildCollapsedToolCallLine(call: CollapsedToolCall, theme: Theme, width: number): string {
	const meta = [outcomeText(call)];
	if (call.lines !== undefined && call.lines > 0) meta.push(`${call.lines} ${pluralize("line", call.lines)}`);
	if (call.durationMs !== undefined && call.durationMs >= MIN_REPORTED_MS) meta.push(formatSeconds(call.durationMs));
	const title = theme.fg("toolTitle", theme.bold(callTitle(call).replace(/\s+/g, " ")));
	const tail = theme.fg("muted", meta.join(theme.sep.dot));
	return truncateToWidth(`${statusIconFor(call, theme)} ${title}${theme.sep.dot}${tail}`, Math.max(1, width));
}

/** Verb phrase per tool family; anything unlisted counts by its own label. */
function bucketPhrase(toolName: string, label: string, count: number): string {
	switch (toolName) {
		case "bash":
		case "bash_interactive":
		case "eval":
		case "run_code":
			return `ran ${count} ${pluralize("command", count)}`;
		case "read":
		case "read_archive":
			return `read ${count} ${pluralize("file", count)}`;
		case "write":
		case "edit":
		case "apply_patch":
			return `edited ${count} ${pluralize("file", count)}`;
		case "grep":
		case "glob":
		case "ast_grep":
			return `searched ${count} ${pluralize("time", count)}`;
		default:
			return `${count} ${label.toLowerCase()} ${pluralize("call", count)}`;
	}
}

/** `Ran 3 commands, read 1 file` — buckets in first-appearance order. */
export function summarizeToolCalls(calls: readonly CollapsedToolCall[]): string {
	const order: string[] = [];
	const counts = new Map<string, { label: string; count: number }>();
	for (const call of calls) {
		const seen = counts.get(call.toolName);
		if (seen) {
			seen.count++;
			continue;
		}
		order.push(call.toolName);
		counts.set(call.toolName, { label: call.label, count: 1 });
	}
	const phrases = order.map(name => {
		const entry = counts.get(name)!;
		return bucketPhrase(name, entry.label, entry.count);
	});
	const joined = phrases.join(", ");
	return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** One row for a run of calls: `⏺ Ran 3 commands, read 1 file · 1 failed · 6.1s`. */
export function buildGroupedToolCallLine(calls: readonly CollapsedToolCall[], theme: Theme, width: number): string {
	const failed = calls.filter(call => call.outcome === "error").length;
	const running = calls.filter(call => call.outcome === "running" || call.outcome === "pending").length;
	const totalMs = calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0);
	const meta: string[] = [];
	if (failed > 0) meta.push(`${failed} failed`);
	if (running > 0) meta.push(`${running} running`);
	if (meta.length === 0) meta.push("ok");
	if (totalMs >= MIN_REPORTED_MS) meta.push(formatSeconds(totalMs));
	const icon = formatStatusIcon(
		failed > 0 ? "error" : running > 0 ? "running" : "done",
		theme,
		calls.find(call => call.spinnerFrame !== undefined)?.spinnerFrame,
	);
	const title = theme.fg("toolTitle", theme.bold(summarizeToolCalls(calls)));
	const tail = theme.fg("muted", meta.join(theme.sep.dot));
	return truncateToWidth(`${icon} ${title}${theme.sep.dot}${tail}`, Math.max(1, width));
}
