import { redactMemorySecrets } from "../memory-backend/redact";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { CREDENTIAL_PATTERNS } from "../secrets/patterns";
import { PLACEHOLDER_RE } from "../secrets/placeholder";
import { compileSecretRegex } from "../secrets/regex";

export type Mem0TextRedactor = (text: string) => string;

const credentialPatterns = CREDENTIAL_PATTERNS.map(pattern => compileSecretRegex(pattern.source, pattern.flags));
const mem0PlaceholderPattern = new RegExp(PLACEHOLDER_RE.source, "g");
const mem0TokenPattern = /m0-[A-Za-z0-9_-]{20,}/g;


function redactCredentialPatterns(text: string): string {
	let redacted = text;
	for (const pattern of credentialPatterns) redacted = redacted.replace(pattern, "[REDACTED]");
	return redacted;
}



/**
 * Produce one-way redaction for the external-memory boundary. Configured
 * secrets first pass through OMP's secret matcher, then every placeholder is
 * replaced with a fixed non-reversible marker before the payload is queued or
 * sent. Credential-shaped values are redacted even when the user has not
 * enabled OMP secret configuration.
 */
export function createMem0TextRedactor(obfuscator?: Pick<SecretObfuscator, "hasSecrets" | "obfuscate">): Mem0TextRedactor {
	return (text: string): string => {
		const protectedText = obfuscator?.hasSecrets() ? obfuscator.obfuscate(text) : text;
		return redactMemorySecrets(redactCredentialPatterns(protectedText.replace(mem0PlaceholderPattern, "[REDACTED]")).replace(mem0TokenPattern, "[REDACTED]"));
	};
}

/** Redact without accessing configured secrets; used by offline import tooling. */
export const redactMem0Text: Mem0TextRedactor = createMem0TextRedactor();
