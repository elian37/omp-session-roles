/**
 * Focused tests for the omp 18.12.x session model-role overlay core patch.
 *
 * Run against a patched package copy:
 *   OMP_PKG=<path-to-patched>/node_modules/@oh-my-pi/pi-coding-agent bun test core-patch/tests/
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const pkg = process.env.OMP_PKG;
if (!pkg) throw new Error("Set OMP_PKG to a patched @oh-my-pi/pi-coding-agent package directory");
// Dynamic imports: the patched package location is chosen at runtime (OMP_PKG), so static imports cannot work.
const { Settings, resetSettingsForTest } = await import(path.join(pkg, "src/config/settings.ts"));
const { cfgModelRoles } = await import(path.join(pkg, "src/config/model-settings.ts"));
const { cfgSteeringMode } = await import(path.join(pkg, "src/modes/settings.ts"));
const { expandRoleAlias, resolveConfiguredModelPatterns } = await import(path.join(pkg, "src/config/model-resolver.ts"));

const tmpRoots: string[] = [];
function tmpAgentDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-roles-"));
	tmpRoots.push(dir);
	return dir;
}

afterAll(() => {
	resetSettingsForTest();
	for (const dir of tmpRoots) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Windows keeps agent.db locked until the process exits; a leftover temp dir is harmless.
		}
	}
});

describe("Settings.sessionView session model roles", () => {
	test("two views of one instance never see each other's overlay", () => {
		const base = Settings.isolated({ modelRoles: { slow: "anthropic/base-slow", smol: "anthropic/base-smol" } });
		const a = base.sessionView();
		const b = base.sessionView();
		a.setSessionModelRoles({ slow: "openai/a-slow" });

		expect(a.getModelRole("slow")).toBe("openai/a-slow");
		expect(a.getModelRole("smol")).toBe("anthropic/base-smol");
		expect(b.getModelRole("slow")).toBe("anthropic/base-slow");
		expect(base.getModelRole("slow")).toBe("anthropic/base-slow");
		expect(b.getSessionModelRoles()).toEqual({});
		expect(a.getSessionModelRoles()).toEqual({ slow: "openai/a-slow" });
		expect(a.getModelRoles()).toEqual({ slow: "openai/a-slow", smol: "anthropic/base-smol" });
		expect(cfgModelRoles.get(a).slow).toBe("openai/a-slow");
		expect(cfgModelRoles.get(b).slow).toBe("anthropic/base-slow");
	});

	test("@role expansion and pattern resolution follow the overlay", () => {
		const base = Settings.isolated({ modelRoles: { slow: "anthropic/base-slow" } });
		const view = base.sessionView();
		view.setSessionModelRoles({ slow: "openai/view-slow:high,google/backup" });
		expect(expandRoleAlias("@slow", view)).toBe("openai/view-slow:high");
		expect(resolveConfiguredModelPatterns("@slow", view)).toEqual(["openai/view-slow:high", "google/backup"]);
		expect(resolveConfiguredModelPatterns("@slow", base)).toEqual(["anthropic/base-slow"]);
	});

	test("overlay children (subagents) inherit live; siblings do not", () => {
		const base = Settings.isolated({ modelRoles: { slow: "anthropic/base-slow" } });
		const view = base.sessionView();
		const other = base.sessionView();
		view.setSessionModelRoles({ slow: "openai/view-slow" });
		const child = view.overlay({ "tools.approvalMode": "yolo" });
		const grandchild = child.overlay();
		const otherChild = other.overlay();

		expect(child.getModelRole("slow")).toBe("openai/view-slow");
		expect(grandchild.getModelRole("slow")).toBe("openai/view-slow");
		expect(otherChild.getModelRole("slow")).toBe("anthropic/base-slow");
		expect(child.getModelRoleProvenance("slow")).toBe("session");
		expect(child.getSessionModelRoles()).toEqual({});

		// A later overlay replacement reaches existing child Settings instances too; a running
		// subagent's model was already chosen at spawn, so only later role reads see it.
		view.setSessionModelRoles({ slow: "openai/view-slow-2" });
		expect(child.getModelRole("slow")).toBe("openai/view-slow-2");
	});

	test("provenance reports session and clearing restores configured layers", () => {
		const base = Settings.isolated({ modelRoles: { slow: "anthropic/base-slow" } });
		const view = base.sessionView();
		expect(view.getModelRoleProvenance("slow")).toBe("runtime");
		view.setSessionModelRoles({ slow: "openai/view-slow", plan: "openai/view-plan" });
		expect(view.getModelRoleProvenance("slow")).toBe("session");
		expect(view.getModelRoleProvenance("plan")).toBe("session");
		expect(view.getModelRoleProvenance("smol")).toBe("default");
		expect(view.getProvenance(cfgModelRoles)).toBe("session");
		expect(base.getModelRoleProvenance("slow")).toBe("runtime");

		view.setSessionModelRoles({});
		expect(view.getSessionModelRoles()).toEqual({});
		expect(view.getModelRole("slow")).toBe("anthropic/base-slow");
		expect(view.getModelRole("plan")).toBeUndefined();
		expect(view.getModelRoleProvenance("slow")).toBe("runtime");
	});

	test("replacement is whole-map and notifies modelRoles listeners on view and children", async () => {
		const base = Settings.isolated();
		const view = base.sessionView();
		const child = view.overlay();
		const seen: string[] = [];
		view.onEffectiveChange([cfgModelRoles], () => seen.push("view"));
		// The handle API InteractiveMode uses for plan-mode role re-application (`cfgModelRoles.listen(this.settings, …)`).
		const listened: unknown[] = [];
		cfgModelRoles.listen(view, value => {
			listened.push(value);
		});
		child.onEffectiveChange([cfgModelRoles], () => seen.push("child"));
		base.onEffectiveChange([cfgModelRoles], () => seen.push("base"));

		view.setSessionModelRoles({ slow: "a/b", smol: "c/d" });
		await Promise.resolve(); // `listen` coalesces per microtask; let the queued recompute run
		view.setSessionModelRoles({ smol: "e/f" });
		await Promise.resolve();
		view.setSessionModelRoles({ smol: "e/f" }); // identical map: no change notification at all
		await Promise.resolve();
		expect(view.getModelRole("slow")).toBeUndefined();
		expect(view.getModelRole("smol")).toBe("e/f");
		expect(seen.filter(s => s === "view").length).toBe(2);
		expect(seen.filter(s => s === "child").length).toBe(2);
		expect(listened).toEqual([{ slow: "a/b", smol: "c/d" }, { smol: "e/f" }]);
		expect(seen.includes("base")).toBe(false);
	});

	test("rejects invalid input and the process-global instance", async () => {
		const view = Settings.isolated().sessionView();
		expect(() => view.setSessionModelRoles({ slow: "" })).toThrow(TypeError);
		expect(() => view.setSessionModelRoles({ slow: 42 as unknown as string })).toThrow(TypeError);
		expect(() => view.setSessionModelRoles(null as unknown as Record<string, string>)).toThrow(TypeError);
		expect(view.getSessionModelRoles()).toEqual({});

		const agentDir = tmpAgentDir();
		const global = await Settings.init({ agentDir, cwd: agentDir });
		expect(() => global.setSessionModelRoles({ slow: "a/b" })).toThrow(/per-session/);
		resetSettingsForTest();
	});

	test("writes through a view persist on the parent; the overlay never reaches disk", async () => {
		const agentDir = tmpAgentDir();
		const persisted = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		const view = persisted.sessionView();
		const sibling = persisted.sessionView();
		view.setSessionModelRoles({ slow: "openai/session-only" });

		view.setModelRole("default", "anthropic/persisted-default");
		cfgSteeringMode.set(view, "one-at-a-time");
		cfgSteeringMode.override(view, "all");
		await view.flush();

		expect(persisted.getGlobalModelRole("default")).toBe("anthropic/persisted-default");
		expect(sibling.getModelRole("default")).toBe("anthropic/persisted-default");
		expect(persisted.getProvenance(cfgSteeringMode)).toBe("runtime");
		expect(view.writeTarget()).toBe(persisted);
		expect(view.getCwd()).toBe(persisted.getCwd());

		const yaml = fs.readFileSync(path.join(agentDir, "config.yml"), "utf8");
		expect(yaml).toContain("anthropic/persisted-default");
		expect(yaml).toContain("one-at-a-time");
		expect(yaml).not.toContain("session-only");

		// The overlay stays on the view only.
		expect(persisted.getModelRole("slow")).toBeUndefined();
		expect(sibling.getModelRole("slow")).toBeUndefined();
		expect(view.getModelRole("slow")).toBe("openai/session-only");

		// cloneForCwd keeps a write-through view carrying the overlay.
		const clone = await view.cloneForCwd(agentDir);
		expect(clone.getModelRole("slow")).toBe("openai/session-only");
		expect(clone.writeTarget()).not.toBe(persisted);
		persisted.cancelPendingSaves();
	});
});
