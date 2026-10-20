/**
 * Install check in an isolated config root (PI_CONFIG_DIR, home-relative): `omp plugin link` this
 * repo, start omp, require `/roles` to answer from the plugin, then `omp plugin uninstall`.
 * The real ~/.omp plugin state is never touched.
 */
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { RpcOmp } from "./rpc";

const root = path.resolve(import.meta.dir, "run-install");
rmSync(root, { recursive: true, force: true });
const proj = path.join(root, "proj");
mkdirSync(proj, { recursive: true });
const env = { ...process.env, PI_CONFIG_DIR: path.relative(homedir(), root) };
const repo = path.resolve(import.meta.dir, "..");
const ompCli = (...args: string[]) => {
	const result = Bun.spawnSync(["omp", "plugin", ...args], { env, stdout: "pipe", stderr: "pipe" });
	return `${result.stdout.toString()}${result.stderr.toString()}`.trim();
};

console.log(ompCli("link", repo));
const omp = new RpcOmp(["--no-session", "--no-title", "--no-lsp", "--no-skills"], { cwd: proj, env });
try {
	await omp.ready();
	const help = await omp.slash("/roles help");
	console.log(help.join("\n").includes("/roles reset all") ? "PASS linked plugin loads and serves /roles" : `FAIL ${help.join(" | ")}`);
} finally {
	await omp.close();
}
console.log(ompCli("uninstall", "omp-session-roles"));
