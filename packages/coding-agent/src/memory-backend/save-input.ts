export type ExplicitMemorySaveScope = "project" | "global-preference";

export interface ParsedMemorySaveInput {
	content: string;
	scope: ExplicitMemorySaveScope;
}

/** Parse the one explicit global-preference spelling shared by TUI and ACP. */
export function parseMemorySaveInput(argument: string): ParsedMemorySaveInput | undefined {
	const globalFlag = "--global";
	if (!argument.startsWith(globalFlag) || (argument.length > globalFlag.length && !/\s/.test(argument[globalFlag.length]!))) {
		return argument ? { content: argument, scope: "project" } : undefined;
	}
	const content = argument.slice(globalFlag.length).trim();
	return content ? { content, scope: "global-preference" } : undefined;
}
