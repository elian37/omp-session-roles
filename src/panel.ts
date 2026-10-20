/**
 * `/roles` interactive panel built from OMP's native pieces: the extension select dialog for the
 * role list / actions / thinking level, and the alt+p `ModelPickerComponent` (search, every
 * provider, role chips) in selection-only mode for choosing a model. Outside the TUI (RPC hosts)
 * model choice falls back to provider → model select dialogs.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ExtensionCommandContext, ExtensionUISelectOption } from "@oh-my-pi/pi-coding-agent";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createModelBrowserSource } from "@oh-my-pi/pi-coding-agent/modes/model-browser-source";
import type { ModelBrowserSource } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { ModelPickerComponent } from "@oh-my-pi/pi-tui/overlays/model-picker";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { buildRoleRows, type RoleRow } from "./report";
import { formatRoleValue, modelKey, resolveRole, rolePool } from "./resolve";
import type { RoleOverrides } from "./state";

export interface PanelHost {
	settings(): Settings;
	overrides(): RoleOverrides;
	modeLine: string;
	/** Validate and apply one role atomically; resolves to an error message on failure. */
	setRole(role: string, value: string): Promise<string | undefined>;
	reset(roles: readonly string[] | "all"): Promise<void>;
}

/** GooeyPi and other RPC hosts reject select dialogs above 32 options. */
const PAGE = 28;
const MORE = "… 更多";

export async function runRolesPanel(ctx: ExtensionCommandContext, host: PanelHost): Promise<void> {
	let focus: string | undefined;
	for (;;) {
		const rows = buildRoleRows(host.settings(), host.overrides(), ctx.modelRegistry);
		const width = Math.max(8, ...rows.map(row => row.role.length));
		const items: ExtensionUISelectOption[] = rows.map(row => ({
			label: `${row.role.padEnd(width)}  ${row.resolved ?? (row.override ? `${row.override}（无法解析）` : "（未解析）")}  [${row.source}]`,
			description: row.override ? `会话覆盖 · 原始：${row.configured ?? "内置默认"}` : `来源：${row.source}`,
		}));
		const overridden = rows.filter(row => row.override).length;
		const resetAll = `↺ 清除全部会话覆盖（${overridden} 个）`;
		const done = "完成";
		if (overridden > 0) items.push({ label: resetAll, description: "所有角色恢复为原始配置" });
		items.push({ label: done });
		const focusIndex = rows.findIndex(row => row.role === focus);
		const picked = await ctx.ui.select(`会话模型角色 · 仅当前会话生效，不写配置文件\n${host.modeLine}`, items, {
			initialIndex: focusIndex >= 0 ? focusIndex : 0,
			helpText: "↑↓ 选择角色 · Enter 编辑 · Esc 关闭",
		});
		if (picked === undefined || picked === done) return;
		if (picked === resetAll) {
			if (await ctx.ui.confirm("清除全部会话覆盖", `将把 ${overridden} 个角色恢复为原始配置，确定？`)) await host.reset("all");
			continue;
		}
		const row = rows[items.findIndex(item => item.label === picked)];
		if (!row) return;
		focus = row.role;
		await editRole(ctx, host, row);
	}
}

async function editRole(ctx: ExtensionCommandContext, host: PanelHost, row: RoleRow): Promise<void> {
	const changeModel = "更换模型…";
	const changeThinking = "设置 Thinking Level…";
	const reset = `恢复原始配置（${row.configured ?? "内置默认"}）`;
	const back = "返回";
	const actions = [changeModel, changeThinking, ...(row.override ? [reset] : []), back];
	const action = await ctx.ui.select(`角色 ${row.role} · 当前：${row.resolved ?? "（未解析）"}`, actions);
	if (action === undefined || action === back) return;
	if (action === reset) {
		await host.reset([row.role]);
		return;
	}

	const current = resolveRole(row.role, host.settings(), host.overrides(), ctx.modelRegistry);
	let model = current.model;
	if (action === changeModel) {
		model = await pickModel(ctx, host, row.role, current.model);
		if (!model) return;
	} else if (!model) {
		ctx.ui.notify(`角色 ${row.role} 当前无法解析为可用模型，请先更换模型`, "warning");
		return;
	}
	const thinking = await pickThinking(ctx, model, current.explicitThinkingLevel ? current.thinkingLevel : undefined);
	if (thinking === undefined) return;
	const error = await host.setRole(row.role, formatRoleValue(model, thinking ?? undefined));
	if (error) ctx.ui.notify(error, "error");
}

async function pickModel(
	ctx: ExtensionCommandContext,
	host: PanelHost,
	role: string,
	current: Model<Api> | undefined,
): Promise<Model<Api> | undefined> {
	const settings = host.settings();
	const pool = rolePool(role, settings, ctx.modelRegistry);
	const chatRole = pool.every(model => (model.kind ?? "chat") === "chat");
	if (ctx.mode === "tui" && chatRole) {
		const base = createModelBrowserSource(settings);
		const overrides = host.overrides();
		// Role chips in the picker reflect this session's overrides; everything else reads through.
		const source: ModelBrowserSource = Object.create(base, {
			getModelRole: {
				value: (name: string) => (Object.hasOwn(overrides, name) ? overrides[name] : base.getModelRole(name)),
			},
		});
		return ctx.ui.custom<Model<Api> | undefined>(
			(tui, _theme, _keybindings, done) =>
				new ModelPickerComponent(
					tui,
					source,
					ctx.modelRegistry,
					[],
					{ onPick: model => done(model), onCancel: () => done(undefined) },
					{ selectOnly: true, currentSelector: current ? modelKey(current) : undefined },
				),
			{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0 } },
		);
	}
	return pickFromList(ctx, role, pool);
}

/** Provider → model select dialogs, paged for hosts with option limits. */
async function pickFromList(
	ctx: ExtensionCommandContext,
	role: string,
	pool: readonly Model<Api>[],
): Promise<Model<Api> | undefined> {
	if (pool.length === 0) {
		ctx.ui.notify(`没有适用于角色 ${role} 的已认证模型`, "warning");
		return undefined;
	}
	const providers = [...new Set(pool.map(model => model.provider))].sort();
	const provider =
		providers.length === 1 ? providers[0] : await pagedSelect(ctx, `为 ${role} 选择 provider`, providers);
	if (!provider) return undefined;
	const models = pool.filter(model => model.provider === provider);
	const key = await pagedSelect(
		ctx,
		`为 ${role} 选择模型 · ${provider}`,
		models.map(model => modelKey(model)),
	);
	return key ? models.find(model => modelKey(model) === key) : undefined;
}

async function pagedSelect(ctx: ExtensionCommandContext, title: string, options: string[]): Promise<string | undefined> {
	for (let start = 0; start < options.length; start += PAGE) {
		const page = options.slice(start, start + PAGE);
		const hasMore = start + PAGE < options.length;
		const picked = await ctx.ui.select(
			`${title}（${start + 1}-${start + page.length} / ${options.length}）`,
			hasMore ? [...page, MORE] : page,
		);
		if (picked !== MORE) return picked;
	}
	return undefined;
}

/**
 * Thinking level for `model`: `null` = unspecified (no suffix, model/global default applies),
 * `undefined` = cancelled.
 */
async function pickThinking(
	ctx: ExtensionCommandContext,
	model: Model<Api>,
	current: ConfiguredThinkingLevel | undefined,
): Promise<ConfiguredThinkingLevel | null | undefined> {
	const efforts = getSupportedEfforts(model);
	if (!model.reasoning && efforts.length === 0) return null;
	const unspecified = "不指定（沿用模型/全局默认）";
	const levels: ConfiguredThinkingLevel[] = ["off", ...efforts, ...(efforts.length > 0 ? (["auto"] as const) : [])];
	const items = [unspecified, ...levels];
	const index = current ? items.indexOf(current) : 0;
	const picked = await ctx.ui.select(`Thinking Level · ${modelKey(model)}`, items, {
		initialIndex: index >= 0 ? index : 0,
	});
	if (picked === undefined) return undefined;
	return picked === unspecified ? null : levels.find(level => level === picked);
}
