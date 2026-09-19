import { describe, expect, it } from "bun:test";
import { admitMem0Payload, admitMem0TerminalTurn } from "@oh-my-pi/pi-coding-agent/mem0/admission";
import { createMem0TextRedactor, redactMem0Text } from "@oh-my-pi/pi-coding-agent/mem0/redact";

const REPOSITORY_ID = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OBSERVED_AT = "2026-09-17T00:00:00.000Z";

// Deliberately invalid canaries: neither value is a usable credential.
const PEM_CANARY = ["-----BEGIN PRIVATE KEY-----", "not-a-real-private-key-canary", "-----END PRIVATE KEY-----"].join("\n");
const BEARER_CANARY = "canary-bearer-token-no-authority-0123456789";
const CONFIGURED_SECRET_PREFIX = "opaqueconfiguredcanary";
const CONFIGURED_SECRET = `${CONFIGURED_SECRET_PREFIX}${"z".repeat(160)}`;
const CONFIGURED_PLACEHOLDER = "$$SESSION_CANARY$$";
const MEM0_TOKEN_CANARY = "m0-canary_token-0123456789";


describe("Mem0 egress redaction", () => {
	it("redacts PEM, Bearer, and Mem0 token canaries from standalone, query, save, and tool egress without a session obfuscator", () => {
		const text = `Search and retain this input:\n${PEM_CANARY}\nAuthorization: Bearer ${BEARER_CANARY}\nMem0 token: ${MEM0_TOKEN_CANARY}`;
		const standalone = redactMem0Text(MEM0_TOKEN_CANARY);
		const query = redactMem0Text(text);
		const saved = admitMem0Payload({
			scope: "project",
			repositoryId: REPOSITORY_ID,
			actor: "user",
			messages: [{ role: "user", content: text }],
			source: {
				sourceKind: "memory-save",
				sourceSessionId: "session-redaction",
				sourceEntryIds: ["save-redaction"],
				observedAt: OBSERVED_AT,
			},
			maxChars: 1_000,
		});
		const evidence = admitMem0TerminalTurn({
			repositoryId: REPOSITORY_ID,
			sessionId: "session-redaction",
			observedAt: OBSERVED_AT,
			entries: [
				{
					id: "tool-redaction",
					timestamp: OBSERVED_AT,
					kind: "tool",
					content: text,
					toolName: "read",
					toolCallId: "tool-call-redaction",
					sourcePath: "/repo/docs/redaction.md",
				},
			],
			maxChars: 1_000,
			toolResultMaxChars: 1_000,
			toolResultAllowlist: ["read"],
		});

		expect(saved).toBeDefined();
		expect(evidence).toHaveLength(1);
		for (const egressText of [
			standalone,
			query,
			...(saved?.request.messages.map(message => message.content) ?? []),
			...evidence.flatMap(payload => payload.request.messages.map(message => message.content)),
		]) {
			expect(egressText).not.toContain(PEM_CANARY);
			expect(egressText).not.toContain(BEARER_CANARY);
			expect(egressText).not.toContain(MEM0_TOKEN_CANARY);
			expect(egressText).toContain("[REDACTED]");
		}
	});

	it("redacts a configured secret before truncating tool evidence", () => {
		const redactor = createMem0TextRedactor({
			hasSecrets: () => true,
			obfuscate: text => text.replaceAll(CONFIGURED_SECRET, () => CONFIGURED_PLACEHOLDER),
		});
		const evidence = admitMem0TerminalTurn({
			repositoryId: REPOSITORY_ID,
			sessionId: "session-truncation",
			observedAt: OBSERVED_AT,
			entries: [
				{
					id: "tool-truncation",
					timestamp: OBSERVED_AT,
					kind: "tool",
					content: `Evidence ${CONFIGURED_SECRET} remains local.`,
					toolName: "read",
					toolCallId: "tool-call-truncation",
					sourcePath: "/repo/docs/truncation.md",
				},
			],
			maxChars: 1_000,
			toolResultMaxChars: 128,
			toolResultAllowlist: ["read"],
			redact: redactor,
		});
		const egress = evidence.flatMap(payload => payload.request.messages.map(message => message.content)).join("\n");

		expect(egress).toContain("[REDACTED]");
		expect(egress).not.toContain(CONFIGURED_SECRET);
		expect(egress).not.toContain(CONFIGURED_SECRET_PREFIX);
		expect(egress).not.toContain(CONFIGURED_PLACEHOLDER);
	});
});
