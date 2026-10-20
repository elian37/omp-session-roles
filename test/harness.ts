/**
 * Minimal in-process host for the extension: one instance per simulated session, sharing the
 * module-level parent registry exactly as OMP's rebound factories do.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import sessionRoles from "../src/index";
import { catalog, OPUS } from "./fixtures";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

export interface Entry {
	type: string;
	customType?: string;
	data?: unknown;
	role?: string;
}

export interface FakeSessionOptions {
	settings: Settings;
	sessionId?: string;
	sessionFile?: string;
	parentSession?: string;
	kind?: "main" | "sub";
	branch?: Entry[];
	core?: boolean;
	available?: Model<Api>[];
}

export class FakeSession {
	readonly handlers = new Map<string, Handler[]>();
	commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	readonly notices: Array<{ text: string; type?: string }> = [];
	readonly appendCalls: unknown[] = [];
	readonly coreCalls: Array<Record<string, string>> = [];
	readonly setModelCalls: string[] = [];
	readonly timers: Array<() => unknown> = [];
	branch: Entry[];
	sessionId: string;
	sessionFile: string | undefined;
	model: Model<Api> | undefined = OPUS;
	idle = true;
	readonly ctx: Record<string, unknown>;

	constructor(readonly options: FakeSessionOptions) {
		this.branch = [...(options.branch ?? [])];
		this.sessionId = options.sessionId ?? "session-a";
		this.sessionFile = options.sessionFile;
		const registry = catalog(options.available);
		const self = this;
		this.ctx = {
			agent: { kind: options.kind ?? "main", id: "Main", name: "main", depth: options.kind === "sub" ? 1 : 0 },
			hasUI: false,
			mode: "print",
			modelRegistry: registry,
			get model() {
				return self.model;
			},
			isIdle: () => this.idle,
			setTimeout: (fn: () => unknown) => {
				this.timers.push(fn);
				return this.timers.length;
			},
			sessionManager: {
				getSessionId: () => this.sessionId,
				getSessionFile: () => this.sessionFile,
				getBranch: () => this.branch,
				getHeader: () => ({ id: this.sessionId, parentSession: options.parentSession }),
			},
			ui: {
				notify: (text: string, type?: string) => this.notices.push({ text, type }),
				setStatus: () => {},
			},
		};
		const api = {
			pi: { settings: options.settings },
			on: (event: string, handler: Handler) => {
				this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
			},
			registerCommand: (_name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				this.commandHandler = command.handler;
			},
			setLabel: () => {},
			appendEntry: (customType: string, data: unknown) => {
				this.appendCalls.push(data);
				this.branch.push({ type: "custom", customType, data });
			},
			setModel: async (target: Model<Api>) => {
				this.setModelCalls.push(`${target.provider}/${target.id}`);
				this.model = target;
				this.branch.push({ type: "model_change", role: "default" });
				return true;
			},
			setThinkingLevel: () => {},
			...(options.core
				? {
						setSessionModelRoles: (roles: Record<string, string>) => this.coreCalls.push({ ...roles }),
						getSessionModelRoles: () => this.coreCalls.at(-1) ?? {},
					}
				: {}),
		};
		// The extension only touches the members provided above.
		sessionRoles(api as unknown as ExtensionAPI);
	}

	async emit(event: string, payload: Record<string, unknown> = {}): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			const value = await handler({ type: event, ...payload }, this.ctx);
			if (value !== undefined) result = value;
		}
		return result;
	}

	async start(): Promise<this> {
		await this.emit("session_start");
		return this;
	}

	async command(args: string): Promise<void> {
		await this.commandHandler?.(args, this.ctx);
	}

	spawn(modelRole: string | undefined, patterns: string[]) {
		return this.emit("before_subagent_spawn", { agent: "task", invocationKind: "task", modelRole, patterns }) as Promise<
			{ model?: string[]; block?: boolean; reason?: string } | undefined
		>;
	}

	async runTimers(): Promise<void> {
		const pending = this.timers.splice(0);
		for (const timer of pending) await timer();
	}

	lastNotice(): string {
		return this.notices.at(-1)?.text ?? "";
	}
}
