import { describe, expect, test } from "bun:test";
import { rewriteSpawnPatterns, resolveRole, validateRoleValue } from "../src/resolve";
import { FLASH, GPT, catalog, settingsWith } from "./fixtures";

const base = settingsWith({
	default: "anthropic/claude-opus-5-5",
	task: "anthropic/claude-opus-5-5",
	slow: "openai/gpt-6.1",
	plan: "@slow",
});

describe("validateRoleValue", () => {
	test("canonicalises an authenticated model and keeps an explicit thinking suffix", () => {
		const result = validateRoleValue("task", "google/gemini-3.8-flash:high", base, {}, catalog());
		expect(result).toMatchObject({ ok: true, value: "google/gemini-3.8-flash:high", model: FLASH });
	});

	test("a role alias resolves through overrides staged earlier in the same batch", () => {
		const result = validateRoleValue("task", "@slow", base, { slow: "google/gemini-3.8-flash" }, catalog());
		expect(result).toMatchObject({ ok: true, value: "google/gemini-3.8-flash" });
	});

	test("an unknown model is rejected as missing", () => {
		const result = validateRoleValue("task", "nosuch/model-x", base, {}, catalog());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("找不到模型");
	});

	test("a catalog model without credentials is rejected as unauthenticated", () => {
		const result = validateRoleValue("task", "lockedcorp/locked-model", base, {}, catalog());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("没有可用凭据");
	});
});

describe("resolveRole", () => {
	test("an override on a referenced role changes roles that alias it, not others", () => {
		const overrides = { slow: "google/gemini-3.8-flash" };
		expect(resolveRole("plan", base, overrides, catalog()).model).toBe(FLASH);
		expect(resolveRole("slow", base, {}, catalog()).model).toBe(GPT);
		expect(resolveRole("task", base, overrides, catalog()).model?.id).toBe("claude-opus-5-5");
	});
});

describe("rewriteSpawnPatterns", () => {
	test("returns undefined when the spawn's role chain is unaffected", () => {
		expect(rewriteSpawnPatterns("task", ["anthropic/claude-opus-5-5"], base, { slow: "google/gemini-3.8-flash" })).toBeUndefined();
		expect(rewriteSpawnPatterns(undefined, ["openai/gpt-6.1"], base, { task: "google/gemini-3.8-flash" })).toBeUndefined();
	});

	test("replaces the role's head and keeps caller-supplied trailing fallbacks", () => {
		const next = rewriteSpawnPatterns(
			"task",
			["anthropic/claude-opus-5-5", "openai/gpt-6.1"],
			base,
			{ task: "google/gemini-3.8-flash:low" },
		);
		expect(next).toEqual(["google/gemini-3.8-flash:low", "openai/gpt-6.1"]);
	});

	test("follows nested aliases: overriding slow reroutes a spawn on @plan", () => {
		expect(rewriteSpawnPatterns("plan", ["openai/gpt-6.1"], base, { slow: "google/gemini-3.8-flash" })).toEqual([
			"google/gemini-3.8-flash",
		]);
	});

	test("preserves a uniform thinking suffix the source applied (e.g. @task:high)", () => {
		expect(
			rewriteSpawnPatterns("task", ["anthropic/claude-opus-5-5:high"], base, { task: "google/gemini-3.8-flash" }),
		).toEqual(["google/gemini-3.8-flash:high"]);
	});
});
