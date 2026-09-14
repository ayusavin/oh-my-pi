/**
 * Prints the live values of the context-budget settings, resolved the way the
 * session resolves them. Confirms an edit to config.yml actually landed on the
 * keys the runtime reads, without calling a model.
 *
 * Usage: bun scripts/.settings-check.ts
 */
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";

await Settings.init({ cwd: process.cwd() });

const keys = [
	"compaction.enabled",
	"compaction.methodOrder",
	"compaction.thresholdTokens",
	"compaction.thresholdPercent",
	"compaction.keepRecentTokens",
	"compaction.reserveTokens",
	"compaction.midTurnEnabled",
	"compaction.asyncEnabled",
	"compaction.supersedeReads",
	"compaction.dropUseless",
	"compaction.idleEnabled",
	"compaction.idleThresholdTokens",
	"compaction.idleTimeoutSeconds",
	"tools.artifactSpillThreshold",
	"tools.artifactTailLines",
	"tools.outputMaxColumns",
	"read.defaultLimit",
	"recap.enabled",
	"includeWorkspaceTree",
	"extendedContext",
];
for (const key of keys) {
	const value = settings.get(key as Parameters<typeof settings.get>[0]);
	console.log(key.padEnd(32), JSON.stringify(value));
}
