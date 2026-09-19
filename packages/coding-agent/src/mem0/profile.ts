import { selectMem0StandingPreferences } from "./admission";
import { MEM0_IDENTITY, type Mem0Identity, type Mem0ListResponse, type Mem0Memory } from "./types";

export const MEM0_PROFILE_PAGE_SIZE = 200;

export interface Mem0ProfileClient {
	list(
		filters: Record<string, unknown>,
		options?: { page?: number; pageSize?: number; showExpired?: boolean },
		signal?: AbortSignal,
	): Promise<Mem0ListResponse>;
}

export type Mem0StandingProfileLoad =
	| { status: "ready"; preferences: Mem0Memory[] }
	| { status: "degraded"; preferences: []; reason: string };

function isActiveStandingPreference(memory: Mem0Memory, now: number): boolean {
	if (memory.replacedBy) return false;
	if (memory.lifecycleState?.toLowerCase() === "deleted") return false;
	if (!memory.expirationDate) return true;
	const expiration = Date.parse(memory.expirationDate);
	return !Number.isNaN(expiration) && expiration > now;
}

/**
 * Load the complete user-only standing-profile lane. The list endpoint's
 * terminal cursor is authoritative; a missing cursor or page cap is degraded
 * instead of silently presenting a partial profile as complete.
 */
export async function loadMem0StandingProfile(
	client: Mem0ProfileClient,
	options: { pageLimit: number; signal?: AbortSignal; now?: number; identity?: Mem0Identity },
): Promise<Mem0StandingProfileLoad> {
	const pageLimit = Math.max(1, Math.trunc(options.pageLimit));
	const identity = options.identity ?? MEM0_IDENTITY;
	const memories: Mem0Memory[] = [];
	for (let page = 1; page <= pageLimit; page++) {
		const response = await client.list(
			{ user_id: identity.userId, app_id: identity.appId, metadata: { memory_scope: "global-preference" } },
			{ page, pageSize: MEM0_PROFILE_PAGE_SIZE, showExpired: false },
			options.signal,
		);
		memories.push(...response.results);
		if (response.next === null) {
			const now = options.now ?? Date.now();
			return {
				status: "ready",
				preferences: selectMem0StandingPreferences(memories, Number.MAX_SAFE_INTEGER, identity).filter(memory =>
					isActiveStandingPreference(memory, now),
				),
			};
		}
		if (response.next === undefined) {
			return {
				status: "degraded",
				preferences: [],
				reason: "standing preference pagination did not provide a terminal cursor",
			};
		}
	}
	return {
		status: "degraded",
		preferences: [],
		reason: "standing preference profile exceeded the configured page budget",
	};
}
