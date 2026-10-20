/** `bun e2e/full-mode-check.ts <patched cli.ts>`: the plugin must report full mode under the patched core. */
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { RpcOmp } from "./rpc";

const cli = process.argv[2];
if (!cli) throw new Error("usage: bun e2e/full-mode-check.ts <path to patched src/cli.ts>");
const proj = path.resolve(import.meta.dir, "run-full-mode");
mkdirSync(proj, { recursive: true });
const omp = new RpcOmp(
	["--no-extensions", "-e", path.resolve(import.meta.dir, "..", "src", "index.ts"), "--no-session", "--no-title", "--no-lsp", "--no-skills"],
	{ cwd: proj, launcher: ["bun", cli] },
);
try {
	await omp.ready();
	const shown = (await omp.slash("/roles show")).join("\n");
	console.log(shown.includes("完整模式") ? "PASS patched source entry loads the plugin in full mode" : `FAIL ${shown.slice(0, 200)}`);
} finally {
	await omp.close();
}
