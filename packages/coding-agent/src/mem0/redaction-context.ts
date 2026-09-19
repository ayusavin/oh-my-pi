import type { Mem0TextRedactor } from "./redact";

/** Apply the caller's secret filter before the primary session's filter. */
export function composeMem0TextRedactors(primary: Mem0TextRedactor, caller: Mem0TextRedactor): Mem0TextRedactor {
	if (primary === caller) return primary;
	return text => primary(caller(text));
}
