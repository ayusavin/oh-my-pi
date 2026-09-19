import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { MEM0_AGENT_ID, MEM0_APP_ID, MEM0_USER_ID, type Mem0Identity } from "./types";

export interface Mem0Config {
	apiKeyFile?: string;
	identity: Mem0Identity;
	profilePageLimit: number;
	projectRecallLimit: number;
	injectionMaxChars: number;
	injectionTokenLimit: number;
	requestTimeoutMs: number;
	startupWaitMs: number;
	captureMaxChars: number;
	toolResultMaxChars: number;
	toolResultAllowlist: string[];
	outboxMaxEntries: number;
	outboxMaxBytes: number;
}

export interface Mem0Credential {
	apiKey?: string;
	source: "environment" | "trusted-file" | "missing" | "invalid-file";
}

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CREDENTIAL_BYTES = 8_192;

function boundedNumber(value: number, fallback: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

function configuredAllowlist(value: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const item of value) {
		const normalized = item.trim();
		if (normalized) seen.add(normalized);
	}
	return [...seen];
}

export function loadMem0Config(settings: Settings): Mem0Config {
	return {
		apiKeyFile: settings.get("mem0.apiKeyFile")?.trim() || undefined,
		identity: {
			userId: MEM0_USER_ID,
			agentId: settings.get("mem0.agentId")?.trim() || MEM0_AGENT_ID,
			appId: settings.get("mem0.appId")?.trim() || MEM0_APP_ID,
		},
		profilePageLimit: boundedNumber(settings.get("mem0.profilePageLimit"), 100, 1, 1_000),
		projectRecallLimit: boundedNumber(settings.get("mem0.projectRecallLimit"), 8, 1, 32),
		injectionMaxChars: boundedNumber(settings.get("mem0.injectionMaxChars"), 16_000, 512, 200_000),
		injectionTokenLimit: boundedNumber(settings.get("mem0.injectionTokenLimit"), 4_000, 128, 50_000),
		requestTimeoutMs: boundedNumber(settings.get("mem0.requestTimeoutMs"), 15_000, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
		startupWaitMs: boundedNumber(settings.get("mem0.startupWaitMs"), 2_000, 0, 10_000),
		captureMaxChars: boundedNumber(settings.get("mem0.captureMaxChars"), 6_000, 256, 20_000),
		toolResultMaxChars: boundedNumber(settings.get("mem0.toolResultMaxChars"), 1_000, 128, 4_000),
		toolResultAllowlist: configuredAllowlist(settings.get("mem0.toolResultAllowlist") as string[]),
		outboxMaxEntries: boundedNumber(settings.get("mem0.outboxMaxEntries"), 512, 1, 4_096),
		outboxMaxBytes: boundedNumber(settings.get("mem0.outboxMaxBytes"), 2_000_000, 32_768, 16_000_000),
	};
}

function isWithin(root: string, target: string): boolean {
	return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * Read a Mem0 token only from the process environment or a file rooted under
 * the user-owned agent directory. Repository configuration can name the file
 * but cannot redirect credential reads outside that trusted directory.
 */
export async function resolveMem0Credential(agentDir: string, config: Pick<Mem0Config, "apiKeyFile">): Promise<Mem0Credential> {
	const environmentKey = process.env.MEM0_API_KEY?.trim();
	if (environmentKey) return { apiKey: environmentKey, source: "environment" };
	if (!config.apiKeyFile) return { source: "missing" };

	let trustedRoot: string;
	try {
		trustedRoot = await fs.realpath(agentDir);
	} catch {
		return { source: "invalid-file" };
	}

	const requested = path.resolve(trustedRoot, config.apiKeyFile);
	if (!isWithin(trustedRoot, requested)) return { source: "invalid-file" };

	let resolved: string;
	try {
		resolved = await fs.realpath(requested);
	} catch (error) {
		if (isEnoent(error)) return { source: "missing" };
		return { source: "invalid-file" };
	}
	if (!isWithin(trustedRoot, resolved)) return { source: "invalid-file" };

	try {
		const stat = await fs.stat(resolved);
		if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES) return { source: "invalid-file" };
		if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return { source: "invalid-file" };
		const apiKey = (await fs.readFile(resolved, "utf8")).trim();
		return apiKey ? { apiKey, source: "trusted-file" } : { source: "invalid-file" };
	} catch {
		return { source: "invalid-file" };
	}
}
