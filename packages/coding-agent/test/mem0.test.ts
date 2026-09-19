import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import {
	admitMem0Payload,
	admitMem0TerminalTurn,
	isScopedMem0Memory,
	selectMem0StandingPreferences,
} from "@oh-my-pi/pi-coding-agent/mem0/admission";
import { Mem0Client } from "@oh-my-pi/pi-coding-agent/mem0/client";
import { isGlobalPreferenceMem0Memory } from "@oh-my-pi/pi-coding-agent/mem0/admission";
import { mem0ProfileFilters } from "@oh-my-pi/pi-coding-agent/mem0/profile";
import { deriveMem0RepositoryIdentity } from "@oh-my-pi/pi-coding-agent/mem0/identity";
import { Mem0Outbox } from "@oh-my-pi/pi-coding-agent/mem0/outbox";
import { mem0ProjectFilters } from "@oh-my-pi/pi-coding-agent/mem0/state";
import { MEM0_APP_ID, MEM0_IDENTITY, MEM0_USER_ID, type Mem0Memory, type Mem0OutboxEntry } from "@oh-my-pi/pi-coding-agent/mem0/types";

const REPOSITORY_ID = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const OUTBOX_ID = "22222222-2222-4222-8222-222222222222";

function projectMemory(overrides: Partial<Mem0Memory> = {}): Mem0Memory {
	return {
		id: OUTBOX_ID,
		memory: "A project decision.",
		userId: MEM0_USER_ID,
		appId: MEM0_APP_ID,
		metadata: { memory_scope: "project", repository_id: REPOSITORY_ID },
		...overrides,
	};
}

function outboxEntry(): Mem0OutboxEntry {
	return {
		id: OUTBOX_ID,
		ingestKey: "ingest-key",
		repositoryId: REPOSITORY_ID,
		request: {
			messages: [{ role: "user", content: "A durable project fact." }],
			metadata: { memory_scope: "project", repository_id: REPOSITORY_ID },
			infer: true,
			user_id: MEM0_USER_ID,
			app_id: MEM0_APP_ID,
		},
		source: {
			sourceKind: "terminal-turn",
			sourceSessionId: "session-1",
			sourceEntryIds: ["entry-1"],
			observedAt: "2026-09-17T00:00:00.000Z",
		},
		state: "queued",
		createdAt: "2026-09-17T00:00:00.000Z",

		updatedAt: "2026-09-17T00:00:00.000Z",
		attempts: 0,
	};
}

describe("Mem0 backend", () => {
	it("resolves the Mem0 backend only when memory.backend is mem0", async () => {
		const settings = Settings.isolated({ "memory.backend": "mem0" });
		expect((await resolveMemoryBackend(settings)).id).toBe("mem0");
	});


	it("uses one opaque repository identity for a primary checkout and linked worktree", async () => {
		const primary = await deriveMem0RepositoryIdentity("/checkout/main", {
			primaryRoot: () => "/checkout/main",
			realpath: async target => target,
		});
		const worktree = await deriveMem0RepositoryIdentity("/checkout/feature", {
			primaryRoot: () => "/checkout/main",
			realpath: async target => target,
		});

		expect(worktree.repositoryId).toBe(primary.repositoryId);
		expect(worktree.repositoryId).not.toContain("/checkout");
		expect(isScopedMem0Memory(projectMemory(), REPOSITORY_ID)).toBe(true);
		expect(isScopedMem0Memory(projectMemory(), "sha256:other-repository")).toBe(false);
	});

	it("redacts secrets before project payloads are queued or sent", () => {
		const rawToken = "ghp_012345678901234567890123456789";
		const admitted = admitMem0Payload({
			scope: "project",
			repositoryId: REPOSITORY_ID,
			actor: "user",
			messages: [{ role: "user", content: `Remember this token ${rawToken}` }],
			source: {
				sourceKind: "terminal-turn",
				sourceSessionId: "session-1",
			sourceEntryIds: ["entry-1"],
			observedAt: "2026-09-17T00:00:00.000Z",
			},
			maxChars: 1_000,
		});

		expect(admitted).toBeDefined();
		expect(JSON.stringify(admitted)).not.toContain(rawToken);
		expect(admitted?.request.metadata).toMatchObject({
			memory_scope: "project",
			repository_id: REPOSITORY_ID,
			policy_version: "omp-memory-v1",
		});
	});

	it("keeps reviewed direct imports infer:false with archive provenance in the stable payload", () => {
		const imported = admitMem0Payload({
			scope: "project",
			repositoryId: REPOSITORY_ID,
			actor: "assistant",
			messages: [{ role: "assistant", content: "A reviewed historical fact." }],
			source: {
				sourceKind: "import",
				sourceArchiveKind: "omp",
				sourceSessionId: "archive-session-1",
				sourceEntryIds: ["archive-entry-1"],
				observedAt: "2026-09-17T00:00:00.000Z",
			},
			infer: false,
			maxChars: 1_000,
		});

		expect(imported?.request.infer).toBe(false);
		expect(imported?.request.metadata).toMatchObject({
			source_kind: "import",
			source_archive_kind: "omp",
		});
		expect(imported?.ingestKey).toBe(
			admitMem0Payload({
				scope: "project",
				repositoryId: REPOSITORY_ID,
				actor: "assistant",
				messages: [{ role: "assistant", content: "A reviewed historical fact." }],
				source: {
					sourceKind: "import",
					sourceArchiveKind: "omp",
					sourceSessionId: "archive-session-1",
					sourceEntryIds: ["archive-entry-1"],
					observedAt: "2026-09-17T00:00:00.000Z",
				},
				infer: false,
				maxChars: 1_000,
			})?.ingestKey,
		);
	});

	it("admits terminal turns by actor and captures tool evidence only from an explicit allowlist", () => {
		const input = {
			repositoryId: REPOSITORY_ID,
			sessionId: "session-1",
			observedAt: "2026-09-17T00:00:00.000Z",
			entries: [
				{ id: "user-1", timestamp: "2026-09-17T00:00:00.000Z", kind: "user" as const, content: "Please remember the decision." },
				{ id: "assistant-1", timestamp: "2026-09-17T00:00:01.000Z", kind: "assistant" as const, content: "The decision is recorded." },
				{
					id: "tool-1",
					timestamp: "2026-09-17T00:00:01.000Z",
					kind: "tool" as const,
					content: "Observed verified result.",
					toolName: "read",
					toolCallId: "call-1",
					sourcePath: "/repo/docs/decision.md",
				},
			],
			maxChars: 1_000,
			toolResultMaxChars: 200,
		};
		const withoutToolEvidence = admitMem0TerminalTurn({ ...input, toolResultAllowlist: [] });
		const withToolEvidence = admitMem0TerminalTurn({ ...input, toolResultAllowlist: ["read"] });

		expect(withoutToolEvidence.map(payload => payload.request.metadata.actor_id)).toEqual(["user", "assistant"]);
		expect(withToolEvidence.map(payload => payload.request.metadata.actor_id)).toEqual(["user", "assistant", "tool"]);
		expect(withToolEvidence[2]?.request.metadata).toMatchObject({ source_ref: "tool:read#call-1" });
		expect(admitMem0TerminalTurn({ ...input, toolResultAllowlist: ["read"] }).map(payload => payload.ingestKey)).toEqual(
			withToolEvidence.map(payload => payload.ingestKey),
		);
	});

	it("requires verified non-credential sources for file evidence while preserving web evidence", () => {
		const payloads = admitMem0TerminalTurn({
			repositoryId: REPOSITORY_ID,
			sessionId: "session-evidence-provenance",
			observedAt: "2026-09-17T00:00:00.000Z",
			entries: [
				{
					id: "read-without-source",
					timestamp: "2026-09-17T00:00:00.000Z",
					kind: "tool",
					content: "Read result without verified provenance.",
					toolName: "read",
					toolCallId: "read-without-source",
				},
				{
					id: "read-whitespace-source",
					timestamp: "2026-09-17T00:00:00.000Z",
					kind: "tool",
					content: "Read result with blank provenance.",
					toolName: "read",
					toolCallId: "read-whitespace-source",
					sourcePath: " ",
				},
				{
					id: "read-mem0-key",
					timestamp: "2026-09-17T00:00:00.000Z",
					kind: "tool",
					content: "Opaque configured Mem0 key material.",
					toolName: "read",
					toolCallId: "read-mem0-key",
					sourcePath: "/home/test/.config/omp/.mem0-setup.key",
				},
				{
					id: "read-auth-store",
					timestamp: "2026-09-17T00:00:00.000Z",
					kind: "tool",
					content: "Opaque native auth store material.",
					toolName: "read",
					toolCallId: "read-auth-store",
					sourcePath: "/home/test/.config/omp/auth.json",
				},
				{
					id: "read-native-auth-storage",
					timestamp: "2026-09-17T00:00:00.000Z",
					kind: "tool",
					content: "Opaque native SQLite auth storage material.",
					toolName: "read",
					toolCallId: "read-native-auth-storage",
					sourcePath: "/home/test/.omp/agent/agent.db",
				},
				{
					id: "read-native-auth-wal",
					timestamp: "2026-09-17T00:00:00.000Z",
					kind: "tool",
					content: "Opaque native SQLite WAL material.",
					toolName: "read",
					toolCallId: "read-native-auth-wal",
					sourcePath: "/home/test/.omp/agent/agent.db-wal",
				},
				{
					id: "read-native-auth-corrupt-backup",
					timestamp: "2026-09-17T00:00:00.000Z",
					kind: "tool",
					content: "Opaque preserved native SQLite material.",
					toolName: "read",
					toolCallId: "read-native-auth-corrupt-backup",
					sourcePath: "/home/test/.omp/agent/agent.db.corrupt-1700000000000-00000000-0000-4000-8000-000000000000-shm",
				},
				{
					id: "read-safe",
					timestamp: "2026-09-17T00:00:00.000Z",
					kind: "tool",
					content: "Verified safe read result.",
					toolName: "read",
					toolCallId: "read-safe",
					sourcePath: "/repo/docs/decision.md",
				},
				{
					id: "web-search",
					timestamp: "2026-09-17T00:00:00.000Z",
					kind: "tool",
					content: "Independently verifiable web result.",
					toolName: "web_search",
					toolCallId: "web-search",
				},
			],
			maxChars: 1_000,
			toolResultMaxChars: 1_000,
			toolResultAllowlist: ["read", "web_search"],
		});

		expect(payloads.map(payload => payload.request.metadata.source_ref)).toEqual(["tool:read#read-safe", "tool:web_search#web-search"]);
		expect(JSON.stringify(payloads)).not.toContain("Read result without verified provenance.");
		expect(JSON.stringify(payloads)).not.toContain("Read result with blank provenance.");
		expect(JSON.stringify(payloads)).not.toContain("Opaque configured Mem0 key material.");
		expect(JSON.stringify(payloads)).not.toContain("Opaque native auth store material.");
		expect(JSON.stringify(payloads)).not.toContain("Opaque native SQLite auth storage material.");
		expect(JSON.stringify(payloads)).not.toContain("Opaque native SQLite WAL material.");
		expect(JSON.stringify(payloads)).not.toContain("Opaque preserved native SQLite material.");
	});

	it("loads only explicit user-only global preferences", () => {
		const profile: Mem0Memory = {
			id: "33333333-3333-4333-8333-333333333333",
			memory: "A standing preference.",
			userId: MEM0_USER_ID,
			appId: MEM0_APP_ID,
			metadata: { memory_scope: "global-preference" },
		};
		const foreignAgentGlobal: Mem0Memory = {
			id: "55555555-5555-4555-8555-555555555555",
			memory: "Another agent's standing fact.",
			userId: MEM0_USER_ID,
			metadata: { memory_scope: "global-preference" },
		};
		const project = projectMemory();
		const assistantGlobal = projectMemory({
			id: "44444444-4444-4444-8444-444444444444",
			agentId: "omp",
			metadata: { memory_scope: "global-preference" },
		});

		expect(selectMem0StandingPreferences([profile, project, assistantGlobal, foreignAgentGlobal, profile], 12)).toEqual([profile]);
	});

	it("persists queued, pending, and committed states without replaying the same terminal checkpoint", async () => {
		const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mem0-test-"));
		try {
			const outboxPath = path.join(temporaryDir, "outbox.json");
			const outbox = new Mem0Outbox(outboxPath, { maxEntries: 8, maxBytes: 100_000 });
			const entry = outboxEntry();
			const checkpoint = {
				sessionId: "session-1",
				terminalEntryId: "assistant-1",
				ingestKeys: [entry.ingestKey],
				createdAt: entry.createdAt,
			};

			expect(await outbox.enqueue([entry], checkpoint)).toBe(true);
			expect((await outbox.takeQueued(entry.id))?.state).toBe("dispatching");
			await outbox.markPending(entry.id, EVENT_ID);
			expect((await outbox.snapshot()).entries[0]?.state).toBe("pending");
			await outbox.markCommitted(entry.id, [OUTBOX_ID]);

			const reloaded = new Mem0Outbox(outboxPath, { maxEntries: 8, maxBytes: 100_000 });
			expect((await reloaded.snapshot()).entries[0]?.state).toBe("committed");
			expect(await reloaded.enqueue([entry], checkpoint)).toBe(false);
		} finally {
			await fs.rm(temporaryDir, { recursive: true, force: true });
		}
	});

	it("uses the fixed Mem0 origin and Token authorization without telemetry headers", async () => {
		let request: Request | undefined;
		const fetchImpl = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
			request = typeof input === "string" || input instanceof URL
				? new Request(String(input), init)
				: new Request(input, init);
			return new Response(JSON.stringify({ status: "PENDING", event_id: EVENT_ID }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}, { preconnect: fetch.preconnect });
		const client = new Mem0Client("test-key", { requestTimeoutMs: 1_000, fetchImpl });
		await client.add(outboxEntry().request);

		expect(request?.url).toBe("https://api.mem0.ai/v3/memories/add/");
		expect(request?.headers.get("authorization")).toBe("Token test-key");
		expect(request?.headers.get("mem0-user-id")).toBeNull();
	});

	it("paginates the list endpoint through query parameters the server actually reads", async () => {
		const requested: string[] = [];
		const bodies: Record<string, unknown>[] = [];
		const fetchImpl = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
			requested.push(String(input));
			bodies.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({ count: 225, next: null, previous: null, results: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}, { preconnect: fetch.preconnect });
		const client = new Mem0Client("test-key", { requestTimeoutMs: 1_000, fetchImpl });
		await client.list(mem0ProfileFilters(MEM0_IDENTITY), { page: 2, pageSize: 200 });
		await client.list(mem0ProfileFilters(MEM0_IDENTITY), {});

		expect(requested[0]).toBe("https://api.mem0.ai/v3/memories/?page=2&page_size=200");
		expect(requested[1]).toBe("https://api.mem0.ai/v3/memories/?page=1&page_size=100");
		expect(bodies[0]).toEqual({
			filters: { user_id: MEM0_USER_ID, app_id: MEM0_APP_ID, metadata: { memory_scope: "global-preference" } },
			show_expired: false,
		});
		expect(bodies[0]).not.toHaveProperty("page");
		expect(bodies[0]).not.toHaveProperty("page_size");
	});

	it("recalls standing preferences by relevance and drops a row outside this installation", async () => {
		let url: string | undefined;
		let body: Record<string, unknown> | undefined;
		const ownRow = {
			id: "33333333-3333-4333-8333-333333333333",
			memory: "A standing preference.",
			user_id: MEM0_USER_ID,
			app_id: MEM0_APP_ID,
			metadata: { memory_scope: "global-preference" },
		};
		const foreignAppRow = {
			id: "55555555-5555-4555-8555-555555555555",
			memory: "Another installation's standing fact.",
			user_id: MEM0_USER_ID,
			metadata: { memory_scope: "global-preference" },
		};
		const fetchImpl = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
			url = String(input);
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ results: [ownRow, foreignAppRow] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}, { preconnect: fetch.preconnect });
		const client = new Mem0Client("test-key", { requestTimeoutMs: 1_000, fetchImpl });
		const response = await client.search("how should I write commits", mem0ProfileFilters(MEM0_IDENTITY), 8);

		// top_k is only honoured inside the body; as a query parameter the server returns its own default.
		expect(url).toBe("https://api.mem0.ai/v3/memories/search/");
		expect(body).toMatchObject({
			filters: { user_id: MEM0_USER_ID, app_id: MEM0_APP_ID, metadata: { memory_scope: "global-preference" } },
			top_k: 8,
		});
		expect(response.results.map(memory => memory.id)).toEqual([ownRow.id, foreignAppRow.id]);
		expect(response.results.filter(memory => isGlobalPreferenceMem0Memory(memory)).map(memory => memory.id)).toEqual([ownRow.id]);
	});

	it("scopes every project search to this agent and drops rows another agent wrote", async () => {
		let body: Record<string, unknown> | undefined;
		const wireMetadata = { memory_scope: "project", repository_id: REPOSITORY_ID };
		const ownRow = { id: OUTBOX_ID, memory: "A project decision.", agent_id: MEM0_IDENTITY.agentId, app_id: MEM0_IDENTITY.appId, metadata: wireMetadata };
		const foreignRow = { id: "66666666-6666-4666-8666-666666666666", memory: "Another agent's fact.", user_id: MEM0_USER_ID, metadata: wireMetadata };
		const fetchImpl = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ results: [ownRow, foreignRow] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}, { preconnect: fetch.preconnect });
		const client = new Mem0Client("test-key", { requestTimeoutMs: 1_000, fetchImpl });
		const response = await client.search("a query", mem0ProjectFilters("assistant", REPOSITORY_ID, MEM0_IDENTITY), 5);

		expect(body?.filters).toEqual({
			agent_id: MEM0_IDENTITY.agentId,
			app_id: MEM0_IDENTITY.appId,
			metadata: { memory_scope: "project", repository_id: REPOSITORY_ID },
		});
		expect(mem0ProjectFilters("user", REPOSITORY_ID, MEM0_IDENTITY)).toEqual({
			user_id: MEM0_IDENTITY.userId,
			app_id: MEM0_IDENTITY.appId,
			metadata: { memory_scope: "project", repository_id: REPOSITORY_ID },
		});
		expect(response.results.map(memory => memory.id)).toEqual([OUTBOX_ID, foreignRow.id]);
		expect(response.results.filter(memory => isScopedMem0Memory(memory, REPOSITORY_ID)).map(memory => memory.id)).toEqual([OUTBOX_ID]);
	});
});
