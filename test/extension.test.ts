import { describe, expect, test } from "bun:test";
import { STATE_ENTRY_TYPE } from "../src/state";
import { settingsWith } from "./fixtures";
import { FakeSession } from "./harness";

const TASK_BASE = ["anthropic/claude-opus-5-5"];
const config = () =>
	settingsWith({
		default: "anthropic/claude-opus-5-5",
		task: "anthropic/claude-opus-5-5",
		plan: "anthropic/claude-opus-5-5",
		slow: "openai/gpt-6.1",
		advisor: "anthropic/claude-haiku-5-5",
	});

describe("session isolation and subagent routing", () => {
	test("an override in one session reroutes its task spawns only; config stays untouched", async () => {
		const settings = config();
		const a = await new FakeSession({ settings, sessionId: "a" }).start();
		const b = await new FakeSession({ settings, sessionId: "b" }).start();

		await a.command("set task google/gemini-3.8-flash:high");

		expect(await a.spawn("task", TASK_BASE)).toMatchObject({ model: ["google/gemini-3.8-flash:high"] });
		expect(await b.spawn("task", TASK_BASE)).toBeUndefined();
		expect(settings.getModelRole("task")).toBe("anthropic/claude-opus-5-5");
	});

	test("overriding one role leaves the other roles' spawns unchanged", async () => {
		const session = await new FakeSession({ settings: config() }).start();
		await session.command("set plan openai/gpt-6.1");

		expect(await session.spawn("plan", TASK_BASE)).toMatchObject({ model: ["openai/gpt-6.1"] });
		expect(await session.spawn("task", TASK_BASE)).toBeUndefined();
		expect(await session.spawn("slow", ["openai/gpt-6.1"])).toBeUndefined();
		expect(await session.spawn("advisor", ["anthropic/claude-haiku-5-5"])).toBeUndefined();
	});

	test("a nested subagent session follows its parent's live overrides", async () => {
		const settings = config();
		const parent = await new FakeSession({ settings, sessionFile: "C:/sessions/p.jsonl" }).start();
		const child = await new FakeSession({
			settings,
			kind: "sub",
			sessionId: "child",
			sessionFile: "C:/sessions/p/0-Task.jsonl",
			parentSession: "C:/sessions/p.jsonl",
		}).start();

		await parent.command("set task google/gemini-3.8-flash");
		expect(await child.spawn("task", TASK_BASE)).toMatchObject({ model: ["google/gemini-3.8-flash"] });

		await parent.command("reset all");
		expect(await child.spawn("task", TASK_BASE)).toBeUndefined();
	});

	test("an override that no longer resolves blocks the spawn instead of silently using config", async () => {
		const session = await new FakeSession({
			settings: config(),
			branch: [
				{
					type: "custom",
					customType: STATE_ENTRY_TYPE,
					data: { v: 1, sessionId: "session-a", roles: { task: "lockedcorp/locked-model" } },
				},
			],
		}).start();

		const result = await session.spawn("task", TASK_BASE);
		expect(result).toMatchObject({ block: true });
	});

	test("with the core patch the overlay is handed to core and spawns are not rewritten twice", async () => {
		const session = await new FakeSession({ settings: config(), core: true }).start();
		await session.command("set task google/gemini-3.8-flash");

		expect(session.coreCalls.at(-1)).toEqual({ task: "google/gemini-3.8-flash" });
		expect(await session.spawn("task", ["google/gemini-3.8-flash"])).toBeUndefined();
	});
});

describe("validation and atomicity", () => {
	test("a missing model is reported and the existing binding is kept", async () => {
		const session = await new FakeSession({ settings: config() }).start();
		await session.command("set task openai/gpt-6.1");
		const writes = session.appendCalls.length;

		await session.command("set task nosuch/model-x");

		expect(session.notices.at(-1)).toMatchObject({ type: "error" });
		expect(session.lastNotice()).toContain("找不到模型");
		expect(session.appendCalls.length).toBe(writes);
		expect(await session.spawn("task", TASK_BASE)).toMatchObject({ model: ["openai/gpt-6.1"] });
	});

	test("a batch with one invalid entry applies nothing", async () => {
		const session = await new FakeSession({ settings: config() }).start();
		await session.command("set task=google/gemini-3.8-flash slow=lockedcorp/locked-model");

		expect(session.lastNotice()).toContain("没有可用凭据");
		expect(session.appendCalls).toEqual([]);
		expect(await session.spawn("task", TASK_BASE)).toBeUndefined();
	});

	test("an unknown role name is rejected", async () => {
		const session = await new FakeSession({ settings: config() }).start();
		await session.command("set taks google/gemini-3.8-flash");
		expect(session.lastNotice()).toContain("未知角色");
		expect(session.appendCalls).toEqual([]);
	});
});

describe("persistence, resume, fork", () => {
	test("reset all restores every role and persists an empty snapshot", async () => {
		const session = await new FakeSession({ settings: config() }).start();
		await session.command("set task google/gemini-3.8-flash plan openai/gpt-6.1");
		await session.command("reset all");

		expect(session.appendCalls.at(-1)).toMatchObject({ roles: {} });
		expect(await session.spawn("task", TASK_BASE)).toBeUndefined();
		expect(await session.spawn("plan", TASK_BASE)).toBeUndefined();
	});

	test("resuming the same session restores its overrides; a new session does not see them", async () => {
		const settings = config();
		const original = await new FakeSession({ settings, sessionId: "s1" }).start();
		await original.command("set task google/gemini-3.8-flash");

		const resumed = await new FakeSession({ settings, sessionId: "s1", branch: original.branch }).start();
		const fresh = await new FakeSession({ settings, sessionId: "s2" }).start();

		expect(await resumed.spawn("task", TASK_BASE)).toMatchObject({ model: ["google/gemini-3.8-flash"] });
		expect(await fresh.spawn("task", TASK_BASE)).toBeUndefined();
	});

	test("a fork starts on the original config and inherits only on /roles inherit", async () => {
		const settings = config();
		const source = await new FakeSession({ settings, sessionId: "src" }).start();
		await source.command("set task google/gemini-3.8-flash");

		const fork = await new FakeSession({ settings, sessionId: "forked", branch: source.branch }).start();
		expect(await fork.spawn("task", TASK_BASE)).toBeUndefined();
		expect(fork.lastNotice()).toContain("/roles inherit");

		await fork.command("inherit");
		expect(await fork.spawn("task", TASK_BASE)).toMatchObject({ model: ["google/gemini-3.8-flash"] });
		expect(fork.appendCalls.at(-1)).toMatchObject({ sessionId: "forked" });
	});

	test("/branch continues the conversation and keeps the overrides under the new session id", async () => {
		const session = await new FakeSession({ settings: config(), sessionId: "before" }).start();
		await session.command("set task google/gemini-3.8-flash");

		session.sessionId = "after-branch";
		await session.emit("session_branch", { reason: "branch" });

		expect(await session.spawn("task", TASK_BASE)).toMatchObject({ model: ["google/gemini-3.8-flash"] });
		expect(session.appendCalls.at(-1)).toMatchObject({ sessionId: "after-branch" });
	});
});

describe("main agent role switching", () => {
	test("changing the role the main agent runs on switches its model immediately when idle", async () => {
		const session = await new FakeSession({ settings: config() }).start();
		await session.command("set default google/gemini-3.8-flash");
		expect(session.setModelCalls).toEqual(["google/gemini-3.8-flash"]);
	});

	test("while a turn is running the switch waits for the turn boundary", async () => {
		const session = await new FakeSession({ settings: config() }).start();
		session.idle = false;
		await session.command("set default google/gemini-3.8-flash");
		expect(session.setModelCalls).toEqual([]);

		await session.emit("agent_end", { messages: [], willContinue: false });
		session.idle = true;
		await session.runTimers();
		expect(session.setModelCalls).toEqual(["google/gemini-3.8-flash"]);
	});

	test("an explicitly chosen session model (temporary) is not touched by role overrides", async () => {
		const session = await new FakeSession({
			settings: config(),
			branch: [{ type: "model_change", role: "temporary" }],
		}).start();
		await session.command("set default google/gemini-3.8-flash");
		expect(session.setModelCalls).toEqual([]);
	});

	test("overriding a role the main agent is not using does not switch it", async () => {
		const session = await new FakeSession({ settings: config() }).start();
		await session.command("set task google/gemini-3.8-flash");
		expect(session.setModelCalls).toEqual([]);
	});
});
