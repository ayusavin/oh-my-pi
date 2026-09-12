import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
	validateRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";

function createContext(
	chains: RetryFallbackResolutionContext["chains"],
	roles: Record<string, string> = {},
	explicitChains?: RetryFallbackResolutionContext["chains"],
): RetryFallbackResolutionContext {
	const models = [
		getBundledModel("google", "gemini-2.5-flash"),
		getBundledModel("google-vertex", "gemini-2.5-flash"),
		getBundledModel("openrouter", "google/gemini-2.5-flash"),
		getBundledModel("openai", "gpt-4o-mini"),
	].filter(model => model !== undefined);
	return {
		chains,
		getModelRole: role => roles[role],
		modelLookup: {
			find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
			hasProvider: provider => models.some(model => model.provider === provider),
		},
		...(explicitChains ? { isExplicitChain: (chainKey: string) => Array.isArray(explicitChains[chainKey]) } : {}),
	};
}

describe("retry fallback selector resolution", () => {
	it("resolves chain keys by exact model, longest wildcard, role, then default", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const exactContext = createContext(
			{
				default: ["openai/gpt-4o-mini"],
				task: ["google/gemini-2.5-flash"],
				"openrouter/*": ["openai/gpt-4o-mini"],
				"openrouter/google/*": ["google-vertex/*"],
				[selector]: ["google/gemini-2.5-flash"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(exactContext, selector, undefined, "task")).toBe(selector);

		const wildcardContext = createContext(
			{
				default: ["openai/gpt-4o-mini"],
				task: ["google/gemini-2.5-flash"],
				"openrouter/*": ["openai/gpt-4o-mini"],
				"openrouter/google/*": ["google-vertex/*"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(wildcardContext, selector, undefined, "task")).toBe("openrouter/google/*");

		const roleContext = createContext(
			{ default: ["openai/gpt-4o-mini"], task: ["google/gemini-2.5-flash"] },
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(roleContext, selector, undefined, "task")).toBe("task");

		const defaultContext = createContext({ default: ["openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(defaultContext, selector)).toBe("default");
	});

	it("does not let a later shared-assignment role steal the default chain", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const context = createContext(
			{
				vision: ["openai/gpt-4o-mini"],
				default: ["google/gemini-2.5-flash"],
			},
			{ default: selector, vision: selector },
		);
		expect(resolveRetryFallbackChainKey(context, selector)).toBe("default");
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "default")).toBe("default");
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "vision")).toBe("vision");
	});

	it("uses a hinted role chain when its unqualified primary cannot resolve", () => {
		const context = createContext({ task: ["openai/gpt-4o-mini"] });
		const chainKey = resolveRetryFallbackChainKey(context, "missing-model:high", undefined, "task");
		expect(chainKey).toBe("task");
		if (!chainKey) throw new Error("Expected hinted role fallback chain");
		expect(
			findRetryFallbackCandidates(context, chainKey, "missing-model:high", undefined, {
				allowMissingPrimary: true,
			}),
		).toEqual([
			{
				raw: "openai/gpt-4o-mini",
				provider: "openai",
				id: "gpt-4o-mini",
				thinkingLevel: undefined,
			},
		]);
	});

	it("stops a role chain when its primary assignment is removed at runtime", () => {
		const context = createContext({
			slow: ["google/gemini-2.5-flash", "openai/gpt-4o-mini"],
		});
		expect(findRetryFallbackCandidates(context, "slow", "google/gemini-2.5-flash")).toEqual([]);
	});

	it("expands wildcard candidates from the current selector", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const context = createContext({ "openrouter/google/*": ["google-vertex/*"] });
		const candidates = findRetryFallbackCandidates(context, "openrouter/google/*", selector);
		expect(candidates).toEqual([
			{
				raw: "google-vertex/gemini-2.5-flash",
				provider: "google-vertex",
				id: "gemini-2.5-flash",
				thinkingLevel: undefined,
			},
		]);
	});

	it("re-resolves fallback aliases after role reassignment", () => {
		const roles = {
			default: "@primary",
			primary: "google/gemini-2.5-flash",
			fallback: "@target",
			target: "openai/gpt-4o-mini",
		};
		const context = createContext({ default: ["@fallback"] }, roles);

		expect(findRetryFallbackCandidates(context, "default", "google/gemini-2.5-flash")).toEqual([
			{
				raw: "openai/gpt-4o-mini",
				provider: "openai",
				id: "gpt-4o-mini",
				thinkingLevel: undefined,
			},
		]);

		roles.target = "google-vertex/gemini-2.5-flash";
		expect(findRetryFallbackCandidates(context, "default", "google/gemini-2.5-flash")).toEqual([
			{
				raw: "google-vertex/gemini-2.5-flash",
				provider: "google-vertex",
				id: "gemini-2.5-flash",
				thinkingLevel: undefined,
			},
		]);
	});

	it("expands nested aliases and lets the outer thinking suffix win", () => {
		const context = createContext(
			{ default: ["@fallback:high"] },
			{
				default: "@primary",
				primary: "google/gemini-2.5-flash",
				fallback: "@tier:low",
				tier: "@target:medium",
				target: "openai/gpt-4o-mini:low",
			},
		);

		expect(findRetryFallbackCandidates(context, "default", "google/gemini-2.5-flash")).toEqual([
			{
				raw: "openai/gpt-4o-mini:high",
				provider: "openai",
				id: "gpt-4o-mini",
				thinkingLevel: Effort.High,
			},
		]);
	});

	it("uses the matching explicit alias-owned chain before an inherited default", () => {
		const sharedSelector = "openrouter/google/gemini-2.5-flash";
		const routedCurrent = getBundledModel("openrouter", "google/gemini-2.5-flash");
		if (!routedCurrent) throw new Error("Expected bundled OpenRouter model");
		const configuredChains = {
			default: ["openai/gpt-4o-mini"],
			"chinese-high": ["openai/gpt-4o-mini"],
			"chinese-medium": ["google-vertex/gemini-2.5-flash"],
		};
		const context = createContext(
			expandDefaultRetryFallbackChains(configuredChains, [
				"advisor",
				"chooser",
				"unavailable",
				"chinese-high",
				"chinese-medium",
			]),
			{
				advisor: "@chooser",
				chooser: "@unavailable,@chinese-medium",
				unavailable: "google/not-a-model",
				"chinese-high": sharedSelector,
				"chinese-medium": sharedSelector,
			},
			configuredChains,
		);

		const chainKey = resolveRetryFallbackChainKey(context, `${sharedSelector}@google`, routedCurrent, "advisor");
		expect(chainKey).toBe("chinese-medium");
		if (!chainKey) throw new Error("Expected alias-owned fallback chain");
		expect(findRetryFallbackCandidates(context, chainKey, `${sharedSelector}@google`, routedCurrent)).toEqual([
			{
				raw: "google-vertex/gemini-2.5-flash",
				provider: "google-vertex",
				id: "gemini-2.5-flash",
				thinkingLevel: undefined,
			},
		]);
	});

	it("keeps an explicit hinted chain ahead of its alias-owned chain", () => {
		const sharedSelector = "google/gemini-2.5-flash";
		const configuredChains = {
			advisor: ["openai/gpt-4o-mini"],
			"chinese-medium": ["google-vertex/gemini-2.5-flash"],
		};
		const context = createContext(
			configuredChains,
			{
				advisor: "@chinese-medium",
				"chinese-medium": sharedSelector,
			},
			configuredChains,
		);

		expect(resolveRetryFallbackChainKey(context, sharedSelector, undefined, "advisor")).toBe("advisor");
	});

	it("uses an alias-owned chain for an unavailable role primary", () => {
		const context = createContext(
			{ "claude-high": ["openai/gpt-4o-mini"] },
			{
				default: "@claude-high",
				"claude-high": "google/not-a-model",
			},
			{ "claude-high": ["openai/gpt-4o-mini"] },
		);

		expect(resolveRetryFallbackChainKey(context, "@claude-high", undefined, "default")).toBe("claude-high");
	});

	it("keeps wildcard ownership ahead of alias-owned role chains", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const context = createContext(
			{
				"openrouter/google/*": ["google-vertex/*"],
				"chinese-medium": ["@gpt-high"],
			},
			{
				advisor: "@chinese-medium",
				"chinese-medium": selector,
				"gpt-high": "openai/gpt-4o-mini",
			},
		);

		const chainKey = resolveRetryFallbackChainKey(context, selector, undefined, "advisor");
		expect(chainKey).toBe("openrouter/google/*");
		if (!chainKey) throw new Error("Expected wildcard fallback chain");
		expect(findRetryFallbackCandidates(context, chainKey, selector)).toEqual([
			{
				raw: "google-vertex/gemini-2.5-flash",
				provider: "google-vertex",
				id: "gemini-2.5-flash",
				thinkingLevel: undefined,
			},
		]);
	});

	it("warns about malformed, unknown, and cyclic fallback aliases without selecting them", () => {
		const primary = getBundledModel("google", "gemini-2.5-flash");
		if (!primary) throw new Error("Expected bundled primary model");
		const modelRegistry = {
			find: (provider: string, id: string) =>
				provider === primary.provider && id === primary.id ? primary : undefined,
			hasProvider: (provider: string) => provider === primary.provider,
		} as unknown as ModelRegistry;
		const settings = Settings.isolated({
			modelRoles: {
				default: "@primary",
				primary: `${primary.provider}/${primary.id}`,
				first: "@second",
				second: "@first",
			},
			"retry.fallbackChains": {
				default: ["@", "@missing", "@first"],
			},
		});
		const warnings: string[] = [];
		validateRetryFallbackChains(settings, modelRegistry, warning => warnings.push(warning));

		expect(warnings).toEqual([
			"Fallback chain for role 'default' contains invalid role alias: @",
			"Fallback chain for role 'default' references unknown role alias: @missing",
			"Fallback chain for role 'default' references cyclic role alias: first -> second -> first",
		]);
		expect(
			findRetryFallbackCandidates(
				createContext(
					{ default: ["@", "@missing", "@first"] },
					{
						default: "google/gemini-2.5-flash",
						first: "@second",
						second: "@first",
					},
				),
				"default",
				"google/gemini-2.5-flash",
			),
		).toEqual([]);
	});

	it("inherits the default chain only for roles without an explicit chain", () => {
		const defaultChain = ["openai/gpt-4o-mini"];
		const expanded = expandDefaultRetryFallbackChains({ default: defaultChain, slow: ["google/gemini-2.5-flash"] }, [
			"default",
			"task",
			"slow",
		]);
		expect(expanded.task).toBe(defaultChain);
		expect(expanded.slow).toEqual(["google/gemini-2.5-flash"]);
	});
});
