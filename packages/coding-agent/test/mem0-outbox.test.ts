import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Mem0Outbox } from "@oh-my-pi/pi-coding-agent/mem0/outbox";
import {
	MEM0_APP_ID,
	MEM0_USER_ID,
	type Mem0OutboxEntry,
} from "@oh-my-pi/pi-coding-agent/mem0/types";

const REPOSITORY_ID = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OBSERVED_AT = "2026-09-17T00:00:00.000Z";

function outboxEntry(id: string, content = "A durable project fact."): Mem0OutboxEntry {
	return {
		id,
		ingestKey: `ingest-${id}`,
		repositoryId: REPOSITORY_ID,
		request: {
			messages: [{ role: "user", content }],
			metadata: { memory_scope: "project", repository_id: REPOSITORY_ID },
			infer: true,
			user_id: MEM0_USER_ID,
			app_id: MEM0_APP_ID,
		},
		source: {
			sourceKind: "terminal-turn",
			sourceSessionId: "session-1",
			sourceEntryIds: [`entry-${id}`],
			observedAt: OBSERVED_AT,
		},
		state: "queued",
		createdAt: OBSERVED_AT,
		updatedAt: OBSERVED_AT,
		attempts: 0,
	};
}

async function withTemporaryOutbox<T>(run: (outboxPath: string) => Promise<T>): Promise<T> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mem0-outbox-test-"));
	try {
		return await run(path.join(directory, "outbox.sqlite"));
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

async function dispatchLockArtifacts(outboxPath: string): Promise<string[]> {
	const prefix = `${path.basename(outboxPath)}.dispatch-`;
	return (await fs.readdir(path.dirname(outboxPath))).filter(
		name => name.startsWith(prefix) && name.endsWith(".lock"),
	);
}

describe("Mem0 durable outbox", () => {
	it("preserves concurrent enqueues and grants a queued entry to one client", async () => {
		await withTemporaryOutbox(async outboxPath => {
			const first = new Mem0Outbox(outboxPath, { maxEntries: 8, maxBytes: 100_000 });
			const second = new Mem0Outbox(outboxPath, { maxEntries: 8, maxBytes: 100_000 });
			const left = outboxEntry("left");
			const right = outboxEntry("right");

			expect(await Promise.all([first.enqueue([left]), second.enqueue([right])])).toEqual([true, true]);
			expect((await first.snapshot()).entries.map(entry => entry.id).sort()).toEqual([left.id, right.id]);

			const [firstClaim, secondClaim] = await Promise.all([first.takeQueued(left.id), second.takeQueued(left.id)]);
			expect([firstClaim, secondClaim].filter(claim => claim !== undefined)).toHaveLength(1);
			expect((await first.snapshot()).entries.find(entry => entry.id === left.id)).toMatchObject({
				state: "dispatching",
				attempts: 1,
			});

			if (firstClaim) {
				await first.markUnknown(left.id, "test-complete");
			} else {
				await second.markUnknown(left.id, "test-complete");
			}
			expect(await dispatchLockArtifacts(outboxPath)).toEqual([]);
		});
	});

	it("keeps a live dispatch intact and recovers an unowned interruption as unknown", async () => {
		await withTemporaryOutbox(async outboxPath => {
			const owner = new Mem0Outbox(outboxPath, { maxEntries: 8, maxBytes: 100_000 });
			const observer = new Mem0Outbox(outboxPath, { maxEntries: 8, maxBytes: 100_000 });
			const live = outboxEntry("live");
			const interrupted = { ...outboxEntry("interrupted"), state: "dispatching" as const };

			expect(await owner.enqueue([live])).toBe(true);
			expect((await owner.takeQueued(live.id))?.state).toBe("dispatching");
			await observer.markUnknown(live.id, "foreign-owner");
			expect((await observer.snapshot()).entries.find(entry => entry.id === live.id)?.state).toBe("dispatching");

			expect(await owner.enqueue([interrupted])).toBe(true);
			const recovered = await observer.snapshot();
			expect(recovered.entries.find(entry => entry.id === interrupted.id)).toMatchObject({
				state: "unknown",
				errorCode: "interrupted-dispatch",
			});
			expect(await observer.takeQueued(interrupted.id)).toBeUndefined();

			await owner.markUnknown(live.id, "test-complete");
		});
	});

	it("retires dispatch lease artifacts after repeated claims and interrupted recovery", async () => {
		await withTemporaryOutbox(async outboxPath => {
			const outbox = new Mem0Outbox(outboxPath, { maxEntries: 8, maxBytes: 100_000 });
			const entries = ["first", "second", "third"].map(id => outboxEntry(id));

			expect(await outbox.enqueue(entries)).toBe(true);
			for (const entry of entries) {
				expect((await outbox.takeQueued(entry.id))?.state).toBe("dispatching");
				await outbox.markCommitted(entry.id, [`remote-${entry.id}`]);
				expect(await dispatchLockArtifacts(outboxPath)).toEqual([]);
			}

			const interrupted = outboxEntry("interrupted-lease");
			const lockKey = crypto.randomUUID();
			expect(await outbox.enqueue([interrupted])).toBe(true);
			const database = new Database(outboxPath);
			try {
				database
					.prepare(`
UPDATE mem0_outbox_entries
SET state = 'dispatching', dispatch_owner = ?, dispatch_lock_key = ?
WHERE id = ?
`)
					.run("crashed-owner", lockKey, interrupted.id);
				await fs.writeFile(`${outboxPath}.dispatch-${lockKey}.lock`, "", { mode: 0o600 });
			} finally {
				database.close();
			}

			const recovered = await new Mem0Outbox(outboxPath, { maxEntries: 8, maxBytes: 100_000 }).snapshot();
			expect(recovered.entries.find(entry => entry.id === interrupted.id)).toMatchObject({
				state: "unknown",
				errorCode: "interrupted-dispatch",
			});
			expect(await dispatchLockArtifacts(outboxPath)).toEqual([]);
		});
	});

	it("reclaims completed records before rejecting byte-limited entries", async () => {
		await withTemporaryOutbox(async outboxPath => {
			const outbox = new Mem0Outbox(outboxPath, { maxEntries: 8, maxBytes: 10_000 });
			const completed = outboxEntry("completed", "x".repeat(6_000));
			const next = outboxEntry("next", "y".repeat(6_000));

			expect(await outbox.enqueue([completed])).toBe(true);
			expect((await outbox.takeQueued(completed.id))?.state).toBe("dispatching");
			await outbox.markCommitted(completed.id, ["remote-completed"]);

			expect(await outbox.enqueue([next])).toBe(true);
			const snapshot = await outbox.snapshot();
			expect(snapshot.entries.map(entry => entry.id)).toEqual([next.id]);
			expect(snapshot.completedIngestKeys).toContain(completed.ingestKey);
		});
	});
});
