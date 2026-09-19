export function mem0GlobalSaveScopeError(
	scope: "project" | "global-preference",
	actor: "user" | "assistant",
	isAlias: boolean,
): string | undefined {
	if (scope !== "global-preference") return undefined;
	if (actor !== "user") return "Only an explicit user save may use the global-preference scope.";
	if (isAlias) return "Global preferences can be saved only from the primary Mem0 session.";
	return undefined;
}
