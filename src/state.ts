/**
 * Session-scoped role override state and its persistence format.
 *
 * Overrides live as `custom` entries in the session JSONL (never in config files). Each entry is a
 * full snapshot stamped with the session id that wrote it, so the latest entry on the active branch
 * is authoritative and an entry copied into a fork (different session id) is recognisable as
 * inherited rather than owned.
 */

/** Role id → OMP role value (`provider/id[:thinking]`). */
export type RoleOverrides = Readonly<Record<string, string>>;

export const STATE_ENTRY_TYPE = "omp-session-roles/state";

export interface PersistedState {
	v: 1;
	/** Session id that wrote this snapshot. */
	sessionId: string;
	roles: Record<string, string>;
}

/** Minimal shape of a session entry this module reads. */
export interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
	role?: string;
}

export function parseState(data: unknown): PersistedState | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (record.v !== 1 || typeof record.sessionId !== "string") return undefined;
	const roles = record.roles;
	if (!roles || typeof roles !== "object" || Array.isArray(roles)) return undefined;
	const parsed: Record<string, string> = {};
	for (const [role, value] of Object.entries(roles)) {
		if (typeof value === "string" && value.trim()) parsed[role] = value;
	}
	return { v: 1, sessionId: record.sessionId, roles: parsed };
}

/** Latest valid state snapshot on `branch` (root → leaf order). */
export function latestState(branch: readonly EntryLike[]): PersistedState | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		const state = parseState(entry.data);
		if (state) return state;
	}
	return undefined;
}

export interface LoadedState {
	/** Overrides owned by the current session. */
	roles: Record<string, string>;
	/** Non-empty snapshot copied from another session (fork/branch); not applied until adopted. */
	inherited?: PersistedState;
}

export function loadState(branch: readonly EntryLike[], sessionId: string): LoadedState {
	const latest = latestState(branch);
	if (!latest) return { roles: {} };
	if (latest.sessionId === sessionId) return { roles: { ...latest.roles } };
	return Object.keys(latest.roles).length > 0 ? { roles: {}, inherited: latest } : { roles: {} };
}

export function withUpdates(current: RoleOverrides, updates: RoleOverrides): Record<string, string> {
	return { ...current, ...updates };
}

export function withoutRoles(current: RoleOverrides, roles: readonly string[] | "all"): Record<string, string> {
	if (roles === "all") return {};
	const next: Record<string, string> = { ...current };
	for (const role of roles) delete next[role];
	return next;
}

export function sameOverrides(a: RoleOverrides, b: RoleOverrides): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every(key => b[key] === a[key]);
}

/**
 * Role the main agent currently runs under, from the latest `model_change` on the branch.
 * `undefined` when no model change was recorded (the session started on the `default` role).
 */
export function lastModelChangeRole(branch: readonly EntryLike[]): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "model_change") return entry.role ?? "default";
	}
	return undefined;
}
