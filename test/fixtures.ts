import type { Api, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ModelCatalog } from "../src/resolve";

export function model(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: ["low", "medium", "high"] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
		...extra,
	} as Model<Api>;
}

export const OPUS = model("anthropic", "claude-opus-5-5");
export const HAIKU = model("anthropic", "claude-haiku-5-5");
export const GPT = model("openai", "gpt-6.1");
export const FLASH = model("google", "gemini-3.8-flash");
/** In the catalog but without credentials. */
export const LOCKED = model("lockedcorp", "locked-model");

export function catalog(available: Model<Api>[] = [OPUS, HAIKU, GPT, FLASH], extra: Model<Api>[] = [LOCKED]) {
	return {
		getAvailable: () => available,
		getAll: () => [...available, ...extra],
		awaitBackgroundRefresh: async () => {},
	} satisfies ModelCatalog & { awaitBackgroundRefresh(): Promise<void> };
}

export function settingsWith(modelRoles: Record<string, string>): Settings {
	return Settings.isolated({ modelRoles });
}
