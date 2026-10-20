/**
 * omp-session-roles — session-scoped model role overrides for Oh My Pi.
 *
 * Overrides are stored only in the session transcript (`custom` entries), never in config.yml.
 * They reach subagents through the official `before_subagent_spawn` hook (also from nested
 * subagents, via the parent session link), and the main agent switches model at a safe turn
 * boundary when its own role changes. When OMP carries the session-role core patch
 * (`pi.setSessionModelRoles`), the overlay is also handed to core so every role read in this
 * session — advisor, plan mode, ctrl+p cycling, `@role` selectors, other extensions — agrees.
 */
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { getKnownRoleIds } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { concreteThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { parseRolesArgs, USAGE } from "./commands";
import { runRolesPanel } from "./panel";
import { buildRoleRows, formatReport } from "./report";
import { formatRoleValue, modelKey, resolveRole, rewriteSpawnPatterns, validateRoleValue } from "./resolve";
import {
	lastModelChangeRole,
	loadState,
	type PersistedState,
	type RoleOverrides,
	STATE_ENTRY_TYPE,
	sameOverrides,
	withoutRoles,
} from "./state";

/** Core-patch surface (see core-patch/README.md); absent on stock OMP. */
interface CoreRoleApi {
	setSessionModelRoles(roles: RoleOverrides): void;
	getSessionModelRoles(): Record<string, string>;
}

/**
 * Live override getters by session file, shared by every session in this process so a subagent
 * session can follow its parent's overrides (`header.parentSession` is the parent session file).
 */
const liveSessions = new Map<string, () => RoleOverrides>();

const STATUS_KEY = "session-roles";
const SUBCOMMANDS = ["show", "set", "reset", "inherit", "help"];

function sessionKey(file: string): string {
	const resolved = path.resolve(file);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export default function sessionRoles(pi: ExtensionAPI): void {
	const coreCandidate = pi as unknown as Partial<CoreRoleApi>;
	const core: CoreRoleApi | undefined =
		typeof coreCandidate.setSessionModelRoles === "function" && typeof coreCandidate.getSessionModelRoles === "function"
			? (coreCandidate as CoreRoleApi)
			: undefined;
	const modeLine = core
		? "完整模式：已检测到核心补丁，主会话内所有角色解析（子 Agent、advisor、plan、@role、Ctrl+P）都使用会话覆盖"
		: "兼容模式：未检测到核心补丁；子 Agent（task/eval/workpool，含嵌套）与主 Agent 切换生效，advisor、plan 模式、/switch @role 仍读原始配置";

	let agentKind: "main" | "sub" = "main";
	let roles: Record<string, string> = {};
	let inherited: PersistedState | undefined;
	let stampedSessionId: string | undefined;
	let parentKey: string | undefined;
	let ownKey: string | undefined;
	let pendingMainSync = false;
	/** `pi.setModel` records role `default`; remember which role this extension actually switched to. */
	let mainRoleHint: { role: string; model: string } | undefined;

	const settings = (): Settings => pi.pi.settings;
	const effectiveOverrides = (): RoleOverrides =>
		agentKind === "main" ? roles : ((parentKey && liveSessions.get(parentKey)?.()) || {});

	pi.setLabel("会话模型角色");

	function unregister(): void {
		if (ownKey && liveSessions.get(ownKey) === effectiveOverrides) liveSessions.delete(ownKey);
		ownKey = undefined;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (agentKind !== "main") return;
		const names = Object.keys(roles);
		ctx.ui.setStatus(STATUS_KEY, names.length > 0 ? `会话角色覆盖：${names.join(", ")}` : undefined);
	}

	/** Re-read state for the session `ctx` now points at. */
	async function bind(ctx: ExtensionContext, transition: "start" | "switch" | "fork" | "branch" | "tree"): Promise<void> {
		unregister();
		agentKind = ctx.agent.kind;
		const manager = ctx.sessionManager;
		const file = manager.getSessionFile();
		pendingMainSync = false;
		if (agentKind === "sub") {
			const parent = manager.getHeader()?.parentSession;
			parentKey = parent ? sessionKey(parent) : undefined;
			roles = {};
			inherited = undefined;
		} else {
			parentKey = undefined;
			const loaded = loadState(manager.getBranch(), manager.getSessionId());
			roles = loaded.roles;
			inherited = loaded.inherited;
			stampedSessionId = manager.getSessionId();
		}
		if (file) {
			ownKey = sessionKey(file);
			liveSessions.set(ownKey, effectiveOverrides);
		}
		if (agentKind !== "main") return;

		core?.setSessionModelRoles(roles);
		if (inherited && transition === "branch") {
			// `/branch` continues this conversation from an earlier message in a new file: keep its overrides.
			const adopted = inherited.roles;
			inherited = undefined;
			await commit(ctx, adopted, []);
		} else if (inherited) {
			ctx.ui.notify(
				`此会话分叉自另一会话，来源会话有 ${Object.keys(inherited.roles).length} 个角色覆盖（${Object.keys(inherited.roles).join(", ")}），默认未继承。执行 /roles inherit 可显式继承。`,
				"info",
			);
		}
		updateStatus(ctx);
		if (Object.keys(roles).length > 0) {
			// Models may still be loading at startup; validate once the catalog settles.
			ctx.setTimeout(async () => {
				await ctx.modelRegistry.awaitBackgroundRefresh();
				const broken = Object.entries(roles).flatMap(([role, value]) => {
					const result = validateRoleValue(role, value, settings(), roles, ctx.modelRegistry);
					return result.ok ? [] : [`${role} → ${value}：${result.error}`];
				});
				if (broken.length > 0) {
					ctx.ui.notify(
						`以下会话角色覆盖当前不可用（相关子 Agent 启动会被拒绝，直至 /roles reset 或重新设置）：\n${broken.join("\n")}`,
						"warning",
					);
				}
			}, 0);
		}
	}

	/**
	 * Persist and apply a full override snapshot. Core overlay first (in-memory, revertible), then the
	 * session entry; if persisting throws the core overlay is restored and nothing changes.
	 */
	async function commit(ctx: ExtensionContext, next: Record<string, string>, changed: readonly string[]): Promise<void> {
		const previous = roles;
		const sessionId = ctx.sessionManager.getSessionId();
		core?.setSessionModelRoles(next);
		try {
			pi.appendEntry<PersistedState>(STATE_ENTRY_TYPE, { v: 1, sessionId, roles: next });
		} catch (error) {
			core?.setSessionModelRoles(previous);
			throw error;
		}
		roles = next;
		stampedSessionId = sessionId;
		updateStatus(ctx);
		await syncMainModel(ctx, changed);
	}

	function activeMainRole(ctx: ExtensionContext): string | undefined {
		const recorded = lastModelChangeRole(ctx.sessionManager.getBranch()) ?? "default";
		const current = ctx.model ? modelKey(ctx.model) : undefined;
		if (recorded === "default" && mainRoleHint && mainRoleHint.model === current) return mainRoleHint.role;
		// `temporary` (explicit /model, plan mode) and other non-role markers are left alone.
		return getKnownRoleIds(settings()).includes(recorded) ? recorded : undefined;
	}

	async function syncMainModel(ctx: ExtensionContext, changed: readonly string[]): Promise<void> {
		const active = activeMainRole(ctx);
		if (!active || !changed.includes(active)) return;
		if (!ctx.isIdle()) {
			pendingMainSync = true;
			ctx.ui.notify(`主 Agent 正在使用角色 ${active}：将在本轮结束后切换模型`, "info");
			return;
		}
		await switchMainModel(ctx, active);
	}

	async function switchMainModel(ctx: ExtensionContext, role: string): Promise<void> {
		const target = resolveRole(role, settings(), roles, ctx.modelRegistry);
		if (!target.model) {
			ctx.ui.notify(`角色 ${role} 无法解析为可用模型，主 Agent 模型保持不变`, "warning");
			return;
		}
		const thinking = target.explicitThinkingLevel ? target.thinkingLevel : undefined;
		if (!ctx.model || modelKey(ctx.model) !== modelKey(target.model)) {
			if (!(await pi.setModel(target.model))) {
				ctx.ui.notify(`主 Agent 无法切换到 ${modelKey(target.model)}：没有可用凭据`, "error");
				return;
			}
		}
		const level = concreteThinkingLevel(thinking);
		if (level) pi.setThinkingLevel(level);
		mainRoleHint = { role, model: modelKey(target.model) };
		ctx.ui.notify(`主 Agent（角色 ${role}）已切换到 ${formatRoleValue(target.model, thinking)}`, "info");
	}

	function scheduleMainSync(ctx: ExtensionContext): void {
		ctx.setTimeout(async () => {
			if (!pendingMainSync) return;
			if (!ctx.isIdle()) {
				scheduleMainSync(ctx);
				return;
			}
			pendingMainSync = false;
			const active = activeMainRole(ctx);
			if (active) await switchMainModel(ctx, active);
		}, 250);
	}

	async function setRoles(ctx: ExtensionContext, updates: ReadonlyArray<{ role: string; model: string }>): Promise<string[]> {
		const base = settings();
		const known = getKnownRoleIds(base);
		const errors: string[] = [];
		const staged: Record<string, string> = { ...roles };
		const applied: string[] = [];
		await ctx.modelRegistry.awaitBackgroundRefresh();
		for (const { role, model } of updates) {
			if (!known.includes(role)) {
				errors.push(`未知角色「${role}」。可用角色：${known.join(", ")}`);
				continue;
			}
			// Later entries see earlier ones, so `/roles set slow X task @slow` binds task to X.
			const result = validateRoleValue(role, model, base, staged, ctx.modelRegistry);
			if (!result.ok) {
				errors.push(`${role}：${result.error}`);
				continue;
			}
			staged[role] = result.value;
			applied.push(role);
		}
		if (errors.length > 0) return errors;
		if (sameOverrides(staged, roles)) return [];
		await commit(ctx, staged, applied);
		return [];
	}

	async function resetRoles(ctx: ExtensionContext, which: readonly string[] | "all"): Promise<void> {
		const targets = which === "all" ? Object.keys(roles) : which.filter(role => Object.hasOwn(roles, role));
		const missing = which === "all" ? [] : which.filter(role => !Object.hasOwn(roles, role));
		if (missing.length > 0) ctx.ui.notify(`这些角色没有会话覆盖，无需恢复：${missing.join(", ")}`, "info");
		if (targets.length === 0) {
			if (which === "all") ctx.ui.notify("当前会话没有角色覆盖", "info");
			return;
		}
		await commit(ctx, withoutRoles(roles, which === "all" ? "all" : targets), targets);
		ctx.ui.notify(`已恢复原始配置：${targets.join(", ")}`, "info");
	}

	function report(ctx: ExtensionContext): string {
		return formatReport(buildRoleRows(settings(), roles, ctx.modelRegistry), modeLine);
	}

	pi.on("session_start", (_event, ctx) => bind(ctx, "start"));
	pi.on("session_switch", (event, ctx) => bind(ctx, event.reason === "fork" ? "fork" : "switch"));
	pi.on("session_branch", (event, ctx) => bind(ctx, event.reason === "branch" ? "branch" : "fork"));
	pi.on("session_tree", (_event, ctx) => bind(ctx, "tree"));
	pi.on("session_shutdown", () => unregister());

	pi.on("before_subagent_spawn", (event, ctx) => {
		const overrides = effectiveOverrides();
		const next = rewriteSpawnPatterns(event.modelRole, event.patterns, settings(), overrides);
		if (!next) return undefined;
		const head = resolveModelRoleValue(next[0], ctx.modelRegistry.getAvailable("all"), { settings: settings() });
		if (!head.model) {
			return {
				block: true,
				reason: `会话角色覆盖使 ${event.modelRole} 指向 ${next[0]}，但该模型当前不可用（不存在或未认证）。用 /roles reset ${event.modelRole} 恢复或重新设置。`,
			};
		}
		// With the core patch the spawn already resolved through the session overlay.
		if (core) return undefined;
		return { model: next, note: `会话角色覆盖：${event.modelRole} → ${next[0]}` };
	});

	pi.on("agent_end", (event, ctx) => {
		if (agentKind !== "main" || event.willContinue) return;
		// The session manager can move to a sibling file with a new id mid-session (another process
		// wrote the file); re-stamp so a later resume still recognises the overrides as owned.
		const sessionId = ctx.sessionManager.getSessionId();
		if (stampedSessionId !== sessionId) {
			stampedSessionId = sessionId;
			if (Object.keys(roles).length > 0) {
				pi.appendEntry<PersistedState>(STATE_ENTRY_TYPE, { v: 1, sessionId, roles });
			}
		}
		if (pendingMainSync) scheduleMainSync(ctx);
	});

	pi.on("input", async (_event, ctx) => {
		if (!pendingMainSync || agentKind !== "main" || !ctx.isIdle()) return;
		pendingMainSync = false;
		const active = activeMainRole(ctx);
		if (active) await switchMainModel(ctx, active);
	});

	pi.registerCommand("roles", {
		description: "会话级模型角色：/roles [show | set <角色> <模型> | reset <角色>|all | inherit]（不写配置文件）",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const tokens = prefix.split(/\s+/);
			const last = tokens.at(-1) ?? "";
			let candidates: string[] = [];
			if (tokens.length <= 1) candidates = SUBCOMMANDS;
			else if (tokens[0] === "reset") candidates = [...getKnownRoleIds(settings()), "all"];
			else if (tokens[0] === "set" && tokens.length % 2 === 0) candidates = getKnownRoleIds(settings());
			const head = tokens.slice(0, -1).join(" ");
			const items = candidates
				.filter(candidate => candidate.startsWith(last))
				.map(candidate => ({ label: candidate, value: head ? `${head} ${candidate}` : candidate }));
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (agentKind !== "main") {
				ctx.ui.notify("/roles 只能在主会话中使用", "warning");
				return;
			}
			const command = parseRolesArgs(args);
			switch (command.kind) {
				case "error":
					ctx.ui.notify(command.message, "error");
					return;
				case "help":
					ctx.ui.notify(`${USAGE}\n${modeLine}`, "info");
					return;
				case "show":
					ctx.ui.notify(report(ctx), "info");
					return;
				case "panel":
					if (!ctx.hasUI) {
						ctx.ui.notify(report(ctx), "info");
						return;
					}
					await runRolesPanel(ctx, {
						settings,
						overrides: () => roles,
						modeLine,
						setRole: async (role, value) => {
							const errors = await setRoles(ctx, [{ role, model: value }]);
							if (errors.length > 0) return errors.join("\n");
							ctx.ui.notify(`${role} → ${roles[role]}（仅当前会话；后续新启动的子 Agent 生效）`, "info");
							return undefined;
						},
						reset: which => resetRoles(ctx, which),
					});
					return;
				case "set": {
					const errors = await setRoles(ctx, command.updates);
					if (errors.length > 0) {
						ctx.ui.notify(`未做任何修改（批量设置为原子操作）：\n${errors.join("\n")}`, "error");
						return;
					}
					const lines = command.updates.map(({ role }) => `${role} → ${roles[role]}`);
					ctx.ui.notify(`已设置会话级角色覆盖（不写配置文件）：\n${lines.join("\n")}`, "info");
					return;
				}
				case "reset":
					await resetRoles(ctx, command.roles);
					return;
				case "inherit": {
					if (!inherited) {
						ctx.ui.notify("没有可继承的来源会话覆盖", "info");
						return;
					}
					const adopted = inherited.roles;
					inherited = undefined;
					await commit(ctx, { ...adopted }, Object.keys(adopted));
					ctx.ui.notify(`已继承 ${Object.keys(adopted).length} 个角色覆盖：${Object.keys(adopted).join(", ")}`, "info");
					return;
				}
			}
		},
	});
}
