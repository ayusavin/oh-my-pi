import type { Settings } from "../config/settings";

/** Read write permission from the live session settings at the operation boundary. */
export function mem0WritesEnabled(settings: Settings): boolean {
	return settings.get("memory.backend") === "mem0" && settings.get("mem0.writeEnabled");
}

/** Automatic terminal capture requires the same live write permission. */
export function mem0AutoCaptureEnabled(settings: Settings): boolean {
	return mem0WritesEnabled(settings) && settings.get("mem0.autoCapture");
}
