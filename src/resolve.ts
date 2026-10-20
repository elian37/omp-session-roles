/**
 * Role resolution against "config layer + session overrides", using OMP's own resolver so aliases,
 * role fallbacks (`advisor`→`slow`, `tiny`→`smol`, …), fuzzy matching, and thinking suffixes behave
 * exactly as core does. Nothing here mutates settings.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import {
	formatModelStringWithRouting,
	getModelMatchPreferences,
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { formatModelRoleAlias, getRoleInfo } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { RoleOverrides } from "./state";

export interface RoleLookup {
	getModelRole(role: string): string | undefined;
}

/** Catalog surface needed for resolution (subset of OMP's `ModelRegistry`). */
export interface ModelCatalog {
	getAvailable(kind?: "all"): Model<Api>[];
	getAll(kind?: "all"): Model<Api>[];
}

/** Config-layer role lookup with session overrides on top. */
export function overlayLookup(base: RoleLookup, overrides: RoleOverrides): RoleLookup {
	return {
		getModelRole: role => (Object.hasOwn(overrides, role) ? overrides[role] : base.getModelRole(role)),
	};
}

export interface ResolvedRole {
	model: Model<Api> | undefined;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
}

export function rolePool(role: string, settings: Settings, catalog: ModelCatalog): Model<Api>[] {
	const { accepts } = getRoleInfo(role, settings);
	return catalog.getAvailable("all").filter(model => accepts(model));
}

/** Resolve what `@role` points at with `overrides` applied. */
export function resolveRole(
	role: string,
	settings: Settings,
	overrides: RoleOverrides,
	catalog: ModelCatalog,
): ResolvedRole {
	const resolved = resolveModelRoleValue(formatModelRoleAlias(role), rolePool(role, settings, catalog), {
		settings,
		roleLookup: overlayLookup(settings, overrides),
		matchPreferences: getModelMatchPreferences(settings),
	});
	return {
		model: resolved.model,
		thinkingLevel: resolved.thinkingLevel,
		explicitThinkingLevel: resolved.explicitThinkingLevel,
	};
}

export function modelKey(model: Model<Api>): string {
	return formatModelStringWithRouting(model);
}

export function formatRoleValue(model: Model<Api>, thinkingLevel: ConfiguredThinkingLevel | undefined): string {
	return thinkingLevel ? `${modelKey(model)}:${thinkingLevel}` : modelKey(model);
}

export type Validation =
	| { ok: true; role: string; value: string; model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel }
	| { ok: false; role: string; error: string };

/**
 * Validate `input` (model id, `provider/id`, fuzzy name, or `@role`, optionally `:thinking`) for `role`
 * against authenticated models accepted by the role. On success returns the canonical value to store
 * (`provider/id[:thinking]`); on failure says whether the model is unknown, unauthenticated, or the
 * wrong kind for the role.
 */
export function validateRoleValue(
	role: string,
	input: string,
	settings: Settings,
	overrides: RoleOverrides,
	catalog: ModelCatalog,
): Validation {
	const selector = input.trim();
	if (!selector) return { ok: false, role, error: `角色 ${role} 的模型为空` };
	const lookup = overlayLookup(settings, overrides);
	const matchPreferences = getModelMatchPreferences(settings);
	const resolved = resolveModelRoleValue(selector, rolePool(role, settings, catalog), {
		settings,
		roleLookup: lookup,
		matchPreferences,
	});
	if (resolved.model) {
		const thinkingLevel = resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined;
		return {
			ok: true,
			role,
			value: formatRoleValue(resolved.model, thinkingLevel),
			model: resolved.model,
			thinkingLevel,
		};
	}
	const anywhere = resolveModelRoleValue(selector, catalog.getAll("all"), {
		settings,
		roleLookup: lookup,
		matchPreferences,
	}).model;
	if (!anywhere) {
		return { ok: false, role, error: `找不到模型「${selector}」（不在当前模型目录中）` };
	}
	const name = modelKey(anywhere);
	if (!getRoleInfo(role, settings).accepts(anywhere)) {
		return { ok: false, role, error: `模型 ${name} 不适用于角色 ${role}（模型种类不匹配）` };
	}
	return { ok: false, role, error: `模型 ${name} 存在，但当前没有可用凭据（未登录/未认证，或 provider 已禁用）` };
}

/**
 * Rewrite a subagent spawn's model patterns for session overrides.
 *
 * `patterns` is what core expanded from the `@modelRole` source using config only. The role's
 * config-only expansion is recomputed and located at the head of `patterns` (optionally with a
 * uniform `:thinking` suffix from a source such as `@task:high`); that head is replaced by the
 * expansion with overrides applied and any trailing patterns are kept. Returns `undefined` when the
 * overrides do not change this role's chain (including nested aliases and default inheritance).
 */
export function rewriteSpawnPatterns(
	modelRole: string | undefined,
	patterns: readonly string[],
	base: RoleLookup,
	overrides: RoleOverrides,
): string[] | undefined {
	if (!modelRole || Object.keys(overrides).length === 0) return undefined;
	const alias = formatModelRoleAlias(modelRole);
	const baseline = resolveConfiguredModelPatterns(alias, base);
	const next = resolveConfiguredModelPatterns(alias, overlayLookup(base, overrides));
	// Patterns never contain newlines, so joining is an exact list comparison.
	if (next.length === 0 || next.join("\n") === baseline.join("\n")) return undefined;

	const head = patterns.slice(0, baseline.length);
	const tail = patterns.slice(baseline.length);
	if (head.join("\n") === baseline.join("\n")) return [...next, ...tail];
	const suffix = uniformSuffix(head, baseline);
	if (suffix !== undefined) return [...next.map(pattern => `${pattern}:${suffix}`), ...tail];
	return next;
}

function uniformSuffix(head: readonly string[], baseline: readonly string[]): string | undefined {
	if (baseline.length === 0 || head.length !== baseline.length) return undefined;
	let suffix: string | undefined;
	for (let index = 0; index < baseline.length; index++) {
		const prefix = `${baseline[index]}:`;
		if (!head[index].startsWith(prefix)) return undefined;
		const candidate = head[index].slice(prefix.length);
		if (!candidate || (suffix !== undefined && candidate !== suffix)) return undefined;
		suffix = candidate;
	}
	return suffix;
}
