/**
 * Drive the /roles panel over RPC (non-TUI path: select dialogs + provider→model fallback). When a
 * legacy ~/.omp/agent/extensions/model-roles.ts exists (it also registers /roles), load it first and
 * check /roles still resolves to this plugin.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { RpcOmp } from "./rpc";

const root = path.resolve(import.meta.dir, "run-panel");
const proj = path.join(root, "proj");
mkdirSync(proj, { recursive: true });
const overlay = path.join(root, "overlay.yml");
writeFileSync(overlay, "modelRoles:\n  task: anthropic/claude-haiku-5-5\n  plan: anthropic/claude-haiku-5-5\n");
const legacy = path.join(homedir(), ".omp", "agent", "extensions", "model-roles.ts");
const legacyArgs = existsSync(legacy) ? ["-e", legacy] : [];
const plugin = path.resolve(import.meta.dir, "..", "src", "index.ts");
const omp = new RpcOmp(
	["--no-extensions", ...legacyArgs, "-e", plugin, "--config", overlay, "--no-session", "--no-title", "--no-lsp", "--no-skills"],
	{ cwd: proj },
);
const MORE = "… 更多";
const pick = (prefix: string) => (options: string[], title: string) => {
	const hit = options.find(option => option.startsWith(prefix));
	if (hit) return hit;
	if (options.includes(MORE)) return MORE;
	throw new Error(`no option starting with ${JSON.stringify(prefix)} in "${title}": ${options.join(" | ")}`);
};
const row = (lines: string[], role: string) => lines.join("\n").split("\n").find(line => line.startsWith(`${role} `)) ?? "";

try {
	await omp.ready();

	// Precedence: the legacy extension would open a model select titled 为「show」…; ours prints the table.
	const shown = await omp.slash("/roles show");
	const legacySelect = omp.frames.some(frame => frame.method === "select" && String(frame.title).includes("「show」"));
	console.log(`${shown.join("").includes("会话模型角色") && !legacySelect ? "PASS" : "FAIL"} /roles resolves to omp-session-roles${legacyArgs.length ? " with the legacy /roles extension loaded" : ""}`);

	let cursor = omp.frames.length;
	omp.write({ type: "prompt", message: "/roles", id: "panel-1" });
	const step = async (prefix: string) => {
		const answer = await omp.answerSelect(cursor, pick(prefix));
		cursor = answer.next;
		while (answer.chosen === MORE) {
			const more = await omp.answerSelect(cursor, pick(prefix));
			cursor = more.next;
			if (more.chosen !== MORE) return more;
		}
		return answer;
	};
	const main = await step("task ");
	console.log(`panel title: ${main.title.split("\n")[0]} · ${main.options.length} options`);
	await step("更换模型");
	await step("google-antigravity");
	await step("google-antigravity/gemini-3.8-flash");
	const thinking = await step("low");
	console.log(`thinking options: ${thinking.options.join(", ")}`);
	await step("plan ");
	await step("设置 Thinking Level");
	await step("high");
	await step("完成");
	await omp.waitFor(frame => frame.type === "prompt_result", 30_000, cursor);

	const afterEdit = await omp.slash("/roles show");
	const ok1 = row(afterEdit, "task").includes("google-antigravity/gemini-3.8-flash:low") && row(afterEdit, "plan").includes("claude-haiku-5-5:high");
	console.log(`${ok1 ? "PASS" : "FAIL"} panel edits applied — ${row(afterEdit, "task")} | ${row(afterEdit, "plan")}`);

	cursor = omp.frames.length;
	omp.write({ type: "prompt", message: "/roles", id: "panel-2" });
	await step("task ");
	await step("恢复原始配置");
	await step("↺ 清除全部会话覆盖");
	const confirm = await omp.waitFor(frame => frame.method === "confirm", 30_000, cursor);
	omp.write({ type: "extension_ui_response", id: confirm.id, confirmed: true });
	cursor = omp.frames.indexOf(confirm) + 1;
	await step("完成");
	await omp.waitFor(frame => frame.type === "prompt_result", 30_000, cursor);
	const afterReset = await omp.slash("/roles show");
	const ok2 = !afterReset.join("\n").includes("会话覆盖 ·");
	console.log(`${ok2 ? "PASS" : "FAIL"} panel per-role reset + reset all — ${afterReset[0]?.split("\n")[0]}`);
} catch (error) {
	console.log("ERROR", error instanceof Error ? error.message.slice(0, 200) : error);
	console.log("NOTICES", omp.notices().slice(-5).join("\n---\n"));
	console.log(
		"FRAMES",
		omp.frames
			.slice(-40)
			.filter(frame => frame.type !== "available_commands_update")
			.map(frame => `${frame.type}/${frame.method ?? ""}/${String(frame.title ?? frame.message ?? frame.command ?? "").slice(0, 80)}`)
			.join("\n"),
	);
} finally {
	await omp.close();
	if (omp.stderr.trim()) console.log("STDERR", omp.stderr.slice(-800));
}