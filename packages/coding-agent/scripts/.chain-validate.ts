/**
 * Validates the live retry.fallbackChains config the way the session does at
 * startup, printing every warning the runtime would print — without calling a
 * model. Answers one question: do the role-alias entries resolve?
 *
 * Usage: bun scripts/.chain-validate.ts
 */
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	findRetryFallbackCandidates,
	validateRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

await Settings.init({ cwd: process.cwd() });
const authStorage = await AuthStorage.create(`${process.env.HOME}/.omp/agent/agent.db`);
const registry = new ModelRegistry(authStorage);

const warnings: string[] = [];
validateRetryFallbackChains(settings, registry, () => false, message => warnings.push(message));
console.log("warnings:", warnings.length === 0 ? "none" : "");
for (const warning of warnings) console.log(" -", warning);

const chains = settings.get("retry.fallbackChains") as Record<string, string[]>;
const context = {
	chains,
	modelLookup: registry,
	getModelRole: (role: string) => settings.getModelRole(role),
};
for (const role of Object.keys(chains)) {
	const primary = settings.getModelRole(role);
	const candidates = findRetryFallbackCandidates(context, role, primary ?? role);
	console.log(
		`${role.padEnd(16)} primary=${String(primary).padEnd(34)} -> ${candidates.map(candidate => candidate.raw ?? candidate.id).join(" -> ")}`,
	);
}
authStorage.close();
