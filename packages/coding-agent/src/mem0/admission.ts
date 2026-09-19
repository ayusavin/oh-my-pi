import { createHash } from "node:crypto";
import { MEM0_IDENTITY, type Mem0Actor, type Mem0AddRequest, type Mem0Identity, type Mem0Memory, type Mem0MemoryScope, type Mem0Message, type Mem0SourceRef } from "./types";
import agentCustomInstructions from "../prompts/memories/mem0-agent-custom-instructions.md" with { type: "text" };
import userCustomInstructions from "../prompts/memories/mem0-user-custom-instructions.md" with { type: "text" };
import { redactMem0Text, type Mem0TextRedactor } from "./redact";

export const MEM0_POLICY_VERSION = "omp-memory-v1";

const USER_CUSTOM_INSTRUCTIONS = userCustomInstructions.trim();
const AGENT_CUSTOM_INSTRUCTIONS = agentCustomInstructions.trim();

const ALLOWED_TOOL_EVIDENCE: Record<string, true> = { read: true, grep: true, glob: true, web_search: true };
const FORBIDDEN_SOURCE_SEGMENT =
	/(?:^|[\\/])(?:\.env(?:\..*)?|credentials?|secrets?|id_(?:rsa|dsa|ecdsa|ed25519)|known_hosts|authorized_keys|\.mem0-setup\.key|auth\.json|agent\.db(?:-(?:wal|shm|journal)|\.corrupt-[^\\/]+(?:-(?:wal|shm|journal))?)?)(?:$|[\\/])/i;

export interface Mem0AdmissionMessage {
	role: "user" | "assistant";
	content: string;
}

export interface Mem0AdmissionInput {
	scope: Mem0MemoryScope;
	repositoryId?: string;
	actor: Mem0Actor;
	messages: readonly Mem0AdmissionMessage[];
	source: Mem0SourceRef;
	maxChars: number;
	identity?: Mem0Identity;
	/** `false` is reserved for reviewed atomic direct import. */
	infer?: boolean;
	redact?: Mem0TextRedactor;
}

export interface Mem0AdmittedPayload {
	ingestKey: string;
	repositoryId: string;
	request: Mem0AddRequest;
	source: Mem0SourceRef;
}

export interface Mem0TerminalEntry {
	id: string;
	timestamp: string;
	kind: "user" | "assistant" | "tool";
	content: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	useless?: boolean;
	sourcePath?: string;
}

export interface Mem0TerminalAdmissionInput {
	repositoryId: string;
	sessionId: string;
	observedAt: string;
	entries: readonly Mem0TerminalEntry[];
	maxChars: number;
	toolResultMaxChars: number;
	toolResultAllowlist: readonly string[];
	identity?: Mem0Identity;
	redact?: Mem0TextRedactor;
}


function boundedText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function cleanEntryIds(ids: readonly string[]): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		const value = id.trim();
		if (!value || seen.has(value)) continue;
		seen.add(value);
		result.push(value);
		if (result.length === 64) break;
	}
	return result;
}

function metadataFor(input: Mem0AdmissionInput, ingestKey: string): Record<string, unknown> {
	const metadata: Record<string, unknown> = {
		schema_version: 1,
		memory_scope: input.scope,
		actor_id: input.actor,
		source_kind: input.source.sourceKind,
		source_session_id: input.source.sourceSessionId,
		source_entry_ids: input.source.sourceEntryIds,
		observed_at: input.source.observedAt,
		policy_version: MEM0_POLICY_VERSION,
		ingest_key: ingestKey,
	};
	if (input.scope === "project") metadata.repository_id = input.repositoryId;
	if (input.source.sourceArchiveKind) metadata.source_archive_kind = input.source.sourceArchiveKind;
	if (input.source.toolCallId) metadata.tool_call_id = input.source.toolCallId;
	if (input.source.toolName) metadata.source_ref = `tool:${input.source.toolName}#${input.source.toolCallId ?? "unknown"}`;
	return metadata;
}

/**
 * Admit a single actor's payload at the only external-memory boundary. The
 * returned object is safe to persist in the local outbox and to send remotely.
 */
export function admitMem0Payload(input: Mem0AdmissionInput): Mem0AdmittedPayload | undefined {
	if (input.scope === "project" && !input.repositoryId) return undefined;
	if (input.scope === "global-preference" && input.actor !== "user") return undefined;

	const redact = input.redact ?? redactMem0Text;
	let remaining = Math.max(1, input.maxChars);
	const messages: Mem0Message[] = [];
	for (const raw of input.messages) {
		if (remaining <= 0) break;
		const text = boundedText(redact(raw.content).trim(), remaining);
		if (!text) continue;
		messages.push({ role: raw.role, content: text });
		remaining -= text.length;
	}
	if (messages.length === 0) return undefined;

	const source: Mem0SourceRef = {
		...input.source,
		sourceEntryIds: cleanEntryIds(input.source.sourceEntryIds),
	};
	if (!source.sourceSessionId || source.sourceEntryIds.length === 0) return undefined;

	const infer = input.infer ?? true;
	const canonical = JSON.stringify({
		scope: input.scope,
		repositoryId: input.repositoryId ?? null,
		actor: input.actor,
		messages,
		source,
		infer,
		policyVersion: MEM0_POLICY_VERSION,
	});
	const ingestKey = createHash("sha256").update(canonical, "utf8").digest("hex");
	const metadata = metadataFor({ ...input, source }, ingestKey);
	const identity = input.identity ?? MEM0_IDENTITY;
	const request: Mem0AddRequest = {
		messages,
		metadata,
		infer,
		...(input.actor === "user"
			? { user_id: identity.userId, app_id: identity.appId, custom_instructions: USER_CUSTOM_INSTRUCTIONS }
			: { agent_id: identity.agentId, app_id: identity.appId, agent_custom_instructions: AGENT_CUSTOM_INSTRUCTIONS }),
	};
	return { ingestKey, repositoryId: input.repositoryId ?? "global-preference", request, source };
}

/** True only for built-in tools that are explicitly admitted by configuration. */
export function isMem0ToolEvidenceAllowed(toolName: string | undefined, configuredAllowlist: readonly string[]): boolean {
	return toolName !== undefined && ALLOWED_TOOL_EVIDENCE[toolName] === true && configuredAllowlist.includes(toolName);
}

/** Exclude file paths that are never admissible as external memory evidence. */
export function isMem0ForbiddenEvidenceSource(sourcePath: string | undefined): boolean {
	return sourcePath !== undefined && FORBIDDEN_SOURCE_SEGMENT.test(sourcePath);
}

/** Build one sanitized, actor-separated set of payloads for a completed turn. */
export function admitMem0TerminalTurn(input: Mem0TerminalAdmissionInput): Mem0AdmittedPayload[] {
	const payloads: Mem0AdmittedPayload[] = [];
	const redact = input.redact ?? redactMem0Text;
	const userEntries = input.entries.filter(entry => entry.kind === "user" && entry.content.trim());
	const assistantEntries = input.entries.filter(entry => entry.kind === "assistant" && entry.content.trim());

	const user = admitMem0Payload({
		scope: "project",
		repositoryId: input.repositoryId,
		actor: "user",
		messages: userEntries.map(entry => ({ role: "user", content: entry.content })),
		source: {
			sourceKind: "terminal-turn",
			sourceSessionId: input.sessionId,
			sourceEntryIds: userEntries.map(entry => entry.id),
			observedAt: input.observedAt,
		},
		maxChars: input.maxChars,
		identity: input.identity,
		redact,
	});
	if (user) payloads.push(user);

	const assistant = admitMem0Payload({
		scope: "project",
		repositoryId: input.repositoryId,
		actor: "assistant",
		messages: assistantEntries.map(entry => ({ role: "assistant", content: entry.content })),
		source: {
			sourceKind: "terminal-turn",
			sourceSessionId: input.sessionId,
			sourceEntryIds: assistantEntries.map(entry => entry.id),
			observedAt: input.observedAt,
		},
		maxChars: input.maxChars,
		identity: input.identity,
		redact,
	});
	if (assistant) payloads.push(assistant);

	for (const entry of input.entries) {
		if (
			entry.kind !== "tool" ||
			entry.isError ||
			entry.useless ||
			!entry.content.trim() ||
			!isMem0ToolEvidenceAllowed(entry.toolName, input.toolResultAllowlist) ||
			(entry.toolName === "read" && !entry.sourcePath?.trim()) ||
			isMem0ForbiddenEvidenceSource(entry.sourcePath)
		) {
			continue;
		}
		const tool = admitMem0Payload({
			scope: "project",
			repositoryId: input.repositoryId,
			actor: "tool",
			messages: [
				{
					role: "assistant",
					content: `[Observed ${entry.toolName} result; source ref ${entry.toolCallId ?? entry.id}]\n${entry.content}`,
				},
			],
			source: {
				sourceKind: "tool-result",
				sourceSessionId: input.sessionId,
				sourceEntryIds: [entry.id],
				observedAt: entry.timestamp || input.observedAt,
				toolCallId: entry.toolCallId,
				toolName: entry.toolName,
			},
			maxChars: input.toolResultMaxChars,
			identity: input.identity,
			redact,
		});
		if (tool) payloads.push(tool);
	}
	return payloads;
}

function metadataString(memory: Mem0Memory, key: string): string | undefined {
	const value = memory.metadata[key];
	return typeof value === "string" ? value : undefined;
}

/** Strict local scope checks protect per-ID reads and mutations without server filters. */
export function isScopedMem0Memory(memory: Mem0Memory, repositoryId: string, identity: Mem0Identity = MEM0_IDENTITY): boolean {
	if (metadataString(memory, "memory_scope") !== "project") return false;
	if (metadataString(memory, "repository_id") !== repositoryId) return false;
	if (memory.appId !== identity.appId) return false;
	return memory.userId === identity.userId || memory.agentId === identity.agentId;
}

/** Standing preferences must be this installation's own user records, never another agent's. */
export function isGlobalPreferenceMem0Memory(memory: Mem0Memory, identity: Mem0Identity = MEM0_IDENTITY): boolean {
	return (
		metadataString(memory, "memory_scope") === "global-preference" &&
		memory.userId === identity.userId &&
		memory.appId === identity.appId &&
		memory.agentId === undefined &&
		memory.runId === undefined
	);
}
/** Select the bounded user-only profile lane without semantic/global fallback. */
export function selectMem0StandingPreferences(
	memories: readonly Mem0Memory[],
	limit: number,
	identity: Mem0Identity = MEM0_IDENTITY,
): Mem0Memory[] {
	return uniqueMem0Memories(memories.filter(memory => isGlobalPreferenceMem0Memory(memory, identity))).slice(0, Math.max(0, limit));
}

/** Deduplicate repeated ids without changing server result order. */
export function uniqueMem0Memories(memories: readonly Mem0Memory[]): Mem0Memory[] {
	const seen = new Set<string>();
	return memories.filter(memory => {
		if (!memory.id || seen.has(memory.id)) return false;
		seen.add(memory.id);
		return true;
	});
}
