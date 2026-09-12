/**
 * `advisor.display` (`all` | `blockers` | `none`) — controls only which
 * advisor notes draw in the transcript card. `all` is the default and keeps
 * upstream's card unchanged; `blockers` draws only blocker-severity notes;
 * `none` draws no card at all. In every mode the batched "advisor" message's
 * content/details — what reaches the agent's context — stay unfiltered;
 * only the card's own rendering is gated. See session-advisors.ts's yield-
 * queue batch build and `#routeAdvice`, neither of which this setting touches.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
	type AdvisorMessageDetails,
	type AdvisorNote,
	formatAdvisorBatchContent,
} from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createAdvisorMessageCard,
	resolveAdvisorDisplayMode,
} from "@oh-my-pi/pi-coding-agent/modes/components/advisor-message";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

let uiTheme: Theme;

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("theme unavailable");
	uiTheme = theme;
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

function plain(lines: readonly string[]): string {
	return Bun.stripANSI(lines.join("\n"));
}

const NOTES: AdvisorNote[] = [
	{ note: "deleting the wrong file", severity: "blocker" },
	{ note: "watch the empty case", severity: "nit" },
];

describe("advisor.display", () => {
	it("defaults to all", () => {
		expect(settings.get("advisor.display")).toBe("all");
	});

	it("all draws every note, blocking and non-blocking alike — upstream's card, unchanged", () => {
		const card = createAdvisorMessageCard({ notes: NOTES }, () => true, uiTheme, settings.get("advisor.display"));
		expect(card).toBeDefined();
		const text = plain(card!.render(80));
		expect(text).toContain("2 notes");
		expect(text).toContain("1 blocker");
		expect(text).toContain("deleting the wrong file");
		expect(text).toContain("watch the empty case");
	});

	it("blockers draws the blocking note and omits the non-blocking one", () => {
		settings.set("advisor.display", "blockers");
		const card = createAdvisorMessageCard({ notes: NOTES }, () => true, uiTheme, settings.get("advisor.display"));
		expect(card).toBeDefined();
		const text = plain(card!.render(80));
		expect(text).toContain("1 note");
		expect(text).toContain("deleting the wrong file");
		expect(text).not.toContain("watch the empty case");
	});

	it("blockers draws no card when the batch has no blocking note", () => {
		settings.set("advisor.display", "blockers");
		const card = createAdvisorMessageCard(
			{ notes: [{ note: "watch the empty case", severity: "nit" }] },
			() => true,
			uiTheme,
			settings.get("advisor.display"),
		);
		expect(card).toBeUndefined();
	});

	it("none draws no card, blocking or not", () => {
		settings.set("advisor.display", "none");
		const card = createAdvisorMessageCard({ notes: NOTES }, () => true, uiTheme, settings.get("advisor.display"));
		expect(card).toBeUndefined();
	});

	it("resolveAdvisorDisplayMode falls back to all for any value it does not handle", () => {
		// A settings source that doesn't resolve this key (undefined), an older
		// on-disk config, or plain garbage must never be read as "none"/
		// "blockers" — only the two literal opt-in values narrow away from the
		// upstream default. This is the exact bug class compactToolCallMode
		// guards against for display.toolCalls.
		for (const unhandled of [undefined, null, "", "full", "compact", 0, "BLOCKERS", "All"]) {
			expect(resolveAdvisorDisplayMode(unhandled)).toBe("all");
		}
		expect(resolveAdvisorDisplayMode("blockers")).toBe("blockers");
		expect(resolveAdvisorDisplayMode("none")).toBe("none");
	});

	for (const mode of ["all", "blockers", "none"] as const) {
		it(`${mode}: the batched message payload still carries every note for the agent's context`, () => {
			settings.set("advisor.display", mode);

			// Mirrors SessionAdvisors#routeAdvice / the yield-queue batch build in
			// session-advisors.ts: content is computed once, unconditionally,
			// before any transcript rendering runs. advisor.display never reaches
			// that code path.
			const content = formatAdvisorBatchContent(NOTES);
			expect(content).toContain("deleting the wrong file");
			expect(content).toContain("watch the empty case");

			// Card rendering must never filter the message's own payload.
			const details: AdvisorMessageDetails = { notes: NOTES };
			createAdvisorMessageCard(details, () => true, uiTheme, settings.get("advisor.display"));
			expect(details.notes).toBe(NOTES);
			expect(details.notes).toHaveLength(2);
		});
	}
});
