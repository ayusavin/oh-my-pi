import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type {
	MemoryBackendSaveInput,
	MemoryBackendSaveResult,
	MemoryBackendSearchOptions,
	MemoryBackendSearchResult,
	MemoryBackendStatus,
	MemoryPromptPreparation,
} from "../memory-backend/types";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import {
	admitMem0Payload,
	isGlobalPreferenceMem0Memory,
	isScopedMem0Memory,
	type Mem0AdmittedPayload,
	uniqueMem0Memories,
} from "./admission";
import { persistAcceptedMem0TerminalCapture } from "./capture-persist";
import { terminalEntriesSinceCheckpoint, type Mem0TranscriptEntry } from "./capture";
import { Mem0Client } from "./client";
import { type Mem0Config, type Mem0Credential, loadMem0Config, resolveMem0Credential } from "./config";
import { flushMem0Outbox } from "./dispatch";
import { deriveMem0RepositoryIdentity, type Mem0RepositoryIdentity } from "./identity";
import { getMem0OutboxPath, Mem0Outbox } from "./outbox";
import { mem0AutoCaptureEnabled, mem0WritesEnabled } from "./permissions";
import { loadMem0StandingProfile } from "./profile";
import { renderMem0PromptContext, type Mem0ProfilePromptState } from "./prompt-context";
import { createMem0TextRedactor, type Mem0TextRedactor } from "./redact";
import { composeMem0TextRedactors } from "./redaction-context";
import { mem0GlobalSaveScopeError } from "./save-scope";
import { MEM0_AGENT_ID, MEM0_APP_ID, MEM0_USER_ID, type Mem0Memory, type Mem0OutboxEntry } from "./types";
import { Mem0WorkScope } from "./work";

const PROMPT_QUERY_MAX_CHARS = 4_000;
const DISPOSE_REMOTE_DRAIN_MS = 3_000;

interface Mem0OwnerSnapshot {
	sessionId: string;
	branchLeafId: string | undefined;
}

interface Mem0ProjectRecall {
	memories: Mem0Memory[];
	message?: string;
}

function projectFilters(actor: "user" | "assistant", repositoryId: string): Record<string, unknown> {
	return {
		...(actor === "user" ? { user_id: MEM0_USER_ID } : { agent_id: MEM0_AGENT_ID }),
		app_id: MEM0_APP_ID,
		metadata: { memory_scope: "project", repository_id: repositoryId },
	};
}

/**
 * Session-owned Mem0 state. Aliases expose scoped explicit tools but only the
 * primary captures terminal turns and dispatches its durable outbox.
 */
export class Mem0SessionState {
	readonly session: AgentSession;
	readonly config: Mem0Config;
	readonly identity: Mem0RepositoryIdentity;
	readonly credential: Mem0Credential;
	readonly outbox: Mem0Outbox;
	readonly aliasOf: Mem0SessionState | undefined;
	readonly #client: Mem0Client | undefined;
	readonly #redact: Mem0TextRedactor;
	readonly #work = new Mem0WorkScope();
	readonly #capturingTerminalIds = new Set<string>();
	readonly #inFlightDispatchIds = new Set<string>();
	#standingPreferences: Mem0Memory[] = [];
	#profileState: Mem0ProfilePromptState = {
		status: "loading",
		reason: "The standing preference profile has not started loading.",
	};
	#profileLoad: Promise<void> | undefined;
	#unsubscribe: (() => void) | undefined;
	#disposed = false;
	#stopping = false;
	#degradedReason: string | undefined;
	#noticedReasons = new Set<string>();
	#flush: Promise<void> | undefined;

	private constructor(options: {
		session: AgentSession;
		config: Mem0Config;
		identity: Mem0RepositoryIdentity;
		credential: Mem0Credential;
		outbox: Mem0Outbox;
		aliasOf?: Mem0SessionState;
	}) {
		this.session = options.session;
		this.config = options.config;
		this.identity = options.identity;
		this.credential = options.credential;
		this.outbox = options.outbox;
		this.aliasOf = options.aliasOf;
		const alias = options.aliasOf;
		this.#client = alias
			? alias.#client
			: options.credential.apiKey
				? new Mem0Client(options.credential.apiKey, { requestTimeoutMs: options.config.requestTimeoutMs })
				: undefined;
		this.#redact = createMem0TextRedactor(options.session.obfuscator);
	}

	static async create(session: AgentSession, settings: Settings, agentDir: string): Promise<Mem0SessionState> {
		const config = loadMem0Config(settings);
		const [identity, credential] = await Promise.all([
			deriveMem0RepositoryIdentity(session.sessionManager.getCwd()),
			resolveMem0Credential(agentDir, config),
		]);
		return new Mem0SessionState({
			session,
			config,
			identity,
			credential,
			outbox: new Mem0Outbox(getMem0OutboxPath(agentDir), {
				maxEntries: config.outboxMaxEntries,
				maxBytes: config.outboxMaxBytes,
			}),
		});
	}

	static async createAlias(session: AgentSession, primary: Mem0SessionState): Promise<Mem0SessionState | undefined> {
		const identity = await deriveMem0RepositoryIdentity(session.sessionManager.getCwd());
		if (identity.repositoryId !== primary.identity.repositoryId) return undefined;
		return new Mem0SessionState({
			session,
			config: primary.config,
			identity: primary.identity,
			credential: primary.credential,
			outbox: primary.outbox,
			aliasOf: primary,
		});
	}

	get primary(): Mem0SessionState {
		return this.aliasOf?.primary ?? this;
	}

	attachSessionListeners(): void {
		if (this.aliasOf) return;
		this.#unsubscribe?.();
		this.#unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
			if (event.type !== "agent_end" || event.isTerminal === false) return;
			void this.captureTerminalTurn().catch(() => {
				this.#degrade("terminal capture could not be queued", this, this.#snapshot(this));
			});
		});
		if (!this.#client) {
			this.#profileState = { status: "degraded", reason: "Mem0 credentials are unavailable." };
			this.#degrade("credential is unavailable", this, this.#snapshot(this));
			return;
		}
		this.#profileState = { status: "loading", reason: "Standing preference profile is loading." };
		this.#profileLoad = this.loadStandingPreferences();
	}

	async status(): Promise<MemoryBackendStatus> {
		if (this.aliasOf) return await this.primary.status();
		const document = await this.outbox.snapshot();
		const pending = document.entries.filter(entry => entry.state === "pending").length;
		const queued = document.entries.filter(entry => entry.state === "queued").length;
		const unknown = document.entries.filter(entry => entry.state === "unknown").length;
		const failed = document.entries.filter(entry => entry.state === "failed").length;
		const profileDescription =
			this.#profileState.status === "ready"
				? "ready"
				: `${this.#profileState.status}: ${this.#profileState.reason}`;
		return {
			backend: "mem0",
			active: true,
			writable: mem0WritesEnabled(this.session.settings) && !this.#stopping && this.#client !== undefined,
			searchable: this.#client !== undefined && !this.#stopping,
			scope: this.identity.repositoryId,
			workingCount: pending + queued,
			episodicCount: document.entries.filter(entry => entry.state === "committed").length,
			message: `Standing preferences: ${this.#standingPreferences.length} (${profileDescription}); queued: ${queued}; pending: ${pending}; unknown: ${unknown}; failed: ${failed}.`,
			...(this.#degradedReason ? { error: `Memory degraded: ${this.#degradedReason}.` } : {}),
		};
	}

	async diagnose(): Promise<string> {
		const status = await this.status();
		let connectivity = "not checked";
		const owner = this.#snapshot(this);
		if (this.#client && this.#isCurrent(this, owner, false)) {
			try {
				await this.#client.ping(this.#requestSignal(this));
				connectivity = "reachable";
			} catch {
				connectivity = "unavailable";
				this.#degrade("remote service is unavailable", this, owner);
			}
		}
		return [
			"# Mem0 Memory Diagnostics",
			"",
			`- Repository scope: \`${this.identity.repositoryId}\``,
			`- Credential source: ${this.credential.source}`,
			`- Remote connectivity: ${connectivity}`,
			`- Write permission: ${mem0WritesEnabled(this.session.settings) ? "enabled" : "disabled"}`,
			`- ${status.message ?? "No local queue state."}`,
			...(status.error ? [`- ${status.error}`] : []),
		].join("\n");
	}

	async queuePreview(): Promise<string> {
		const document = await this.outbox.snapshot();
		const lines = ["# Mem0 Outbox", ""];
		if (document.entries.length === 0) return `${lines.join("\n")}No queued memory operations.`;
		for (const entry of document.entries) {
			lines.push(`- ${entry.state}: ${entry.source.sourceKind} (${entry.ingestKey.slice(0, 12)})${entry.eventId ? ` event ${entry.eventId}` : ""}`);
		}
		return lines.join("\n");
	}

	async clearLocal(): Promise<void> {
		if (this.aliasOf) return await this.primary.clearLocal();
		await this.outbox.clearLocal();
	}

	async enqueue(): Promise<void> {
		await this.primary.flushOutbox();
	}

	async searchProject(query: string, options?: MemoryBackendSearchOptions): Promise<MemoryBackendSearchResult> {
		return await this.primary.#searchProject(this, query, options?.signal, options?.limit);
	}

	async saveExplicit(input: MemoryBackendSaveInput, actor: "user" | "assistant"): Promise<MemoryBackendSaveResult> {
		return await this.primary.#saveExplicit(this, input, actor);
	}

	async updateMemory(id: string, content: string): Promise<Mem0Memory> {
		return await this.primary.#updateMemory(this, id, content);
	}

	async deleteMemory(id: string): Promise<void> {
		await this.primary.#deleteMemory(this, id);
	}

	async readMemory(id: string, signal?: AbortSignal): Promise<Mem0Memory> {
		return await this.primary.#readMemory(this, id, signal);
	}

	async beforeAgentStartPrompt(promptText: string): Promise<MemoryPromptPreparation | undefined> {
		return await this.primary.#preparePrompt(this, promptText);
	}

	async drainForDispose(): Promise<void> {
		this.#stopAcceptingWork();
		if (this.aliasOf) {
			this.#work.stop();
			return;
		}
		try {
			await this.#markInFlightDispatchesUnknown();
		} catch (error) {
			logger.warn("Mem0 could not mark an interrupted dispatch as unknown", { error: String(error) });
		}
		this.#work.stop();
		await this.#work.drainCaptures();
		const background = Promise.allSettled([this.#profileLoad ?? Promise.resolve(), this.#flush ?? Promise.resolve()]);
		await Promise.race([background, Bun.sleep(DISPOSE_REMOTE_DRAIN_MS)]);
	}

	dispose(): void {
		this.#stopAcceptingWork();
		this.#work.stop();
		this.#disposed = true;
	}

	async #preparePrompt(caller: Mem0SessionState, promptText: string): Promise<MemoryPromptPreparation | undefined> {
		const owner = this.#snapshot(caller);
		if (!this.#isCurrent(caller, owner)) return undefined;
		const profileState = await this.#profileStateForPrompt();
		if (!this.#isCurrent(caller, owner)) return undefined;
		const recalled = this.#client ? await this.#recallForPrompt(caller, promptText, owner) : [];
		if (!this.#isCurrent(caller, owner)) return undefined;
		const rendered = renderMem0PromptContext({
			profile: this.#standingPreferences,
			profileState,
			project: recalled,
			budget: {
				maxChars: this.config.injectionMaxChars,
				maxTokens: this.config.injectionTokenLimit,
			},
		});
		if (rendered.profileOverflow) {
			this.#degrade("standing preference profile exceeds the injection budget", caller, owner);
		}
		if (!rendered.context) return undefined;
		return {
			context: rendered.context,
			commit: () => this.#isCurrent(caller, owner),
		};
	}

	async #profileStateForPrompt(): Promise<Mem0ProfilePromptState> {
		if (this.#profileState.status !== "loading") return this.#profileState;
		const load = this.#profileLoad;
		if (!load) {
			return { status: "degraded", reason: "Standing preference profile did not start loading." };
		}
		const completed = await Promise.race([
			load.then(
				() => true,
				() => true,
			),
			Bun.sleep(this.config.startupWaitMs).then(() => false),
		]);
		if (!completed) {
			return {
				status: "loading",
				reason: `Standing preference profile did not finish within ${this.config.startupWaitMs} ms.`,
			};
		}
		return this.#profileState.status === "loading"
			? { status: "degraded", reason: "Standing preference profile failed before reporting its result." }
			: this.#profileState;
	}

	async #recallForPrompt(caller: Mem0SessionState, promptText: string, owner: Mem0OwnerSnapshot): Promise<Mem0Memory[]> {
		const recall = await this.#recallProjectMemories(
			caller,
			promptText,
			undefined,
			this.config.projectRecallLimit,
			owner,
		);
		return recall.memories;
	}

	async #searchProject(
		caller: Mem0SessionState,
		query: string,
		signal?: AbortSignal,
		limit = this.config.projectRecallLimit,
		owner = this.#snapshot(caller),
	): Promise<MemoryBackendSearchResult> {
		const recall = await this.#recallProjectMemories(caller, query, signal, limit, owner);
		return {
			backend: "mem0",
			query,
			count: recall.memories.length,
			items: recall.memories.map(memory => ({
				id: memory.id,
				content: memory.memory,
				source: `memory://${memory.id}`,
				timestamp: memory.updatedAt ?? memory.createdAt,
				score: memory.score,
			})),
			...(recall.message ? { message: recall.message } : {}),
		};
	}

	async #recallProjectMemories(
		caller: Mem0SessionState,
		query: string,
		signal: AbortSignal | undefined,
		limit: number,
		owner: Mem0OwnerSnapshot,
	): Promise<Mem0ProjectRecall> {
		if (!this.#isCurrent(caller, owner)) {
			return { memories: [], message: "Memory search was discarded after the session changed." };
		}
		const cleanQuery = this.#redactorFor(caller)(query).trim().slice(0, PROMPT_QUERY_MAX_CHARS);
		if (!cleanQuery) return { memories: [], message: "Memory query is empty after redaction." };
		const client = this.#client;
		if (!client) {
			this.#degrade("credential is unavailable", caller, owner);
			return { memories: [], message: "Mem0 credential is unavailable." };
		}
		const topK = Math.max(1, Math.min(this.config.projectRecallLimit, limit));
		const requestSignal = this.#requestSignal(caller, signal);
		const results = await Promise.allSettled([
			client.search(cleanQuery, projectFilters("user", this.identity.repositoryId), topK, requestSignal),
			client.search(cleanQuery, projectFilters("assistant", this.identity.repositoryId), topK, requestSignal),
		]);
		if (!this.#isCurrent(caller, owner)) {
			return { memories: [], message: "Memory search was discarded after the session changed." };
		}
		const memories: Mem0Memory[] = [];
		let failures = 0;
		for (const result of results) {
			if (result.status === "fulfilled") {
				memories.push(...result.value.results.filter(memory => isScopedMem0Memory(memory, this.identity.repositoryId)));
			} else {
				failures++;
			}
		}
		if (failures > 0) this.#degrade("project recall is partially unavailable", caller, owner);
		return {
			memories: uniqueMem0Memories(memories).slice(0, topK),
			...(failures > 0
				? { message: "Some project recall lanes are unavailable; results were not widened to another scope." }
				: {}),
		};
	}

	async #saveExplicit(caller: Mem0SessionState, input: MemoryBackendSaveInput, actor: "user" | "assistant"): Promise<MemoryBackendSaveResult> {
		const owner = this.#snapshot(caller);
		if (!this.#isCurrent(caller, owner, false)) {
			return { backend: "mem0", stored: 0, message: "Mem0 save was discarded because the session scope changed." };
		}
		const scope = input.scope ?? "project";
		const scopeError = mem0GlobalSaveScopeError(scope, actor, caller.aliasOf !== undefined);
		if (scopeError) {
			return { backend: "mem0", stored: 0, message: scopeError };
		}
		if (!this.#canWrite(caller, owner)) {
			return { backend: "mem0", stored: 0, message: "Mem0 writes are disabled by mem0.writeEnabled." };
		}
		if (!this.#client) {
			this.#degrade("credential is unavailable", caller, owner);
			return { backend: "mem0", stored: 0, message: "Mem0 credential is unavailable." };
		}
		const content = [input.content.trim(), input.context?.trim() ? `Context: ${input.context.trim()}` : ""].filter(Boolean).join("\n\n");
		const sourceEntryId = `manual:${crypto.randomUUID()}`;
		const admitted = admitMem0Payload({
			scope,
			...(scope === "project" ? { repositoryId: this.identity.repositoryId } : {}),
			actor,
			messages: [{ role: actor === "user" ? "user" : "assistant", content }],
			source: {
				sourceKind: input.source === "retain" ? "explicit-retain" : "memory-save",
				sourceSessionId: caller.session.sessionManager.getSessionId(),
				sourceEntryIds: [sourceEntryId],
				observedAt: new Date().toISOString(),
			},
			maxChars: this.config.captureMaxChars,
			redact: this.#redactorFor(caller),
		});
		if (!admitted) return { backend: "mem0", stored: 0, message: "Memory content is empty after redaction." };
		if (!this.#canWrite(caller, owner)) {
			return { backend: "mem0", stored: 0, message: "Mem0 writes are disabled by mem0.writeEnabled." };
		}
		const entry = this.#newOutboxEntry(admitted);
		if (!(await this.outbox.enqueue([entry]))) {
			this.#degrade("outbox capacity was reached", caller, owner);
			return { backend: "mem0", stored: 0, message: "Mem0 outbox is full; no memory was sent." };
		}
		await this.flushOutbox();
		if (!this.#isCurrent(caller, owner, false)) {
			return {
				backend: "mem0",
				stored: 0,
				queued: true,
				message: "Mem0 write remains scoped to its original session but completion was not reported after the session changed.",
			};
		}
		const saved = (await this.outbox.snapshot()).entries.find(item => item.id === entry.id);
		if (saved?.state === "committed") return { backend: "mem0", stored: saved.remoteIds?.length ?? 0, ids: saved.remoteIds };
		if (saved?.state === "failed" || saved?.state === "unknown") {
			return { backend: "mem0", stored: 0, queued: false, message: `Mem0 write is ${saved.state}; it was not reported as stored.` };
		}
		return { backend: "mem0", stored: 0, queued: true, message: "Mem0 write is queued or pending remote completion." };
	}

	async #updateMemory(caller: Mem0SessionState, id: string, content: string): Promise<Mem0Memory> {
		const owner = this.#snapshot(caller);
		if (!this.#canWrite(caller, owner)) throw new Error("Mem0 writes are disabled by mem0.writeEnabled.");
		const client = this.#requireClient(caller, owner);
		const signal = this.#requestSignal(caller);
		const existing = await client.getMemory(id, signal);
		if (!this.#canWrite(caller, owner)) throw new Error("Mem0 update was discarded because write permission changed.");
		if (!isScopedMem0Memory(existing, this.identity.repositoryId)) throw new Error("Mem0 memory is outside the active project scope.");
		const text = this.#redactorFor(caller)(content).trim();
		if (!text) throw new Error("Memory content is empty after redaction.");
		const updated = await client.updateMemory(id, text, signal);
		if (!this.#canWrite(caller, owner) || !isScopedMem0Memory(updated, this.identity.repositoryId)) {
			throw new Error("Mem0 update was discarded because the session scope changed.");
		}
		return updated;
	}

	async #deleteMemory(caller: Mem0SessionState, id: string): Promise<void> {
		const owner = this.#snapshot(caller);
		if (!this.#canWrite(caller, owner)) throw new Error("Mem0 writes are disabled by mem0.writeEnabled.");
		const client = this.#requireClient(caller, owner);
		const signal = this.#requestSignal(caller);
		const existing = await client.getMemory(id, signal);
		if (!this.#canWrite(caller, owner)) throw new Error("Mem0 deletion was discarded because write permission changed.");
		if (!isScopedMem0Memory(existing, this.identity.repositoryId)) throw new Error("Mem0 memory is outside the active project scope.");
		await client.deleteMemory(id, signal);
		if (!this.#canWrite(caller, owner)) throw new Error("Mem0 deletion completed after the session scope changed.");
	}

	async #readMemory(caller: Mem0SessionState, id: string, signal?: AbortSignal): Promise<Mem0Memory> {
		const owner = this.#snapshot(caller);
		const client = this.#requireClient(caller, owner);
		const memory = await client.getMemory(id, this.#requestSignal(caller, signal));
		if (!this.#isCurrent(caller, owner)) throw new Error("Mem0 read was discarded because the session scope changed.");
		if (!isScopedMem0Memory(memory, this.identity.repositoryId) && !isGlobalPreferenceMem0Memory(memory)) {
			throw new Error("Mem0 memory is outside the active scope.");
		}
		return memory;
	}

	async loadStandingPreferences(): Promise<void> {
		if (this.aliasOf || !this.#client) return;
		const owner = this.#snapshot(this);
		try {
			const profile = await loadMem0StandingProfile(this.#client, {
				pageLimit: this.config.profilePageLimit,
				signal: this.#requestSignal(this),
			});
			if (!this.#isCurrent(this, owner, false)) return;
			if (profile.status === "ready") {
				this.#standingPreferences = profile.preferences;
				this.#profileState = { status: "ready" };
				return;
			}
			this.#standingPreferences = [];
			this.#profileState = { status: "degraded", reason: profile.reason };
			this.#degrade(profile.reason, this, owner);
		} catch {
			if (!this.#isCurrent(this, owner, false)) return;
			this.#standingPreferences = [];
			this.#profileState = { status: "degraded", reason: "Standing preferences could not be loaded." };
			this.#degrade("standing preferences could not be loaded", this, owner);
		}
	}

	async captureTerminalTurn(): Promise<void> {
		if (this.aliasOf) return;
		const owner = this.#snapshot(this);
		if (!this.#canCapture(this, owner)) return;
		const branch = this.session.sessionManager.getBranch();
		const candidate = terminalEntriesSinceCheckpoint(branch);
		if (!candidate || this.#capturingTerminalIds.has(candidate.terminalEntryId)) return;
		this.#capturingTerminalIds.add(candidate.terminalEntryId);
		const capture = this.#persistAcceptedTerminalCapture(owner, branch, candidate.terminalEntryId).finally(() => {
			this.#capturingTerminalIds.delete(candidate.terminalEntryId);
		});
		await this.#work.trackCapture(capture);
	}

	async #persistAcceptedTerminalCapture(
		owner: Mem0OwnerSnapshot,
		branch: readonly Mem0TranscriptEntry[],
		expectedTerminalEntryId: string,
	): Promise<void> {
		await persistAcceptedMem0TerminalCapture({
			outbox: this.outbox,
			repositoryId: this.identity.repositoryId,
			sessionId: owner.sessionId,
			branch,
			expectedTerminalEntryId,
			config: this.config,
			redact: this.#redactorFor(this),
			canPersist: () => this.#canPersistAcceptedCapture(),
			newOutboxEntry: admitted => this.#newOutboxEntry(admitted),
			onOutboxRejected: () => this.#degrade("outbox capacity was reached", this, owner),
			onQueued: () => {
				if (!this.#stopping && this.#canDispatch(this.#snapshot(this), this.#work.signal)) {
					void this.flushOutbox().catch(() => {
						this.#degrade("outbox synchronization could not be completed", this, owner);
					});
				}
			},
		});
	}

	#newOutboxEntry(admitted: Mem0AdmittedPayload): Mem0OutboxEntry {
		const now = new Date().toISOString();
		return {
			id: crypto.randomUUID(),
			ingestKey: admitted.ingestKey,
			repositoryId: admitted.repositoryId,
			request: admitted.request,
			source: admitted.source,
			state: "queued",
			createdAt: now,
			updatedAt: now,
			attempts: 0,
		};
	}

	async flushOutbox(signal?: AbortSignal): Promise<void> {
		if (this.aliasOf) return await this.primary.flushOutbox(signal);
		if (this.#flush) return await this.#flush;
		const owner = this.#snapshot(this);
		const client = this.#client;
		const requestSignal = this.#work.withSignal(signal);
		if (!client || !this.#canDispatch(owner, requestSignal)) return;
		this.#flush = flushMem0Outbox(
			{
				client,
				outbox: this.outbox,
				canDispatch: () => this.#canDispatch(owner, requestSignal),
				onDegraded: reason => this.#degrade(reason, this, owner),
				onDispatchStarted: id => this.#inFlightDispatchIds.add(id),
				onDispatchFinished: id => this.#inFlightDispatchIds.delete(id),
			},
			requestSignal,
		).finally(() => {
			this.#flush = undefined;
		});
		return await this.#flush;
	}


	#redactorFor(caller: Mem0SessionState): Mem0TextRedactor {
		return composeMem0TextRedactors(this.#redact, caller.#redact);
	}

	#requestSignal(caller: Mem0SessionState, signal?: AbortSignal): AbortSignal {
		if (caller === this) return this.#work.withSignal(signal);
		const signals = [this.#work.signal, caller.#work.signal];
		if (signal) signals.push(signal);
		return AbortSignal.any(signals);
	}

	#snapshot(caller: Mem0SessionState): Mem0OwnerSnapshot {
		const branch = caller.session.sessionManager.getBranch();
		return {
			sessionId: caller.session.sessionManager.getSessionId(),
			branchLeafId: branch.at(-1)?.id,
		};
	}

	#isCurrent(caller: Mem0SessionState, owner: Mem0OwnerSnapshot, checkBranch = true): boolean {
		if (this.#disposed || this.#stopping || caller.#disposed || caller.#stopping) return false;
		if (this.session.isDisposed || caller.session.isDisposed) return false;
		if (this.session.settings.get("memory.backend") !== "mem0" || caller.session.settings.get("memory.backend") !== "mem0") return false;
		if (this.session.getMem0SessionState() !== this || caller.session.getMem0SessionState() !== caller) return false;
		if (caller.session.sessionManager.getSessionId() !== owner.sessionId) return false;
		return !checkBranch || caller.session.sessionManager.getBranch().at(-1)?.id === owner.branchLeafId;
	}

	#canWrite(caller: Mem0SessionState, owner: Mem0OwnerSnapshot): boolean {
		return this.#isCurrent(caller, owner, false) && mem0WritesEnabled(caller.session.settings);
	}

	#canCapture(caller: Mem0SessionState, owner: Mem0OwnerSnapshot): boolean {
		return this.#canWrite(caller, owner) && mem0AutoCaptureEnabled(caller.session.settings);
	}

	#canDispatch(owner: Mem0OwnerSnapshot, signal: AbortSignal): boolean {
		return !signal.aborted && this.#canWrite(this, owner);
	}

	#canPersistAcceptedCapture(): boolean {
		return !this.#disposed && !this.aliasOf;
	}

	#requireClient(caller: Mem0SessionState, owner: Mem0OwnerSnapshot): Mem0Client {
		if (this.#client) return this.#client;
		this.#degrade("credential is unavailable", caller, owner);
		throw new Error("Mem0 credential is unavailable.");
	}

	#stopAcceptingWork(): void {
		this.#stopping = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	async #markInFlightDispatchesUnknown(): Promise<void> {
		if (this.#inFlightDispatchIds.size === 0) return;
		await Promise.all([...this.#inFlightDispatchIds].map(id => this.outbox.markUnknown(id, "owner-stopped")));
	}

	#degrade(reason: string, caller: Mem0SessionState, owner: Mem0OwnerSnapshot): void {
		if (!this.#isCurrent(caller, owner, false)) return;
		this.#degradedReason = reason;
		if (this.#noticedReasons.has(reason)) return;
		this.#noticedReasons.add(reason);
		caller.session.emitNotice("warning", `Mem0 memory is degraded: ${reason}. Coding continues without memory guarantees.`, "Mem0");
		logger.debug("Mem0 memory degraded", { reason });
	}
}
