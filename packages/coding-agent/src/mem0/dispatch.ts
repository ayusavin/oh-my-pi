import { Mem0Client, Mem0HttpError, Mem0ProtocolError, Mem0TransportError } from "./client";
import { Mem0Outbox } from "./outbox";

export interface Mem0OutboxDispatch {
	client: Mem0Client;
	outbox: Mem0Outbox;
	canDispatch(): boolean;
	onDegraded(reason: string): void;
	onDispatchStarted(id: string): void;
	onDispatchFinished(id: string): void;
}

function dispatchErrorCode(error: unknown): string {
	if (error instanceof Mem0HttpError) return `http-${error.status}`;
	if (error instanceof Mem0TransportError) return "transport";
	if (error instanceof Mem0ProtocolError) return "protocol";
	return "unknown";
}

/** Reconcile pending writes and dispatch claimed queued writes while owned. */
export async function flushMem0Outbox(dispatch: Mem0OutboxDispatch, signal: AbortSignal): Promise<void> {
	if (!dispatch.canDispatch()) return;
	const pending = (await dispatch.outbox.snapshot()).entries.filter(entry => entry.state === "pending" && entry.eventId);
	for (const entry of pending) {
		if (!dispatch.canDispatch()) return;
		try {
			const event = await dispatch.client.getEvent(entry.eventId!, signal);
			if (!dispatch.canDispatch()) return;
			if (event.status === "SUCCEEDED") {
				await dispatch.outbox.markCommitted(entry.id, event.results.map(memory => memory.id));
			} else if (event.status === "FAILED") {
				await dispatch.outbox.markFailed(entry.id, "event-failed");
				dispatch.onDegraded("a remote write event failed");
			}
		} catch (error) {
			if (!dispatch.canDispatch()) return;
			dispatch.onDegraded("pending remote writes could not be reconciled");
			if (error instanceof Mem0HttpError && error.status >= 400 && error.status < 500 && error.status !== 429) {
				await dispatch.outbox.markFailed(entry.id, dispatchErrorCode(error));
			}
		}
	}

	const queued = (await dispatch.outbox.snapshot()).entries.filter(entry => entry.state === "queued");
	for (const queuedEntry of queued) {
		if (!dispatch.canDispatch()) return;
		const entry = await dispatch.outbox.takeQueued(queuedEntry.id);
		if (!entry) continue;
		if (!dispatch.canDispatch()) {
			await dispatch.outbox.markUnknown(entry.id, "owner-stopped");
			return;
		}
		dispatch.onDispatchStarted(entry.id);
		try {
			const response = await dispatch.client.add(entry.request, signal);
			if (!dispatch.canDispatch()) {
				await dispatch.outbox.markUnknown(entry.id, "interrupted-dispatch");
				return;
			}
			if (response.status === "SUCCEEDED") {
				await dispatch.outbox.markCommitted(entry.id, response.results.map(memory => memory.id));
			} else if (response.eventId) {
				await dispatch.outbox.markPending(entry.id, response.eventId);
			} else {
				await dispatch.outbox.markUnknown(entry.id, "missing-event-id");
				dispatch.onDegraded("a remote write has an unknown outcome");
			}
		} catch (error) {
			if (!dispatch.canDispatch()) {
				await dispatch.outbox.markUnknown(entry.id, "interrupted-dispatch");
				return;
			}
			const code = dispatchErrorCode(error);
			if (error instanceof Mem0HttpError && error.status === 429) {
				await dispatch.outbox.markQueued(entry.id, code);
			} else if (error instanceof Mem0HttpError && error.status >= 400 && error.status < 500) {
				await dispatch.outbox.markFailed(entry.id, code);
			} else {
				await dispatch.outbox.markUnknown(entry.id, code);
			}
			dispatch.onDegraded("remote writes require attention");
		} finally {
			dispatch.onDispatchFinished(entry.id);
		}
	}
}
