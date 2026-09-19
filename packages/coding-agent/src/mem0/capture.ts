import { isRecord } from "@oh-my-pi/pi-utils";
import type { Mem0TerminalEntry } from "./admission";
import type { Mem0TerminalCheckpoint } from "./types";

export interface Mem0TranscriptMessage {
	role?: string;
	content?: unknown;
	stopReason?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	useless?: boolean;
	details?: unknown;
}

export interface Mem0TranscriptEntry {
	id: string;
	timestamp: string;
	type: string;
	message?: Mem0TranscriptMessage;
}

export interface Mem0TerminalCapture {
	terminalEntryId: string;
	observedAt: string;
	entries: Mem0TerminalEntry[];
}

function textBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const blocks: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		blocks.push(block.text);
	}
	return blocks.join("\n");
}

function sourcePathFromDetails(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	if (typeof details.resolvedPath === "string" && details.resolvedPath) return details.resolvedPath;
	if (!isRecord(details.meta) || !isRecord(details.meta.source)) return undefined;
	const source = details.meta.source;
	return source.type === "path" && typeof source.value === "string" && source.value ? source.value : undefined;
}

/**
 * Return the verified filesystem source recorded by built-in tool output. A
 * plain read uses `details.meta.source.value`; corrected or derived reads use
 * `details.resolvedPath`.
 */
export function toolResultSourcePath(message: Mem0TranscriptMessage): string | undefined {
	return message.role === "toolResult" ? sourcePathFromDetails(message.details) : undefined;
}

function terminalAssistantIndex(branch: readonly Mem0TranscriptEntry[]): number {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") return -1;
		return textBlocks(entry.message.content).trim() ? index : -1;
	}
	return -1;
}

/**
 * Find the newest persisted terminal checkpoint that is an ancestor of the
 * current branch's completed assistant turn. Checkpoints from another branch
 * are deliberately ignored.
 */
export function terminalCheckpointForBranch(
	branch: readonly Mem0TranscriptEntry[],
	checkpoints: readonly Mem0TerminalCheckpoint[],
	sessionId: string,
): string | undefined {
	const terminalIndex = terminalAssistantIndex(branch);
	if (terminalIndex < 0) return undefined;
	const entryIndex = new Map<string, number>();
	for (let index = 0; index <= terminalIndex; index++) entryIndex.set(branch[index]!.id, index);
	let checkpointId: string | undefined;
	let checkpointIndex = -1;
	for (const checkpoint of checkpoints) {
		if (checkpoint.sessionId !== sessionId) continue;
		const index = entryIndex.get(checkpoint.terminalEntryId);
		if (index === undefined || index <= checkpointIndex) continue;
		checkpointId = checkpoint.terminalEntryId;
		checkpointIndex = index;
	}
	return checkpointId;
}

/**
 * Build the new, completed terminal segment after a durable checkpoint. Hidden
 * developer continuation messages establish the new turn boundary but are not
 * retained as user or assistant facts themselves.
 */
export function terminalEntriesSinceCheckpoint(
	branch: readonly Mem0TranscriptEntry[],
	checkpointEntryId?: string,
): Mem0TerminalCapture | undefined {
	const terminalIndex = terminalAssistantIndex(branch);
	if (terminalIndex < 0) return undefined;

	const checkpointIndex = checkpointEntryId ? branch.findIndex(entry => entry.id === checkpointEntryId) : -1;
	if (checkpointIndex >= terminalIndex) return undefined;

	const entries: Mem0TerminalEntry[] = [];
	for (const entry of branch.slice(checkpointIndex + 1, terminalIndex + 1)) {
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (message.role === "user") {
			entries.push({ id: entry.id, timestamp: entry.timestamp, kind: "user", content: textBlocks(message.content) });
		} else if (message.role === "assistant") {
			entries.push({ id: entry.id, timestamp: entry.timestamp, kind: "assistant", content: textBlocks(message.content) });
		} else if (message.role === "toolResult") {
			entries.push({
				id: entry.id,
				timestamp: entry.timestamp,
				kind: "tool",
				content: textBlocks(message.content),
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				isError: message.isError,
				useless: message.useless,
				sourcePath: toolResultSourcePath(message),
			});
		}
	}

	const terminal = branch[terminalIndex]!;
	return { terminalEntryId: terminal.id, observedAt: terminal.timestamp, entries };
}
