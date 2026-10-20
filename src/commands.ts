/** `/roles` argument grammar. Pure parsing; validation against models happens in the caller. */

export type RolesCommand =
	| { kind: "panel" }
	| { kind: "show" }
	| { kind: "help" }
	| { kind: "inherit" }
	| { kind: "set"; updates: Array<{ role: string; model: string }> }
	| { kind: "reset"; roles: string[] | "all" }
	| { kind: "error"; message: string };

export const USAGE = [
	"/roles                       打开会话角色面板",
	"/roles show                  显示当前会话全部有效绑定",
	"/roles set <角色> <模型>      会话级覆盖（模型可带 :thinking 后缀，如 openai/gpt-5:high）",
	"/roles set a=<模型> b=<模型>  批量覆盖（原子：任一失败则全部不生效）",
	"/roles reset <角色>…          恢复指定角色的原始配置",
	"/roles reset all             清除当前会话全部覆盖",
	"/roles inherit               显式继承分叉来源会话的覆盖",
].join("\n");

export function parseRolesArgs(raw: string): RolesCommand {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "panel" };
	const [sub, ...rest] = tokens;
	switch (sub.toLowerCase()) {
		case "show":
		case "list":
			return { kind: "show" };
		case "help":
		case "-h":
		case "--help":
			return { kind: "help" };
		case "inherit":
			return { kind: "inherit" };
		case "reset": {
			if (rest.length === 0) return { kind: "error", message: "用法：/roles reset <角色>… 或 /roles reset all" };
			if (rest.some(token => token.toLowerCase() === "all")) {
				return rest.length === 1
					? { kind: "reset", roles: "all" }
					: { kind: "error", message: "reset all 不能与具体角色混用" };
			}
			return { kind: "reset", roles: [...new Set(rest)] };
		}
		case "set":
			return parseSet(rest);
		default:
			return { kind: "error", message: `未知子命令「${sub}」\n${USAGE}` };
	}
}

function parseSet(tokens: string[]): RolesCommand {
	if (tokens.length === 0) return { kind: "error", message: "用法：/roles set <角色> <模型> 或 /roles set <角色>=<模型> …" };
	const updates: Array<{ role: string; model: string }> = [];
	if (tokens.every(token => token.includes("="))) {
		for (const token of tokens) {
			const index = token.indexOf("=");
			updates.push({ role: token.slice(0, index), model: token.slice(index + 1) });
		}
	} else if (tokens.length % 2 === 0 && tokens.every(token => !token.includes("="))) {
		for (let index = 0; index < tokens.length; index += 2) {
			updates.push({ role: tokens[index], model: tokens[index + 1] });
		}
	} else {
		return { kind: "error", message: "参数需成对出现：/roles set <角色> <模型> [<角色> <模型> …]，或全部使用 角色=模型" };
	}
	const empty = updates.find(update => !update.role || !update.model);
	if (empty) return { kind: "error", message: `角色或模型为空：「${empty.role}=${empty.model}」` };
	const seen = new Set<string>();
	for (const { role } of updates) {
		if (seen.has(role)) return { kind: "error", message: `角色 ${role} 在同一条命令里出现了多次` };
		seen.add(role);
	}
	return { kind: "set", updates };
}
