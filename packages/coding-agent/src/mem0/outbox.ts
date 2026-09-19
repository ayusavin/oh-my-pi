import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireFileLock, isRecord, openSqliteDatabase, withFileLockSync } from "@oh-my-pi/pi-utils";
import type {
	Mem0AddRequest,
	Mem0Message,
	Mem0OutboxDocument,
	Mem0OutboxEntry,
	Mem0OutboxState,
	Mem0SourceRef,
	Mem0TerminalCheckpoint,
} from "./types";

const OUTBOX_VERSION = 1 as const;
const TERMINAL_CHECKPOINT_CAP = 1_024;
const COMPLETED_INGEST_KEY_CAP = 2_048;
const dispatchLockKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS mem0_outbox_entries (
	id TEXT PRIMARY KEY,
	ingest_key TEXT NOT NULL UNIQUE,
	repository_id TEXT NOT NULL,
	request_json TEXT NOT NULL,
	source_json TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('queued', 'dispatching', 'pending', 'unknown', 'failed', 'committed')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	attempts INTEGER NOT NULL CHECK (attempts >= 0),
	event_id TEXT,
	remote_ids_json TEXT,
	error_code TEXT,
	dispatch_owner TEXT,
	dispatch_lock_key TEXT
);

CREATE TABLE IF NOT EXISTS mem0_outbox_terminal_checkpoints (
	session_id TEXT NOT NULL,
	terminal_entry_id TEXT NOT NULL,
	ingest_keys_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (session_id, terminal_entry_id)
);

CREATE TABLE IF NOT EXISTS mem0_outbox_completed_ingest_keys (
	ingest_key TEXT PRIMARY KEY
);
`;

export interface Mem0OutboxLimits {
	maxEntries: number;
	maxBytes: number;
}

interface OutboxEntryRow {
	id: unknown;
	ingest_key: unknown;
	repository_id: unknown;
	request_json: unknown;
	source_json: unknown;
	state: unknown;
	created_at: unknown;
	updated_at: unknown;
	attempts: unknown;
	event_id: unknown;
	remote_ids_json: unknown;
	error_code: unknown;
	dispatch_owner: unknown;
	dispatch_lock_key: unknown;
}

interface CheckpointRow {
	session_id: unknown;
	terminal_entry_id: unknown;
	ingest_keys_json: unknown;
	created_at: unknown;
}

interface DispatchingRow {
	id: unknown;
	dispatch_lock_key: unknown;
}

interface StoredEntry {
	entry: Mem0OutboxEntry;
	requestJson: string;
	sourceJson: string;
	remoteIdsJson: string | null;
}

interface StoredCheckpoint {
	checkpoint: Mem0TerminalCheckpoint;
	ingestKeysJson: string;
}

interface DispatchLease {
	lockKey: string;
	release(): void;
}

const activeDispatchLocks = new Map<string, DispatchLease>();

export function getMem0OutboxPath(agentDir: string): string {
	return path.join(agentDir, "mem0", "outbox.sqlite");
}

function emptyDocument(): Mem0OutboxDocument {
	return { version: OUTBOX_VERSION, entries: [], terminalCheckpoints: [], completedIngestKeys: [] };
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return undefined;
	return value;
}

function isMem0Message(value: unknown): value is Mem0Message {
	return isRecord(value) && (value.role === "user" || value.role === "assistant" || value.role === "system") && typeof value.content === "string";
}

function hasInvalidOptionalString(record: Record<string, unknown>, key: string): boolean {
	return record[key] !== undefined && stringValue(record, key) === undefined;
}

function parsedRequest(value: unknown): Mem0AddRequest | undefined {
	if (!isRecord(value)) return undefined;
	const messages = value.messages;
	const metadata = value.metadata;
	if (
		!Array.isArray(messages) ||
		!messages.every(isMem0Message) ||
		!isRecord(metadata) ||
		typeof value.infer !== "boolean" ||
		hasInvalidOptionalString(value, "user_id") ||
		hasInvalidOptionalString(value, "agent_id") ||
		hasInvalidOptionalString(value, "app_id") ||
		hasInvalidOptionalString(value, "run_id") ||
		hasInvalidOptionalString(value, "custom_instructions") ||
		hasInvalidOptionalString(value, "agent_custom_instructions")
	) {
		return undefined;
	}
	const userId = stringValue(value, "user_id");
	const agentId = stringValue(value, "agent_id");
	const appId = stringValue(value, "app_id");
	const runId = stringValue(value, "run_id");
	const customInstructions = stringValue(value, "custom_instructions");
	const agentCustomInstructions = stringValue(value, "agent_custom_instructions");
	return {
		messages,
		metadata,
		infer: value.infer,
		...(userId !== undefined ? { user_id: userId } : {}),
		...(agentId !== undefined ? { agent_id: agentId } : {}),
		...(appId !== undefined ? { app_id: appId } : {}),
		...(runId !== undefined ? { run_id: runId } : {}),
		...(customInstructions !== undefined ? { custom_instructions: customInstructions } : {}),
		...(agentCustomInstructions !== undefined ? { agent_custom_instructions: agentCustomInstructions } : {}),
	};
}

function isSourceKind(value: unknown): value is Mem0SourceRef["sourceKind"] {
	return value === "terminal-turn" || value === "tool-result" || value === "explicit-retain" || value === "memory-save" || value === "import";
}

function isSourceArchiveKind(value: unknown): value is NonNullable<Mem0SourceRef["sourceArchiveKind"]> {
	return value === "claude-code" || value === "omp";
}

function parsedSource(value: unknown): Mem0SourceRef | undefined {
	if (!isRecord(value)) return undefined;
	const sourceKind = value.sourceKind;
	const sourceSessionId = stringValue(value, "sourceSessionId");
	const sourceEntryIds = stringArray(value.sourceEntryIds);
	const observedAt = stringValue(value, "observedAt");
	const sourceArchiveKind = value.sourceArchiveKind;
	if (
		!isSourceKind(sourceKind) ||
		sourceSessionId === undefined ||
		!sourceEntryIds ||
		observedAt === undefined ||
		hasInvalidOptionalString(value, "toolCallId") ||
		hasInvalidOptionalString(value, "toolName") ||
		(sourceArchiveKind !== undefined && !isSourceArchiveKind(sourceArchiveKind))
	) {
		return undefined;
	}
	const toolCallId = stringValue(value, "toolCallId");
	const toolName = stringValue(value, "toolName");
	return {
		sourceKind,
		sourceSessionId,
		sourceEntryIds,
		observedAt,
		...(toolCallId !== undefined ? { toolCallId } : {}),
		...(toolName !== undefined ? { toolName } : {}),
		...(sourceArchiveKind !== undefined ? { sourceArchiveKind } : {}),
	};
}

function parsedEntry(value: unknown): Mem0OutboxEntry | undefined {
	if (!isRecord(value)) return undefined;
	const id = stringValue(value, "id");
	const ingestKey = stringValue(value, "ingestKey");
	const repositoryId = stringValue(value, "repositoryId");
	const state = stringValue(value, "state");
	const createdAt = stringValue(value, "createdAt");
	const updatedAt = stringValue(value, "updatedAt");
	const request = parsedRequest(value.request);
	const source = parsedSource(value.source);
	const attempts = value.attempts;
	if (
		!id ||
		!ingestKey ||
		!repositoryId ||
		!createdAt ||
		!updatedAt ||
		!request ||
		!source ||
		typeof attempts !== "number" ||
		!Number.isInteger(attempts) ||
		attempts < 0 ||
		!isOutboxState(state)
	) {
		return undefined;
	}
	const eventId = stringValue(value, "eventId");
	const remoteIds = stringArray(value.remoteIds);
	const errorCode = stringValue(value, "errorCode");
	return {
		id,
		ingestKey,
		repositoryId,
		request,
		source,
		state,
		createdAt,
		updatedAt,
		attempts,
		...(eventId ? { eventId } : {}),
		...(remoteIds ? { remoteIds } : {}),
		...(errorCode ? { errorCode } : {}),
	};
}

function isOutboxState(value: unknown): value is Mem0OutboxState {
	return (
		value === "queued" ||
		value === "dispatching" ||
		value === "pending" ||
		value === "unknown" ||
		value === "failed" ||
		value === "committed"
	);
}

function parsedCheckpoint(value: unknown): Mem0TerminalCheckpoint | undefined {
	if (!isRecord(value)) return undefined;
	const sessionId = stringValue(value, "sessionId");
	const terminalEntryId = stringValue(value, "terminalEntryId");
	const ingestKeys = stringArray(value.ingestKeys);
	const createdAt = stringValue(value, "createdAt");
	if (!sessionId || !terminalEntryId || !ingestKeys || !createdAt) return undefined;
	return { sessionId, terminalEntryId, ingestKeys, createdAt };
}

function parsedJson(value: unknown): unknown {
	if (typeof value !== "string") return undefined;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}

function serializedEntry(value: Mem0OutboxEntry): StoredEntry | undefined {
	const entry = parsedEntry(value);
	if (!entry) return undefined;
	const requestJson = JSON.stringify(entry.request);
	const sourceJson = JSON.stringify(entry.source);
	const remoteIdsJson = entry.remoteIds === undefined ? null : JSON.stringify(entry.remoteIds);
	if (requestJson === undefined || sourceJson === undefined || remoteIdsJson === undefined) return undefined;
	return { entry, requestJson, sourceJson, remoteIdsJson };
}

function serializedCheckpoint(value: Mem0TerminalCheckpoint): StoredCheckpoint | undefined {
	const checkpoint = parsedCheckpoint(value);
	if (!checkpoint) return undefined;
	const ingestKeysJson = JSON.stringify(checkpoint.ingestKeys);
	if (ingestKeysJson === undefined) return undefined;
	return { checkpoint, ingestKeysJson };
}

function entryFromRow(row: OutboxEntryRow): Mem0OutboxEntry | undefined {
	return parsedEntry({
		id: row.id,
		ingestKey: row.ingest_key,
		repositoryId: row.repository_id,
		request: parsedJson(row.request_json),
		source: parsedJson(row.source_json),
		state: row.state,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		attempts: row.attempts,
		...(row.event_id === null || row.event_id === undefined ? {} : { eventId: row.event_id }),
		...(row.remote_ids_json === null || row.remote_ids_json === undefined
			? {}
			: { remoteIds: parsedJson(row.remote_ids_json) }),
		...(row.error_code === null || row.error_code === undefined ? {} : { errorCode: row.error_code }),
	});
}

function checkpointFromRow(row: CheckpointRow): Mem0TerminalCheckpoint | undefined {
	return parsedCheckpoint({
		sessionId: row.session_id,
		terminalEntryId: row.terminal_entry_id,
		ingestKeys: parsedJson(row.ingest_keys_json),
		createdAt: row.created_at,
	});
}

function documentBytes(document: Mem0OutboxDocument): number {
	return Buffer.byteLength(JSON.stringify(document), "utf8");
}

function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * Durable SQLite queue for sanitized Mem0 requests. Dispatch ownership is held
 * by an OS-backed lease until the caller records a non-dispatching outcome.
 * A released interrupted lease becomes unknown rather than queued, so an
 * ambiguous request is never sent again automatically.
 */
export class Mem0Outbox {
	readonly #path: string;
	readonly #limits: Mem0OutboxLimits;
	readonly #ownerId = crypto.randomUUID();
	readonly #dispatchLocks = new Map<string, DispatchLease>();
	#serial: Promise<void> = Promise.resolve();

	constructor(filePath: string, limits: Mem0OutboxLimits) {
		this.#path = filePath;
		this.#limits = limits;
	}

	async enqueue(entries: readonly Mem0OutboxEntry[], checkpoint?: Mem0TerminalCheckpoint): Promise<boolean> {
		if (entries.length === 0) return true;
		const storedEntries: StoredEntry[] = [];
		const ingestKeys = new Set<string>();
		const ids = new Set<string>();
		for (const entry of entries) {
			const stored = serializedEntry(entry);
			if (!stored || ingestKeys.has(stored.entry.ingestKey) || ids.has(stored.entry.id)) return false;
			storedEntries.push(stored);
			ingestKeys.add(stored.entry.ingestKey);
			ids.add(stored.entry.id);
		}
		const storedCheckpoint = checkpoint === undefined ? undefined : serializedCheckpoint(checkpoint);
		if (checkpoint !== undefined && !storedCheckpoint) return false;

		return await this.#execute(database => {
			if (
				storedCheckpoint &&
				database
					.query<{ session_id: unknown }, [string, string]>(
						"SELECT session_id FROM mem0_outbox_terminal_checkpoints WHERE session_id = ? AND terminal_entry_id = ?",
					)
					.get(storedCheckpoint.checkpoint.sessionId, storedCheckpoint.checkpoint.terminalEntryId)
			) {
				return false;
			}
			if (this.#hasEntryConflict(database, storedEntries)) return false;

			const document = this.#readDocument(database);
			if (!this.#makeCapacity(database, document, storedEntries, storedCheckpoint)) return false;

			const insertEntry = database.prepare(`
INSERT INTO mem0_outbox_entries (
	id, ingest_key, repository_id, request_json, source_json, state, created_at, updated_at, attempts,
	event_id, remote_ids_json, error_code, dispatch_owner, dispatch_lock_key
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
`);
			for (const stored of storedEntries) {
				insertEntry.run(
					stored.entry.id,
					stored.entry.ingestKey,
					stored.entry.repositoryId,
					stored.requestJson,
					stored.sourceJson,
					stored.entry.state,
					stored.entry.createdAt,
					stored.entry.updatedAt,
					stored.entry.attempts,
					stored.entry.eventId ?? null,
					stored.remoteIdsJson,
					stored.entry.errorCode ?? null,
				);
			}
			if (storedCheckpoint) {
				database
					.prepare(`
INSERT INTO mem0_outbox_terminal_checkpoints (session_id, terminal_entry_id, ingest_keys_json, created_at)
VALUES (?, ?, ?, ?)
`)
					.run(
						storedCheckpoint.checkpoint.sessionId,
						storedCheckpoint.checkpoint.terminalEntryId,
						storedCheckpoint.ingestKeysJson,
						storedCheckpoint.checkpoint.createdAt,
					);
			}
			return true;
		});
	}

	async takeQueued(id: string): Promise<Mem0OutboxEntry | undefined> {
		const lockKey = crypto.randomUUID();
		const lease = await acquireFileLock(this.#dispatchLockPath(lockKey), { retries: 1, retryDelayMs: 0 });
		const dispatchLease: DispatchLease = { lockKey, release: () => lease.release() };
		activeDispatchLocks.set(lockKey, dispatchLease);
		let claimed = false;
		try {
			const entry = await this.#execute((database): Mem0OutboxEntry | undefined => {
				const current = this.#entryWithRow(database, id);
				if (!current || current.entry.state !== "queued") return undefined;
				const updatedAt = new Date().toISOString();
				const result = database
					.prepare(`
UPDATE mem0_outbox_entries
SET state = 'dispatching', attempts = attempts + 1, updated_at = ?, error_code = NULL,
	dispatch_owner = ?, dispatch_lock_key = ?
WHERE id = ? AND state = 'queued'
`)
					.run(updatedAt, this.#ownerId, lockKey, id);
				if (Number(result.changes ?? 0) === 0) return undefined;
				return {
					...current.entry,
					state: "dispatching",
					attempts: current.entry.attempts + 1,
					updatedAt,
					errorCode: undefined,
				};
			});
			if (!entry) return undefined;
			this.#dispatchLocks.set(id, dispatchLease);
			claimed = true;
			return entry;
		} finally {
			if (!claimed) this.#retireDispatchLease(dispatchLease);
		}
	}

	async markPending(id: string, eventId: string): Promise<void> {
		await this.#setState(id, "pending", { eventId, errorCode: undefined });
	}

	async markQueued(id: string, errorCode: string): Promise<void> {
		await this.#setState(id, "queued", { errorCode });
	}

	async markUnknown(id: string, errorCode: string): Promise<void> {
		await this.#setState(id, "unknown", { errorCode });
	}

	async markFailed(id: string, errorCode: string): Promise<void> {
		await this.#setState(id, "failed", { errorCode });
	}

	async markCommitted(id: string, remoteIds: readonly string[] = []): Promise<void> {
		await this.#setState(id, "committed", { remoteIds: [...remoteIds], errorCode: undefined });
	}

	async snapshot(): Promise<Mem0OutboxDocument> {
		return await this.#execute(database => this.#readDocument(database));
	}

	async clearLocal(): Promise<void> {
		await this.#execute(database => {
			database.exec(`
DELETE FROM mem0_outbox_entries;
DELETE FROM mem0_outbox_terminal_checkpoints;
DELETE FROM mem0_outbox_completed_ingest_keys;
`);
		});
		this.#releaseAllDispatchLocks();
	}

	async #setState(
		id: string,
		state: Mem0OutboxState,
		patch: Pick<Mem0OutboxEntry, "eventId" | "remoteIds" | "errorCode">,
	): Promise<void> {
		let releaseLease = false;
		await this.#execute(database => {
			const current = this.#entryWithRow(database, id);
			if (!current) {
				releaseLease = true;
				return;
			}
			const lease = this.#dispatchLocks.get(id);
			if (
				current.entry.state === "dispatching" &&
				(!lease || current.row.dispatch_owner !== this.#ownerId || current.row.dispatch_lock_key !== lease.lockKey)
			) {
				return;
			}
			const entry: Mem0OutboxEntry = {
				...current.entry,
				...patch,
				state,
				updatedAt: new Date().toISOString(),
			};
			const stored = serializedEntry(entry);
			if (!stored) return;
			const result = database
				.prepare(`
UPDATE mem0_outbox_entries
SET state = ?, updated_at = ?, event_id = ?, remote_ids_json = ?, error_code = ?,
	dispatch_owner = NULL, dispatch_lock_key = NULL
WHERE id = ? AND (
	state <> 'dispatching' OR (dispatch_owner = ? AND dispatch_lock_key = ?)
)
`)
				.run(
					stored.entry.state,
					stored.entry.updatedAt,
					stored.entry.eventId ?? null,
					stored.remoteIdsJson,
					stored.entry.errorCode ?? null,
					id,
					lease === undefined ? null : this.#ownerId,
					lease?.lockKey ?? null,
				);
			releaseLease = Number(result.changes ?? 0) > 0;
		});
		if (releaseLease) this.#releaseDispatchLock(id);
	}

	#hasEntryConflict(database: Database, entries: readonly StoredEntry[]): boolean {
		const ids = entries.map(entry => entry.entry.id);
		const existingId = database
			.query<{ id: unknown }, string[]>(
				`SELECT id FROM mem0_outbox_entries WHERE id IN (${placeholders(ids.length)}) LIMIT 1`,
			)
			.get(...ids);
		if (existingId) return true;

		const ingestKeys = entries.map(entry => entry.entry.ingestKey);
		const bindings = [...ingestKeys, ...ingestKeys];
		return !!database
			.query<{ ingest_key: unknown }, string[]>(
				`
SELECT ingest_key FROM mem0_outbox_entries WHERE ingest_key IN (${placeholders(ingestKeys.length)})
UNION
SELECT ingest_key FROM mem0_outbox_completed_ingest_keys WHERE ingest_key IN (${placeholders(ingestKeys.length)})
LIMIT 1
`,
			)
			.get(...bindings);
	}

	#makeCapacity(
		database: Database,
		document: Mem0OutboxDocument,
		entries: readonly StoredEntry[],
		checkpoint: StoredCheckpoint | undefined,
	): boolean {
		const protectedCheckpointCount = checkpoint === undefined ? 0 : 1;
		if (checkpoint) {
			document.terminalCheckpoints.push(checkpoint.checkpoint);
			this.#trimHistory(database, document);
		}
		for (;;) {
			const exceedsEntries = document.entries.length + entries.length > this.#limits.maxEntries;
			const exceedsBytes = this.#bytesWithEntries(document, entries) > this.#limits.maxBytes;
			if (!exceedsEntries && !exceedsBytes) return true;
			if (this.#pruneCompletedEntry(database, document)) continue;
			if (exceedsEntries) return false;
			if (this.#removeOldestCompletedIngestKey(database, document)) continue;
			if (this.#removeOldestCheckpoint(database, document, protectedCheckpointCount)) continue;
			return false;
		}
	}

	#bytesWithEntries(document: Mem0OutboxDocument, entries: readonly StoredEntry[]): number {
		const originalLength = document.entries.length;
		for (const entry of entries) document.entries.push(entry.entry);
		try {
			return documentBytes(document);
		} finally {
			document.entries.length = originalLength;
		}
	}

	#pruneCompletedEntry(database: Database, document: Mem0OutboxDocument): boolean {
		const index = document.entries.findIndex(entry => entry.state === "committed" || entry.state === "failed");
		if (index < 0) return false;
		const entry = document.entries[index];
		if (!entry) return false;
		document.entries.splice(index, 1);
		database.prepare("DELETE FROM mem0_outbox_entries WHERE id = ?").run(entry.id);
		if (!document.completedIngestKeys.includes(entry.ingestKey)) {
			const result = database
				.prepare("INSERT OR IGNORE INTO mem0_outbox_completed_ingest_keys (ingest_key) VALUES (?)")
				.run(entry.ingestKey);
			if (Number(result.changes ?? 0) > 0) document.completedIngestKeys.push(entry.ingestKey);
		}
		this.#trimHistory(database, document);
		return true;
	}

	#trimHistory(database: Database, document: Mem0OutboxDocument): void {
		while (document.completedIngestKeys.length > COMPLETED_INGEST_KEY_CAP) {
			this.#removeOldestCompletedIngestKey(database, document);
		}
		while (document.terminalCheckpoints.length > TERMINAL_CHECKPOINT_CAP) {
			this.#removeOldestCheckpoint(database, document, 0);
		}
	}

	#removeOldestCompletedIngestKey(database: Database, document: Mem0OutboxDocument): boolean {
		const ingestKey = document.completedIngestKeys.shift();
		if (ingestKey === undefined) return false;
		database.prepare("DELETE FROM mem0_outbox_completed_ingest_keys WHERE ingest_key = ?").run(ingestKey);
		return true;
	}

	#removeOldestCheckpoint(
		database: Database,
		document: Mem0OutboxDocument,
		protectedCheckpointCount: number,
	): boolean {
		if (document.terminalCheckpoints.length <= protectedCheckpointCount) return false;
		const checkpoint = document.terminalCheckpoints.shift();
		if (!checkpoint) return false;
		database
			.prepare(
				"DELETE FROM mem0_outbox_terminal_checkpoints WHERE session_id = ? AND terminal_entry_id = ?",
			)
			.run(checkpoint.sessionId, checkpoint.terminalEntryId);
		return true;
	}

	#entryWithRow(database: Database, id: string): { row: OutboxEntryRow; entry: Mem0OutboxEntry } | undefined {
		const row = database
			.query<OutboxEntryRow, [string]>(`
SELECT id, ingest_key, repository_id, request_json, source_json, state, created_at, updated_at, attempts,
	event_id, remote_ids_json, error_code, dispatch_owner, dispatch_lock_key
FROM mem0_outbox_entries
WHERE id = ?
`)
			.get(id);
		if (!row) return undefined;
		const entry = entryFromRow(row);
		return entry === undefined ? undefined : { row, entry };
	}

	#readDocument(database: Database): Mem0OutboxDocument {
		const document = emptyDocument();
		const entries = database
			.query<OutboxEntryRow, []>(`
SELECT id, ingest_key, repository_id, request_json, source_json, state, created_at, updated_at, attempts,
	event_id, remote_ids_json, error_code, dispatch_owner, dispatch_lock_key
FROM mem0_outbox_entries
ORDER BY rowid
`)
			.all();
		for (const row of entries) {
			const entry = entryFromRow(row);
			if (entry) document.entries.push(entry);
		}
		const checkpoints = database
			.query<CheckpointRow, []>(`
SELECT session_id, terminal_entry_id, ingest_keys_json, created_at
FROM mem0_outbox_terminal_checkpoints
ORDER BY rowid
`)
			.all();
		for (const row of checkpoints) {
			const checkpoint = checkpointFromRow(row);
			if (checkpoint) document.terminalCheckpoints.push(checkpoint);
		}
		const completedIngestKeys = database
			.query<{ ingest_key: unknown }, []>(
				"SELECT ingest_key FROM mem0_outbox_completed_ingest_keys ORDER BY rowid",
			)
			.all();
		for (const row of completedIngestKeys) {
			if (typeof row.ingest_key === "string") document.completedIngestKeys.push(row.ingest_key);
		}
		return document;
	}

	#recoverInterruptedDispatches(database: Database): string[] {
		const now = new Date().toISOString();
		const entries = database
			.query<DispatchingRow, []>(
				"SELECT id, dispatch_lock_key FROM mem0_outbox_entries WHERE state = 'dispatching' ORDER BY rowid",
			)
			.all();
		for (const entry of entries) {
			if (typeof entry.id !== "string" || entry.id.length === 0) continue;
			const entryId = entry.id;
			const lockKey =
				typeof entry.dispatch_lock_key === "string" && dispatchLockKeyPattern.test(entry.dispatch_lock_key)
					? entry.dispatch_lock_key
					: undefined;
			if (lockKey === undefined) {
				database
					.prepare(`
UPDATE mem0_outbox_entries
SET state = 'unknown', error_code = 'interrupted-dispatch', updated_at = ?,
	dispatch_owner = NULL, dispatch_lock_key = NULL
WHERE id = ? AND state = 'dispatching'
`)
					.run(now, entryId);
				continue;
			}
			if (activeDispatchLocks.has(lockKey)) continue;
			try {
				withFileLockSync(
					this.#dispatchLockPath(lockKey),
					() => {
						database
							.prepare(`
UPDATE mem0_outbox_entries
SET state = 'unknown', error_code = 'interrupted-dispatch', updated_at = ?,
	dispatch_owner = NULL, dispatch_lock_key = NULL
WHERE id = ? AND state = 'dispatching' AND dispatch_lock_key = ?
`)
							.run(now, entryId, lockKey);
					},
					{ retries: 1, retryDelayMs: 0 },
				);
			} catch {
				// A held lease belongs to a live dispatcher; leave its outcome untouched.
			}
		}

		const referencedLockKeys = new Set(
			database
				.query<{ dispatch_lock_key: unknown }, []>(
					"SELECT dispatch_lock_key FROM mem0_outbox_entries WHERE state = 'dispatching'",
				)
				.all()
				.flatMap(row =>
					typeof row.dispatch_lock_key === "string" && dispatchLockKeyPattern.test(row.dispatch_lock_key)
						? [row.dispatch_lock_key]
						: [],
				),
		);
		return this
			.#dispatchLockKeys()
			.filter(lockKey => !referencedLockKeys.has(lockKey) && !activeDispatchLocks.has(lockKey));
	}

	#dispatchLockPath(lockKey: string): string {
		return `${this.#path}.dispatch-${lockKey}`;
	}

	#dispatchLockKeys(): string[] {
		const prefix = `${path.basename(this.#path)}.dispatch-`;
		try {
			return fs
				.readdirSync(path.dirname(this.#path))
				.flatMap(name => {
					if (!name.startsWith(prefix) || !name.endsWith(".lock")) return [];
					const lockKey = name.slice(prefix.length, -".lock".length);
					return dispatchLockKeyPattern.test(lockKey) ? [lockKey] : [];
				});
		} catch {
			return [];
		}
	}

	#retireDispatchLease(lease: DispatchLease): void {
		activeDispatchLocks.delete(lease.lockKey);
		lease.release();
		this.#removeDispatchLockArtifact(lease.lockKey);
	}

	#removeDispatchLockArtifact(lockKey: string): void {
		if (activeDispatchLocks.has(lockKey)) return;
		try {
			withFileLockSync(
				this.#dispatchLockPath(lockKey),
				() => fs.unlinkSync(`${this.#dispatchLockPath(lockKey)}.lock`),
				{ retries: 1, retryDelayMs: 0 },
			);
		} catch {
			// Cleanup must not change a committed outcome or disturb a live lease.
		}
	}

	#releaseDispatchLock(id: string): void {
		const lease = this.#dispatchLocks.get(id);
		if (!lease) return;
		this.#dispatchLocks.delete(id);
		this.#retireDispatchLease(lease);
	}

	#releaseAllDispatchLocks(): void {
		for (const [id] of [...this.#dispatchLocks]) this.#releaseDispatchLock(id);
	}

	async #execute<T>(operation: (database: Database) => T): Promise<T> {
		return await this.#serialize(() =>
			this.#withDatabase(database => this.#transaction(database, () => operation(database))),
		);
	}

	#transaction<T>(database: Database, operation: () => T): T {
		database.exec("BEGIN IMMEDIATE");
		try {
			const retiredLockKeys = this.#recoverInterruptedDispatches(database);
			const result = operation();
			database.exec("COMMIT");
			for (const lockKey of retiredLockKeys) this.#removeDispatchLockArtifact(lockKey);
			return result;
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// The original transaction failure is more useful than a rollback failure.
			}
			throw error;
		}
	}

	async #withDatabase<T>(operation: (database: Database) => T): Promise<T> {
		fs.mkdirSync(path.dirname(this.#path), { recursive: true, mode: 0o700 });
		return await openSqliteDatabase(this.#path, database => {
			let completed = false;
			try {
				database.exec(SCHEMA_SQL);
				fs.chmodSync(this.#path, 0o600);
				const result = operation(database);
				completed = true;
				return result;
			} finally {
				if (completed) database.close();
			}
		});
	}

	async #serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#serial.then(operation);
		this.#serial = result.then(
			() => undefined,
			() => undefined,
		);
		return await result;
	}
}
