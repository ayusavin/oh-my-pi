/**
 * Owns asynchronous Mem0 work for one session state. Captures accepted before
 * shutdown are tracked separately because they must reach durable local storage
 * before the state is released; all remote work shares the abort signal.
 */
export class Mem0WorkScope {
	readonly #controller = new AbortController();
	readonly #captureTasks = new Set<Promise<void>>();

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	stop(): void {
		this.#controller.abort();
	}

	withSignal(signal?: AbortSignal): AbortSignal {
		if (!signal || signal === this.#controller.signal) return this.#controller.signal;
		return AbortSignal.any([this.#controller.signal, signal]);
	}

	trackCapture(task: Promise<void>): Promise<void> {
		this.#captureTasks.add(task);
		return task.finally(() => {
			this.#captureTasks.delete(task);
		});
	}

	async drainCaptures(): Promise<void> {
		while (this.#captureTasks.size > 0) {
			await Promise.allSettled([...this.#captureTasks]);
		}
	}
}
