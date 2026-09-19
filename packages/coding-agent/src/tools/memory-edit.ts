import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import memoryEditDescription from "../prompts/tools/memory-edit.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryEditSchema = type({
	op: type("'update' | 'forget' | 'invalidate'").describe("memory edit operation"),
	id: type("string").describe("memory id from recall output"),
	"content?": type("string").describe("replacement content for update"),
	"importance?": type("number").describe("replacement importance for update (0–1)"),
	"replacement_id?": type("string").describe("replacement memory id for invalidate"),
});

export type MemoryEditParams = typeof memoryEditSchema.infer;

export class MemoryEditTool implements AgentTool<typeof memoryEditSchema> {
	readonly name = "memory_edit";
	readonly approval = () => {
		if (this.session.settings.get("memory.backend") === "mem0") return "write" as const;
		return "read" as const;
	};
	readonly label = "Memory Edit";
	readonly description = memoryEditDescription;
	readonly parameters = memoryEditSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Update or forget scoped long-term memories";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryEditTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "mem0" && backend !== "mnemopi") return null;
		return new MemoryEditTool(session);
	}

	async execute(_id: string, params: MemoryEditParams): Promise<AgentToolResult> {
		if (this.session.settings.get("memory.backend") === "mem0") {
			const state = this.session.getMem0SessionState?.();
			if (!state) {
				throw new Error("Mem0 backend is not initialised for this session.");
			}
			if (params.op === "update") {
				if (params.content === undefined) throw new Error("memory_edit update requires content for Mem0.");
				await state.updateMemory(params.id, params.content);
				return {
					content: [{ type: "text", text: `Mem0 memory ${params.id} updated.` }],
					details: { status: "updated", id: params.id },
				};
			}
			if (params.op === "forget") {
				await state.deleteMemory(params.id);
				return {
					content: [{ type: "text", text: `Mem0 memory ${params.id} deleted.` }],
					details: { status: "deleted", id: params.id },
				};
			}
			throw new Error("memory_edit invalidate is not supported by Mem0; use update or forget.");
		}

		const state = this.session.getMnemopiSessionState?.();
		if (!state) {
			throw new Error("Mnemopi backend is not initialised for this session.");
		}
		if (params.op === "update" && params.content === undefined && params.importance === undefined) {
			throw new Error("memory_edit update requires content or importance.");
		}

		const importance = params.importance === undefined ? undefined : Math.max(0, Math.min(1, params.importance));
		const result = state.editScopedMemory(params.op, params.id, {
			content: params.content,
			importance,
			replacementId: params.replacement_id,
		});
		const location = result.bank ? ` in bank ${result.bank}${result.store ? ` (${result.store})` : ""}` : "";
		const text =
			result.status === "not_found"
				? `Memory ${params.id} was not found${location}.`
				: result.status === "not_editable"
					? `Memory ${params.id} is a read-only fact${location}; it cannot be edited. Read it with memory://${params.id}.`
					: `Memory ${params.id} ${result.status}${location}.`;
		return {
			content: [{ type: "text", text }],
			details: result,
		};
	}
}
