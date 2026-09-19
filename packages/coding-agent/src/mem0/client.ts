import { isRecord } from "@oh-my-pi/pi-utils";
import { MEM0_API_ORIGIN, type Mem0AddRequest, type Mem0AddResponse, type Mem0Event, type Mem0ListResponse, type Mem0Memory, type Mem0SearchResponse } from "./types";

const MAX_RESPONSE_BYTES = 1_048_576;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class Mem0HttpError extends Error {
	constructor(
		readonly status: number,
		readonly retryAfterMs: number | undefined,
	) {
		super(`Mem0 request failed with HTTP ${status}`);
	}
}

export class Mem0TransportError extends Error {
	constructor() {
		super("Mem0 request did not receive a response.");
	}
}

export class Mem0ProtocolError extends Error {
	constructor(message: string) {
		super(message);
	}
}

export interface Mem0ClientOptions {
	requestTimeoutMs: number;
	fetchImpl?: typeof fetch;
}

const EMPTY_RECORD: Record<string, unknown> = {};

function stringValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return undefined;
	return value;
}

function numberValue(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseMemory(value: unknown): Mem0Memory | undefined {
	const record = isRecord(value) ? value : undefined;
	const id = stringValue(record, "id");
	const memory = stringValue(record, "memory");
	if (!id || memory === undefined) return undefined;
	const metadata = record && isRecord(record.metadata) ? record.metadata : EMPTY_RECORD;
	return {
		id,
		memory,
		userId: stringValue(record, "user_id"),
		agentId: stringValue(record, "agent_id"),
		appId: stringValue(record, "app_id"),
		runId: stringValue(record, "run_id") ?? stringValue(record, "session_id"),
		metadata,
		categories: stringArray(record?.categories),
		expirationDate: record?.expiration_date === null ? null : stringValue(record, "expiration_date"),
		createdAt: stringValue(record, "created_at"),
		updatedAt: stringValue(record, "updated_at"),
		score: numberValue(record, "score"),
		replacedBy: record?.replaced_by === null ? null : stringValue(record, "replaced_by"),
		synthesized: typeof record?.synthesized === "boolean" ? record.synthesized : undefined,
		lifecycleState: stringValue(record, "lifecycle_state"),
	};
}

function parseMemories(value: unknown): Mem0Memory[] {
	if (!Array.isArray(value)) return [];
	const result: Mem0Memory[] = [];
	for (const item of value) {
		const memory = parseMemory(item);
		if (memory) result.push(memory);
	}
	return result;
}

function parseRetryAfter(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
	const target = Date.parse(value);
	if (!Number.isFinite(target)) return undefined;
	return Math.max(0, target - Date.now());
}

function assertUuid(id: string): void {
	if (!UUID_PATTERN.test(id)) throw new Mem0ProtocolError("Mem0 memory id must be a UUID.");
}

/**
 * Thin Platform REST client. Its origin is fixed, redirects are rejected, and
 * it does not load the Mem0 SDK or initialize telemetry.
 */
export class Mem0Client {
	readonly #apiKey: string;
	readonly #requestTimeoutMs: number;
	readonly #fetch: typeof fetch;

	constructor(apiKey: string, options: Mem0ClientOptions) {
		this.#apiKey = apiKey;
		this.#requestTimeoutMs = options.requestTimeoutMs;
		this.#fetch = options.fetchImpl ?? fetch;
	}

	async add(request: Mem0AddRequest, signal?: AbortSignal): Promise<Mem0AddResponse> {
		const body = await this.#requestJson("/v3/memories/add/", { method: "POST", body: JSON.stringify(request) }, signal);
		const record = isRecord(body) ? body : undefined;
		if (!record) throw new Mem0ProtocolError("Mem0 add returned an invalid response.");
		return {
			status: stringValue(record, "status") ?? "UNKNOWN",
			eventId: stringValue(record, "event_id"),
			results: parseMemories(record.results),
		};
	}

	async search(
		query: string,
		filters: Record<string, unknown>,
		topK: number,
		signal?: AbortSignal,
	): Promise<Mem0SearchResponse> {
		const body = await this.#requestJson(
			"/v3/memories/search/",
			{ method: "POST", body: JSON.stringify({ query, filters, top_k: topK, threshold: 0, rerank: false }) },
			signal,
		);
		const record = isRecord(body) ? body : undefined;
		return { results: parseMemories(record?.results) };
	}

	async list(
		filters: Record<string, unknown>,
		options: { page?: number; pageSize?: number; showExpired?: boolean } = {},
		signal?: AbortSignal,
	): Promise<Mem0ListResponse> {
		const body = await this.#requestJson(
			"/v3/memories/",
			{
				method: "POST",
				body: JSON.stringify({
					filters,
					page: options.page ?? 1,
					page_size: Math.max(1, Math.min(200, options.pageSize ?? 100)),
					show_expired: options.showExpired === true,
				}),
			},
			signal,
		);
		const record = isRecord(body) ? body : undefined;
		return {
			count: numberValue(record, "count") ?? 0,
			next: record?.next === null ? null : stringValue(record, "next"),
			previous: record?.previous === null ? null : stringValue(record, "previous"),
			results: parseMemories(record?.results),
		};
	}

	async getMemory(id: string, signal?: AbortSignal): Promise<Mem0Memory> {
		assertUuid(id);
		const body = await this.#requestJson(`/v1/memories/${encodeURIComponent(id)}/`, { method: "GET" }, signal);
		const memory = parseMemory(body);
		if (!memory) throw new Mem0ProtocolError("Mem0 memory read returned an invalid response.");
		return memory;
	}

	async updateMemory(id: string, text: string, signal?: AbortSignal): Promise<Mem0Memory> {
		assertUuid(id);
		const body = await this.#requestJson(
			`/v1/memories/${encodeURIComponent(id)}/`,
			{ method: "PUT", body: JSON.stringify({ text }) },
			signal,
		);
		const memory = parseMemory(body);
		if (!memory) throw new Mem0ProtocolError("Mem0 memory update returned an invalid response.");
		return memory;
	}

	async deleteMemory(id: string, signal?: AbortSignal): Promise<void> {
		assertUuid(id);
		await this.#requestJson(`/v1/memories/${encodeURIComponent(id)}/`, { method: "DELETE" }, signal);
	}

	async getEvent(id: string, signal?: AbortSignal): Promise<Mem0Event> {
		assertUuid(id);
		const body = await this.#requestJson(`/v1/event/${encodeURIComponent(id)}/`, { method: "GET" }, signal);
		const record = isRecord(body) ? body : undefined;
		if (!record) throw new Mem0ProtocolError("Mem0 event read returned an invalid response.");
		return {
			id: stringValue(record, "id") ?? id,
			status: stringValue(record, "status") ?? "UNKNOWN",
			error: stringValue(record, "error"),
			results: parseMemories(record.results),
		};
	}

	async ping(signal?: AbortSignal): Promise<void> {
		await this.#requestJson("/v1/ping/", { method: "GET" }, signal);
	}

	async #requestJson(pathname: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
		const url = new URL(pathname, MEM0_API_ORIGIN);
		if (url.origin !== MEM0_API_ORIGIN || url.protocol !== "https:") {
			throw new Mem0ProtocolError("Mem0 request origin is not approved.");
		}
		const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
		const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await this.#fetch(url, {
				...init,
				headers: {
					Accept: "application/json",
					Authorization: `Token ${this.#apiKey}`,
					...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				redirect: "error",
				signal: combinedSignal,
			});
		} catch {
			throw new Mem0TransportError();
		}

		if (!response.ok) throw new Mem0HttpError(response.status, parseRetryAfter(response.headers.get("retry-after")));
		const contentLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
			throw new Mem0ProtocolError("Mem0 response exceeds the configured size limit.");
		}
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
			throw new Mem0ProtocolError("Mem0 response exceeds the configured size limit.");
		}
		if (!text.trim()) return {};
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new Mem0ProtocolError("Mem0 returned invalid JSON.");
		}
	}
}

export function isMem0RetryableReadError(error: unknown): boolean {
	return error instanceof Mem0TransportError || (error instanceof Mem0HttpError && (error.status === 429 || error.status >= 500));
}
