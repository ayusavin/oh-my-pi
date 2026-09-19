export const MEM0_API_ORIGIN = "https://api.mem0.ai";
export const MEM0_USER_ID = "ayusavin";
export const MEM0_AGENT_ID = "omp";
export const MEM0_APP_ID = "omp";

/** One Mem0 account is shared with other agents; these ids are omp's own namespace inside it. */
export interface Mem0Identity {
	userId: string;
	agentId: string;
	appId: string;
}

export const MEM0_IDENTITY: Mem0Identity = { userId: MEM0_USER_ID, agentId: MEM0_AGENT_ID, appId: MEM0_APP_ID };

export type Mem0MemoryScope = "global-preference" | "project";
export type Mem0Actor = "user" | "assistant" | "tool";
export type Mem0MessageRole = "user" | "assistant" | "system";
export type Mem0OutboxState = "queued" | "dispatching" | "pending" | "unknown" | "failed" | "committed";
export type Mem0EventStatus = "PENDING" | "RUNNING" | "FAILED" | "SUCCEEDED" | string;

export interface Mem0Message {
	role: Mem0MessageRole;
	content: string;
}

export interface Mem0Memory {
	id: string;
	memory: string;
	userId?: string;
	agentId?: string;
	appId?: string;
	runId?: string;
	metadata: Record<string, unknown>;
	categories?: string[];
	expirationDate?: string | null;
	createdAt?: string;
	updatedAt?: string;
	score?: number;
	replacedBy?: string | null;
	synthesized?: boolean;
	lifecycleState?: string;
}

export interface Mem0AddRequest {
	messages: Mem0Message[];
	metadata: Record<string, unknown>;
	infer: boolean;
	user_id?: string;
	agent_id?: string;
	app_id?: string;
	run_id?: string;
	custom_instructions?: string;
	agent_custom_instructions?: string;
}

export interface Mem0AddResponse {
	status: string;
	eventId?: string;
	results: Mem0Memory[];
}

export interface Mem0SearchResponse {
	results: Mem0Memory[];
}

export interface Mem0ListResponse {
	count: number;
	next?: string | null;
	previous?: string | null;
	results: Mem0Memory[];
}

export interface Mem0Event {
	id: string;
	status: Mem0EventStatus;
	error?: string;
	results: Mem0Memory[];
}

export interface Mem0SourceRef {
	sourceKind: "terminal-turn" | "tool-result" | "explicit-retain" | "memory-save" | "import";
	sourceSessionId: string;
	sourceEntryIds: string[];
	observedAt: string;
	toolCallId?: string;
	toolName?: string;
	/** Historical source classification for reviewed direct import only. */
	sourceArchiveKind?: "claude-code" | "omp";
}

export interface Mem0OutboxEntry {
	id: string;
	ingestKey: string;
	repositoryId: string;
	request: Mem0AddRequest;
	source: Mem0SourceRef;
	state: Mem0OutboxState;
	createdAt: string;
	updatedAt: string;
	attempts: number;
	eventId?: string;
	remoteIds?: string[];
	errorCode?: string;
}

export interface Mem0TerminalCheckpoint {
	sessionId: string;
	terminalEntryId: string;
	ingestKeys: string[];
	createdAt: string;
}

export interface Mem0OutboxDocument {
	version: 1;
	entries: Mem0OutboxEntry[];
	terminalCheckpoints: Mem0TerminalCheckpoint[];
	completedIngestKeys: string[];
}
