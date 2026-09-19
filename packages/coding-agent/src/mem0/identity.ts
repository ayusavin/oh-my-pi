import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

export interface Mem0RepositoryIdentity {
	/** Canonical local root. Never place this path in remote metadata or logs. */
	canonicalRoot: string;
	/** Stable opaque identifier sent as metadata.repository_id. */
	repositoryId: string;
}

export interface Mem0RepositoryIdentityDeps {
	primaryRoot?(cwd: string): string | undefined;
	realpath?(target: string): Promise<string>;
}

/** Hash a canonical primary checkout path without exposing the path remotely. */
export function repositoryIdForCanonicalRoot(canonicalRoot: string): string {
	return `sha256:${createHash("sha256").update(canonicalRoot, "utf8").digest("hex")}`;
}

/**
 * Derive one repository identity for a checkout and every linked worktree.
 * Native VCS discovery reports the primary root for linked worktrees; ordinary
 * directories use their own canonical path as a conservative isolated scope.
 */
export async function deriveMem0RepositoryIdentity(
	cwd: string,
	deps: Mem0RepositoryIdentityDeps = {},
): Promise<Mem0RepositoryIdentity> {
	let primary = deps.primaryRoot?.(cwd);
	if (!primary) {
		try {
			primary = vcs.repo(cwd)?.primaryRoot() ?? undefined;
		} catch {
			primary = undefined;
		}
	}

	const candidate = path.resolve(primary ?? cwd);
	let canonicalRoot = candidate;
	try {
		canonicalRoot = await (deps.realpath ?? fs.realpath)(candidate);
	} catch {
		// A deleted/moving checkout must not inherit another repository's scope.
		canonicalRoot = candidate;
	}
	return { canonicalRoot, repositoryId: repositoryIdForCanonicalRoot(canonicalRoot) };
}
