/**
 * End-to-end acceptance run against the installed omp (RPC mode, real providers).
 * Isolation: own session dir, own project dir, --config overlay for cheap base roles,
 * --no-extensions (only this plugin + the request probe). Global/project config files are watched.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { RpcOmp } from "./rpc";

const root = path.resolve(import.meta.dir, "run");
rmSync(root, { recursive: true, force: true });
const proj = path.join(root, "proj");
mkdirSync(path.join(proj, ".omp"), { recursive: true });
const projectConfig = path.join(proj, ".omp", "config.yml");
writeFileSync(projectConfig, "# smoke project config (must stay untouched)\n");
const overlay = path.join(root, "overlay.yml");
const BASE = "anthropic/claude-haiku-5-5";
const OVERRIDE = "google-antigravity/gemini-3.8-flash";
writeFileSync(
	overlay,
	`modelRoles:\n${["default", "task", "plan", "slow", "advisor"].map(role => `  ${role}: ${BASE}`).join("\n")}\n`,
);
const requestsLog = path.join(root, "requests.jsonl");
const globalConfig = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".omp", "agent"), "config.yml");
const watched = [globalConfig, projectConfig, overlay];
const fingerprint = () => watched.map(file => `${file}|${statSync(file).mtimeMs}|${Bun.hash(readFileSync(file))}`);
const before = fingerprint();
const writeEvents: string[] = [];
const watchers = watched.map(file => watch(file, eventType => writeEvents.push(`${eventType}: ${file}`)));

const plugin = path.resolve(import.meta.dir, "..", "src", "index.ts");
const probe = path.resolve(import.meta.dir, "probe-requests.ts");
const baseArgs = [
	"--no-extensions", "-e", plugin, "-e", probe, "--config", overlay,
	"--session-dir", path.join(root, "sessions"), "--no-title", "--no-lsp", "--no-skills", "--auto-approve",
];
const env = { SESSION_ROLES_PROBE_LOG: requestsLog };
const SPAWN_PROMPT =
	"Call the task tool exactly once with a single task item whose assignment is: Reply with exactly the word OK. " +
	"Then call the wait tool until that subagent has finished. Do not do anything else yourself. " +
	"After the subagent result arrives, reply with exactly DONE.";

const results: Array<{ test: string; pass: boolean; detail: string }> = [];
const check = (test: string, pass: boolean, detail: string) => {
	results.push({ test, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"} ${test} — ${detail}`);
};
interface ProbeLine {
	agent: { kind: string; id: string; depth: number };
	sessionId: string;
	model: string | null;
}
const readRequests = (): ProbeLine[] =>
	existsSync(requestsLog)
		? readFileSync(requestsLog, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as ProbeLine)
		: [];
/**
 * Run a spawn prompt and return the models used by main / sub requests during it. Task jobs are
 * asynchronous, so keep polling the probe log until the subagent's first request lands.
 */
async function spawnRun(omp: RpcOmp): Promise<{ main: string[]; sub: string[] }> {
	const start = readRequests().length;
	await omp.run(SPAWN_PROMPT);
	const deadline = Date.now() + 120_000;
	while (!readRequests().slice(start).some(line => line.agent.kind === "sub") && Date.now() < deadline) {
		await Bun.sleep(500);
	}
	const lines = readRequests().slice(start);
	return {
		main: [...new Set(lines.filter(line => line.agent.kind === "main").map(line => line.model ?? "?"))],
		sub: [...new Set(lines.filter(line => line.agent.kind === "sub").map(line => line.model ?? "?"))],
	};
}
const taskRow = (notice: string[]) => notice.join("\n").split("\n").find(line => line.startsWith("task ")) ?? "";
const row = (notice: string[], role: string) =>
	notice.join("\n").split("\n").find(line => line.startsWith(`${role} `)) ?? "";

const a = new RpcOmp(baseArgs, { cwd: proj, env });
const b = new RpcOmp(baseArgs, { cwd: proj, env });
try {
	await Promise.all([a.ready(), b.ready()]);

	// Test B baseline, then override + real subagent request.
	const baseline = await spawnRun(a);
	check("B0 baseline task subagent uses config", baseline.sub.includes(BASE) && !baseline.sub.includes(OVERRIDE), JSON.stringify(baseline));
	await a.slash(`/roles set task ${OVERRIDE}`);
	const routed = await spawnRun(a);
	check(
		"B task subagent provider request uses the session override",
		routed.sub.length > 0 && routed.sub.every(model => model === OVERRIDE) && routed.main.every(model => model === BASE),
		JSON.stringify(routed),
	);

	// Test A: concurrently open session B (separate process) is unaffected, by display and by a real spawn.
	const bShow = await b.slash("/roles show");
	check("A other session shows original task binding", taskRow(bShow).includes(BASE) && !taskRow(bShow).includes("会话"), taskRow(bShow));
	const bRun = await spawnRun(b);
	check("A other session's task subagent still uses config", bRun.sub.includes(BASE) && !bRun.sub.includes(OVERRIDE), JSON.stringify(bRun));

	// Test C: each role independently.
	for (const role of ["plan", "slow", "advisor"]) {
		const prior = await a.slash("/roles show");
		await a.slash(`/roles set ${role} ollama-cloud/deepseek-v4.1-flash:1017`);
		const after = await a.slash("/roles show");
		const others = ["default", "task", "plan", "slow", "advisor", "smol"].filter(other => other !== role);
		const unchanged = others.every(other => row(prior, other) === row(after, other));
		check(`C ${role} override changes only ${role}`, row(after, role).includes("deepseek") && unchanged, row(after, role));
	}

	// Test G: unavailable model → explicit error, binding kept.
	const missing = await a.slash("/roles set task nosuch/zzz-404");
	const keep = await a.slash("/roles show");
	check("G missing model rejected, binding kept", missing.join("").includes("找不到模型") && taskRow(keep).includes(OVERRIDE), `${missing.join(" ")} | ${taskRow(keep)}`);
	const batch = await a.slash(`/roles set task=${BASE} slow=nosuch/zzz-404`);
	const afterBatch = await a.slash("/roles show");
	check("G atomic batch: one bad entry applies nothing", batch.join("").includes("未做任何修改") && taskRow(afterBatch).includes(OVERRIDE), batch.join(" "));

	// Main agent: overriding the role it runs on (default) switches its real requests; reset switches back.
	const mainModels = async () => {
		const start = readRequests().length;
		await a.run("Reply with exactly the word OK.");
		return [...new Set(readRequests().slice(start).filter(line => line.agent.kind === "main").map(line => line.model))];
	};
	const switchNotes = await a.slash(`/roles set default ${OVERRIDE}`);
	const switched = await mainModels();
	check("M main agent on role default switches to the override", switched.length === 1 && switched[0] === OVERRIDE, `${JSON.stringify(switched)} | ${switchNotes.at(-1)}`);
	await a.slash("/roles reset default");
	const restored = await mainModels();
	check("M reset default switches the main agent back", restored.length === 1 && restored[0] === BASE, JSON.stringify(restored));

	// Same process, another session: /new shows config; switching back restores.
	const stateA = await a.request({ type: "get_state" });
	const stateData = stateA.data;
	const sessionFileA =
		stateData && typeof stateData === "object" && "sessionFile" in stateData && typeof stateData.sessionFile === "string"
			? stateData.sessionFile
			: "";
	await a.request({ type: "new_session" });
	const fresh = await a.slash("/roles show");
	check("A same-process new session uses config", taskRow(fresh).includes(BASE) && !taskRow(fresh).includes("会话"), taskRow(fresh));
	await a.request({ type: "switch_session", sessionPath: sessionFileA });
	const back = await a.slash("/roles show");
	check("F switching back restores the session's overrides", taskRow(back).includes(OVERRIDE), taskRow(back));

	// Test E: reset all.
	await a.slash("/roles reset all");
	const reset = await a.slash("/roles show");
	check(
		"E reset all restores every role",
		["task", "plan", "slow", "advisor"].every(role => row(reset, role).includes(BASE) && !row(reset, role).includes("会话")),
		reset.join("\n").split("\n").slice(0, 2).join(" "),
	);
	await a.slash(`/roles set task ${OVERRIDE}`);
	await a.close();
	// Test F: restart + resume restores; real spawn after restart.
	const resumed = new RpcOmp([...baseArgs, "--resume", sessionFileA], { cwd: proj, env });
	try {
		await resumed.ready();
		const show = await resumed.slash("/roles show");
		check("F restart + resume restores override", taskRow(show).includes(OVERRIDE), taskRow(show));
		const run = await spawnRun(resumed);
		check("F resumed session's task subagent uses override", run.sub.length > 0 && run.sub.every(model => model === OVERRIDE), JSON.stringify(run));

		// Fork: default config, explicit inherit.
		const forkFrom = resumed.frames.length;
		await resumed.request({ type: "fork" });
		const forkNotices = resumed.notices().slice(0);
		const forkShow = await resumed.slash("/roles show");
		check(
			"Fork starts on original config and offers /roles inherit",
			taskRow(forkShow).includes(BASE) && resumed.frames.slice(forkFrom).some(frame => String(frame.message ?? "").includes("/roles inherit")),
			`${taskRow(forkShow)} | notices=${forkNotices.length}`,
		);
		await resumed.slash("/roles inherit");
		const inherited = await resumed.slash("/roles show");
		check("Fork inherits only after /roles inherit", taskRow(inherited).includes(OVERRIDE), taskRow(inherited));
	} finally {
		await resumed.close();
	}
} finally {
	await Promise.all([a.close(), b.close()]);
	for (const watcher of watchers) watcher.close();
}

// Test D: no config writes at any point.
const after = fingerprint();
check(
	"D global/project/overlay config never written",
	writeEvents.length === 0 && after.every((value, index) => value === before[index]),
	writeEvents.length ? writeEvents.join("; ") : "no fs.watch events; mtime+hash identical",
);
writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n${results.filter(result => result.pass).length}/${results.length} passed`);
if (results.some(result => !result.pass)) process.exitCode = 1;
