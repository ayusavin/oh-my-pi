import { admitMem0TerminalTurn, type Mem0AdmittedPayload } from "./admission";
import { terminalCheckpointForBranch, terminalEntriesSinceCheckpoint, type Mem0TranscriptEntry } from "./capture";
import type { Mem0Config } from "./config";
import { Mem0Outbox } from "./outbox";
import type { Mem0TextRedactor } from "./redact";
import type { Mem0OutboxEntry, Mem0TerminalCheckpoint } from "./types";

export interface Mem0TerminalCapturePersistence {
	outbox: Mem0Outbox;
	repositoryId: string;
	sessionId: string;
	branch: readonly Mem0TranscriptEntry[];
	expectedTerminalEntryId: string;
	config: Pick<Mem0Config, "captureMaxChars" | "toolResultMaxChars" | "toolResultAllowlist" | "identity">;
	redact: Mem0TextRedactor;
	canPersist(): boolean;
	newOutboxEntry(admitted: Mem0AdmittedPayload): Mem0OutboxEntry;
	onOutboxRejected(): void;
	onQueued(): void;
}

/** Persist an already accepted terminal segment without taking ownership of dispatch. */
export async function persistAcceptedMem0TerminalCapture(input: Mem0TerminalCapturePersistence): Promise<void> {
	const document = await input.outbox.snapshot();
	if (!input.canPersist()) return;
	const checkpointId = terminalCheckpointForBranch(input.branch, document.terminalCheckpoints, input.sessionId);
	const turn = terminalEntriesSinceCheckpoint(input.branch, checkpointId);
	if (!turn || turn.terminalEntryId !== input.expectedTerminalEntryId) return;
	const acceptedEntryIds = new Set<string>();
	for (const entry of document.entries) {
		for (const entryId of entry.source.sourceEntryIds) acceptedEntryIds.add(entryId);
	}
	const newEntries = turn.entries.filter(entry => !acceptedEntryIds.has(entry.id));
	if (newEntries.length === 0) return;
	const admitted = admitMem0TerminalTurn({
		repositoryId: input.repositoryId,
		sessionId: input.sessionId,
		observedAt: turn.observedAt,
		entries: newEntries,
		maxChars: input.config.captureMaxChars,
		toolResultMaxChars: input.config.toolResultMaxChars,
		toolResultAllowlist: input.config.toolResultAllowlist,
		identity: input.config.identity,
		redact: input.redact,
	});
	if (admitted.length === 0) return;
	const entries = admitted.map(item => input.newOutboxEntry(item));
	const checkpoint: Mem0TerminalCheckpoint = {
		sessionId: input.sessionId,
		terminalEntryId: turn.terminalEntryId,
		ingestKeys: entries.map(entry => entry.ingestKey),
		createdAt: new Date().toISOString(),
	};
	if (!input.canPersist()) return;
	if (!(await input.outbox.enqueue(entries, checkpoint))) {
		const latest = await input.outbox.snapshot();
		const wasPersisted = latest.terminalCheckpoints.some(
			item => item.sessionId === input.sessionId && item.terminalEntryId === turn.terminalEntryId,
		);
		if (!wasPersisted) input.onOutboxRejected();
		return;
	}
	input.onQueued();
}
