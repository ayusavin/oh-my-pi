import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { admitMem0Payload } from "@oh-my-pi/pi-coding-agent/mem0/admission";
import {
	terminalCheckpointForBranch,
	terminalEntriesSinceCheckpoint,
	toolResultSourcePath,
	type Mem0TranscriptEntry,
} from "@oh-my-pi/pi-coding-agent/mem0/capture";
import { mem0AutoCaptureEnabled, mem0WritesEnabled } from "@oh-my-pi/pi-coding-agent/mem0/permissions";
import { loadMem0StandingProfile, type Mem0ProfileClient } from "@oh-my-pi/pi-coding-agent/mem0/profile";
import { renderMem0PromptContext } from "@oh-my-pi/pi-coding-agent/mem0/prompt-context";
import { composeMem0TextRedactors } from "@oh-my-pi/pi-coding-agent/mem0/redaction-context";
import { mem0GlobalSaveScopeError } from "@oh-my-pi/pi-coding-agent/mem0/save-scope";
import { MEM0_APP_ID, MEM0_USER_ID, type Mem0Memory } from "@oh-my-pi/pi-coding-agent/mem0/types";
import { Mem0WorkScope } from "@oh-my-pi/pi-coding-agent/mem0/work";
import { parseMemorySaveInput } from "@oh-my-pi/pi-coding-agent/memory-backend/save-input";

function standingPreference(id: string, memory: string, overrides: Partial<Mem0Memory> = {}): Mem0Memory {
	return {
		id,
		memory,
		userId: MEM0_USER_ID,
		appId: MEM0_APP_ID,
		metadata: { memory_scope: "global-preference" },
		...overrides,
	};
}

describe("Mem0 session runtime", () => {
	it("loads every global profile page before rendering first-turn preferences", async () => {
		const first = standingPreference("11111111-1111-4111-8111-111111111111", "Use concise review summaries.");
		const second = standingPreference("22222222-2222-4222-8222-222222222222", "Reply in Russian when asked in Russian.");
		const superseded = standingPreference("33333333-3333-4333-8333-333333333333", "Do not render this.", {
			replacedBy: "44444444-4444-4444-8444-444444444444",
		});
		const foreignAgent = standingPreference("55555555-5555-4555-8555-555555555555", "Another agent's standing fact.", {
			appId: undefined,
		});
		const requestedPages: number[] = [];
		const requestedFilters: Record<string, unknown>[] = [];
		const client: Mem0ProfileClient = {
			async list(filters, options) {
				const page = options?.page ?? 1;
				requestedFilters.push(filters);
				requestedPages.push(page);
				if (page === 1) return { count: 3, next: "page-2", results: [first, first, foreignAgent] };
				return { count: 3, next: null, results: [second, superseded] };
			},
		};

		const loaded = await loadMem0StandingProfile(client, { pageLimit: 4, now: Date.parse("2026-09-17T00:00:00.000Z") });
		if (loaded.status !== "ready") throw new Error("Expected complete global profile.");
		const rendered = renderMem0PromptContext({
			profile: loaded.preferences,
			profileState: { status: "ready" },
			project: [],
			budget: { maxChars: 4_000, maxTokens: 1_000 },
		});

		expect(requestedPages).toEqual([1, 2]);
		expect(requestedFilters).toEqual([
			{ user_id: MEM0_USER_ID, app_id: MEM0_APP_ID, metadata: { memory_scope: "global-preference" } },
			{ user_id: MEM0_USER_ID, app_id: MEM0_APP_ID, metadata: { memory_scope: "global-preference" } },
		]);
		expect(loaded.preferences.map(memory => memory.id)).toEqual([first.id, second.id]);
		expect(rendered.context).toContain(first.memory);
		expect(rendered.context).toContain(second.memory);
	});

	it("reports profile pagination exhaustion instead of treating the first page as complete", async () => {
		const client: Mem0ProfileClient = {
			async list() {
				return {
					count: 2,
					next: "page-2",
					results: [standingPreference("66666666-6666-4666-8666-666666666666", "First page only")],
				};
			},
		};

		await expect(loadMem0StandingProfile(client, { pageLimit: 1 })).resolves.toEqual({
			status: "degraded",
			preferences: [],
			reason: "standing preference profile exceeded the configured page budget",
		});
	});

	it("reports explicit degraded state while the first-turn profile is still loading", () => {
		const rendered = renderMem0PromptContext({
			profile: [standingPreference("44444444-4444-4444-8444-444444444444", "Unconfirmed profile value")],
			profileState: {
				status: "loading",
				reason: "Standing preference profile did not finish within 2000 ms.",
			},
			project: [],
			budget: { maxChars: 4_000, maxTokens: 1_000 },
		});

		expect(rendered.context).toContain('<mem0_memory_status state="degraded">');
		expect(rendered.context).toContain("Standing preference profile did not finish within 2000 ms.");
		expect(rendered.context).not.toContain("Unconfirmed profile value");
	});

	it("reports a degraded profile instead of injecting a partial profile over budget", () => {
		const completePreference = standingPreference("55555555-5555-4555-8555-555555555555", "x".repeat(500));
		const rendered = renderMem0PromptContext({
			profile: [completePreference],
			profileState: { status: "ready" },
			project: [],
			budget: { maxChars: 512, maxTokens: 128 },
		});

		expect(rendered.profileOverflow).toBe(true);
		expect(rendered.context).toContain('<mem0_memory_status state="degraded">');
		expect(rendered.context?.length).toBeLessThanOrEqual(512);
		expect(rendered.context).not.toContain(completePreference.memory);
	});

	it("reads write permission and automatic capture from live settings", () => {
		const settings = Settings.isolated({
			"memory.backend": "mem0",
			"mem0.writeEnabled": true,
			"mem0.autoCapture": true,
		});
		expect(mem0WritesEnabled(settings)).toBe(true);
		expect(mem0AutoCaptureEnabled(settings)).toBe(true);

		settings.override("mem0.writeEnabled", false);
		expect(mem0WritesEnabled(settings)).toBe(false);
		expect(mem0AutoCaptureEnabled(settings)).toBe(false);

		settings.override("mem0.writeEnabled", true);
		settings.override("mem0.autoCapture", false);
		expect(mem0WritesEnabled(settings)).toBe(true);
		expect(mem0AutoCaptureEnabled(settings)).toBe(false);
	});

	it("captures only entries after the persisted terminal checkpoint, including a developer continuation", () => {
		const branch: Mem0TranscriptEntry[] = [
			{
				id: "user-1",
				timestamp: "2026-09-17T00:00:00.000Z",
				type: "message",
				message: { role: "user", content: "Initial request" },
			},
			{
				id: "assistant-1",
				timestamp: "2026-09-17T00:00:01.000Z",
				type: "message",
				message: { role: "assistant", content: "Initial answer", stopReason: "stop" },
			},
			{
				id: "developer-2",
				timestamp: "2026-09-17T00:00:02.000Z",
				type: "message",
				message: { role: "developer", content: "Continue the prior task." },
			},
			{
				id: "tool-2",
				timestamp: "2026-09-17T00:00:03.000Z",
				type: "message",
				message: {
					role: "toolResult",
					content: "Protected file contents",
					toolName: "read",
					details: { meta: { source: { type: "path", value: "/repo/.env" } } },
				},
			},
			{
				id: "assistant-2",
				timestamp: "2026-09-17T00:00:04.000Z",
				type: "message",
				message: { role: "assistant", content: "Continuation answer", stopReason: "stop" },
			},
		];
		const checkpoints = [
			{
				sessionId: "session-1",
				terminalEntryId: "assistant-1",
				ingestKeys: ["ingest-1"],
				createdAt: "2026-09-17T00:00:01.000Z",
			},
		];
		const checkpointId = terminalCheckpointForBranch(branch, checkpoints, "session-1");
		const capture = terminalEntriesSinceCheckpoint(branch, checkpointId);

		expect(capture?.terminalEntryId).toBe("assistant-2");
		expect(capture?.entries.map(entry => entry.id)).toEqual(["tool-2", "assistant-2"]);
		expect(capture?.entries[0]?.sourcePath).toBe("/repo/.env");
		expect(toolResultSourcePath({ role: "toolResult", details: { resolvedPath: "/repo/id_ed25519" } })).toBe("/repo/id_ed25519");
	});

	it("drains accepted terminal capture before releasing its work scope", async () => {
		let finishCapture: (() => void) | undefined;
		const capture = new Promise<void>(resolve => {
			finishCapture = resolve;
		});
		const work = new Mem0WorkScope();
		void work.trackCapture(capture);
		work.stop();
		let drained = false;
		const drain = work.drainCaptures().then(() => {
			drained = true;
		});

		await Promise.resolve();
		expect(work.signal.aborted).toBe(true);
		expect(drained).toBe(false);
		if (!finishCapture) throw new Error("Expected capture resolver.");
		finishCapture();
		await drain;
		expect(drained).toBe(true);
	});

	it("applies caller-specific redaction before the primary session redactor", () => {
		const redactor = composeMem0TextRedactors(
			text => text.replace("primary-secret", "[PRIMARY]"),
			text => text.replace("caller-secret", "[CALLER]"),
		);

		expect(redactor("caller-secret primary-secret")).toBe("[CALLER] [PRIMARY]");
	});

	it("accepts only explicit primary user global saves", () => {
		const parsed = parseMemorySaveInput("--global Always use exact paths.");
		expect(parsed).toEqual({ content: "Always use exact paths.", scope: "global-preference" });
		if (!parsed) throw new Error("Expected global save input.");
		expect(parseMemorySaveInput("Keep this project fact.")).toEqual({ content: "Keep this project fact.", scope: "project" });
		expect(mem0GlobalSaveScopeError("global-preference", "assistant", false)).toBe(
		"Only an explicit user save may use the global-preference scope.",
	);
		expect(mem0GlobalSaveScopeError("global-preference", "user", true)).toBe(
		"Global preferences can be saved only from the primary Mem0 session.",
	);

		const admitted = admitMem0Payload({
			scope: "global-preference",
			actor: "user",
			messages: [{ role: "user", content: parsed.content }],
			source: {
				sourceKind: "memory-save",
				sourceSessionId: "session-1",
				sourceEntryIds: ["entry-1"],
				observedAt: "2026-09-17T00:00:00.000Z",
			},
			maxChars: 1_000,
		});
		expect(admitted?.request).toMatchObject({ user_id: MEM0_USER_ID, app_id: MEM0_APP_ID });
		expect(admitted?.request).not.toHaveProperty("agent_id");
		expect(admitted?.request).not.toHaveProperty("run_id");
		expect(
			admitMem0Payload({
				scope: "global-preference",
				actor: "assistant",
				messages: [{ role: "assistant", content: "Assistant fact" }],
				source: {
					sourceKind: "explicit-retain",
					sourceSessionId: "session-1",
					sourceEntryIds: ["entry-2"],
					observedAt: "2026-09-17T00:00:00.000Z",
				},
				maxChars: 1_000,
			}),
		).toBeUndefined();
	});
});
