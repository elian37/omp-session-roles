/** Role table shared by `/roles show` and the panel. */
import { getKnownRoleIds, getRoleInfo } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { formatRoleValue, type ModelCatalog, resolveRole } from "./resolve";
import type { RoleOverrides } from "./state";

export interface RoleRow {
	role: string;
	section: "chat" | "kind";
	/** Session override value, when present. */
	override?: string;
	/** Value from the config layers (what `/roles reset` restores). */
	configured?: string;
	/** Display label for where the effective value comes from. */
	source: string;
	/** Resolved effective model (`provider/id[:thinking]`), or undefined when it does not resolve. */
	resolved?: string;
}

const PROVENANCE_LABEL: Record<string, string> = {
	env: "环境变量",
	runtime: "运行时",
	overlay: "--config",
	project: "项目",
	global: "全局",
	default: "内置默认",
};

export function buildRoleRows(settings: Settings, overrides: RoleOverrides, catalog: ModelCatalog): RoleRow[] {
	const roles = getKnownRoleIds(settings);
	return roles.map(role => {
		const resolved = resolveRole(role, settings, overrides, catalog);
		const override = Object.hasOwn(overrides, role) ? overrides[role] : undefined;
		return {
			role,
			section: getRoleInfo(role, settings).section,
			override,
			configured: settings.getModelRole(role),
			source: override ? "会话" : (PROVENANCE_LABEL[settings.getModelRoleProvenance(role)] ?? "配置"),
			resolved: resolved.model
				? formatRoleValue(resolved.model, resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined)
				: undefined,
		};
	});
}

export function formatReport(rows: readonly RoleRow[], modeLine: string): string {
	const width = Math.max(8, ...rows.map(row => row.role.length));
	const lines = rows.map(row => {
		const effective = row.resolved ?? (row.override ? `${row.override}（无法解析）` : "（未解析）");
		const origin = row.override ? `会话覆盖 · 原始：${row.configured ?? "内置默认"}` : row.source;
		return `${row.role.padEnd(width)}  ${effective}  [${origin}]`;
	});
	const count = rows.filter(row => row.override).length;
	return [`会话模型角色（本会话覆盖 ${count} 个；不写入任何配置文件）`, modeLine, ...lines].join("\n");
}
