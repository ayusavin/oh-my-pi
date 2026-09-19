import { logger } from "@oh-my-pi/pi-utils";
import type {
	MemoryBackend,
	MemoryBackendOperationContext,
	MemoryBackendSaveInput,
	MemoryBackendSearchOptions,
	MemoryBackendStartOptions,
	MemoryBackendStatus,
} from "../memory-backend/types";
import mem0Instructions from "../prompts/memories/mem0.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { Mem0SessionState } from "./state";

async function replaceMem0SessionState(session: AgentSession, state: Mem0SessionState): Promise<void> {
	const previous = session.getMem0SessionState();
	if (previous) {
		await previous.drainForDispose();
		previous.dispose();
	}
	session.setMem0SessionState(state);
}

function stateFor(session: AgentSession | undefined): Mem0SessionState | undefined {
	return session?.getMem0SessionState();
}

export const mem0Backend: MemoryBackend = {
	id: "mem0",

	async start(options: MemoryBackendStartOptions): Promise<void> {
		try {
			if (options.taskDepth > 0) {
				const parent = options.parentMem0SessionState?.primary;
				if (!parent) return;
				const alias = await Mem0SessionState.createAlias(options.session, parent);
				if (!alias) return;
				await replaceMem0SessionState(options.session, alias);
				return;
			}

			const state = await Mem0SessionState.create(options.session, options.settings, options.agentDir);
			await replaceMem0SessionState(options.session, state);
			state.attachSessionListeners();
		} catch {
			logger.warn("Mem0 backend failed to initialize; coding will continue without remote memory.");
		}
	},

	async buildDeveloperInstructions(): Promise<string> {
		return mem0Instructions;
	},

	async clear(_agentDir, _cwd, session): Promise<void> {
		await stateFor(session)?.clearLocal();
	},

	async enqueue(_agentDir, _cwd, session): Promise<void> {
		await stateFor(session)?.enqueue();
	},

	async status(context: MemoryBackendOperationContext): Promise<MemoryBackendStatus> {
		const state = stateFor(context.session);
		return state
			? await state.status()
			: {
					backend: "mem0",
					active: false,
					writable: false,
					searchable: false,
					message: "Mem0 is selected but has not initialized for this session.",
				};
	},

	async search(context: MemoryBackendOperationContext, query: string, options?: MemoryBackendSearchOptions) {
		const state = stateFor(context.session);
		if (!state) return { backend: "mem0" as const, query, count: 0, items: [], message: "Mem0 is not initialized for this session." };
		return await state.searchProject(query, options);
	},

	async save(context: MemoryBackendOperationContext, input: MemoryBackendSaveInput) {
		const state = stateFor(context.session);
		if (!state) return { backend: "mem0" as const, stored: 0, message: "Mem0 is not initialized for this session." };
		return await state.saveExplicit(input, "user");
	},

	async stats(_agentDir, _cwd, session): Promise<string | undefined> {
		const state = stateFor(session);
		if (!state) return undefined;
		const status = await state.status();
		return [
			"# Mem0 Memory Status",
			"",
			`- Repository scope: \`${status.scope ?? "unavailable"}\``,
			`- ${status.message ?? "No local state."}`,
			...(status.error ? [`- ${status.error}`] : []),
		].join("\n");
	},

	async diagnose(_agentDir, _cwd, session): Promise<string | undefined> {
		return await stateFor(session)?.diagnose();
	},

	async queuePreview(context: MemoryBackendOperationContext): Promise<string | undefined> {
		return await stateFor(context.session)?.queuePreview();
	},

	async beforeAgentStartPrompt(session, promptText) {
		return await stateFor(session)?.beforeAgentStartPrompt(promptText);
	},
};
