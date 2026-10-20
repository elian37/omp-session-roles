/** Tiny RPC driver for `omp --mode rpc` used by the smoke scenarios. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface Frame {
	type: string;
	id?: string;
	method?: string;
	message?: string;
	notifyType?: string;
	success?: boolean;
	data?: unknown;
	error?: string;
	[key: string]: unknown;
}

export class RpcOmp {
	readonly frames: Frame[] = [];
	#proc: ChildProcessWithoutNullStreams;
	#buffer = "";
	#seq = 0;
	stderr = "";

	/** `options.launcher` replaces the `omp` executable (e.g. `["bun", "<patched>/src/cli.ts"]`). */
	constructor(args: string[], options: { cwd: string; env?: Record<string, string>; launcher?: string[] }) {
		const [command, ...prefix] = options.launcher ?? ["omp"];
		this.#proc = spawn(command, [...prefix, "--mode", "rpc", ...args], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			shell: false,
		});
		this.#proc.stdout.setEncoding("utf8");
		this.#proc.stdout.on("data", (chunk: string) => {
			this.#buffer += chunk;
			let index = this.#buffer.indexOf("\n");
			while (index >= 0) {
				const line = this.#buffer.slice(0, index).trim();
				this.#buffer = this.#buffer.slice(index + 1);
				if (line) {
					try {
						this.frames.push(JSON.parse(line) as Frame);
					} catch {
						this.frames.push({ type: "raw", message: line });
					}
				}
				index = this.#buffer.indexOf("\n");
			}
		});
		this.#proc.stderr.setEncoding("utf8");
		this.#proc.stderr.on("data", (chunk: string) => {
			this.stderr += chunk;
		});
	}

	async waitFor(predicate: (frame: Frame) => boolean, timeoutMs = 120_000, from = 0): Promise<Frame> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.frames.slice(from).find(predicate);
			if (found) return found;
			if (Date.now() > deadline) throw new Error(`timeout waiting for frame; last: ${JSON.stringify(this.frames.slice(-3))}`);
			await Bun.sleep(100);
		}
	}

	async ready(): Promise<void> {
		await this.waitFor(frame => frame.type === "ready", 120_000);
		// Let session_start handlers finish before the first command.
		await this.request({ type: "get_state" });
	}

	async request(command: Record<string, unknown>, timeoutMs = 120_000): Promise<Frame> {
		const id = `c${++this.#seq}`;
		const from = this.frames.length;
		this.#proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		return this.waitFor(frame => frame.type === "response" && frame.id === id, timeoutMs, from);
	}

	/** Run a slash command and return the notify texts it produced. */
	async slash(text: string): Promise<string[]> {
		const from = this.frames.length;
		await this.request({ type: "prompt", message: text });
		await Bun.sleep(400);
		return this.frames
			.slice(from)
			.filter(frame => frame.type === "extension_ui_request" && frame.method === "notify")
			.map(frame => `${frame.notifyType ?? "info"}: ${frame.message}`);
	}

	/** Write a frame without waiting for its response. */
	write(frame: Record<string, unknown>): void {
		this.#proc.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	/** Wait for the next extension select dialog after `from`, answer it, and return its options. */
	async answerSelect(
		from: number,
		choose: (options: string[], title: string) => string,
	): Promise<{ next: number; title: string; options: string[]; chosen: string }> {
		const frame = await this.waitFor(
			candidate => candidate.type === "extension_ui_request" && candidate.method === "select",
			60_000,
			from,
		);
		const options = Array.isArray(frame.options) ? frame.options.map(String) : [];
		const title = String(frame.title ?? "");
		const chosen = choose(options, title);
		this.write({ type: "extension_ui_response", id: frame.id, value: chosen });
		return { next: this.frames.indexOf(frame) + 1, title, options, chosen };
	}

	/** Send an agent prompt and wait for the run to settle. */
	async run(text: string, timeoutMs = 300_000): Promise<void> {
		const from = this.frames.length;
		await this.request({ type: "prompt", message: text });
		await this.waitFor(frame => frame.type === "agent_end" && frame.willContinue !== true, timeoutMs, from);
		await Bun.sleep(500);
	}

	notices(): string[] {
		return this.frames
			.filter(frame => frame.type === "extension_ui_request" && frame.method === "notify")
			.map(frame => `${frame.notifyType ?? "info"}: ${frame.message}`);
	}

	async close(): Promise<void> {
		this.#proc.stdin.end();
		const exited = new Promise<void>(resolve => this.#proc.once("exit", () => resolve()));
		await Promise.race([exited, Bun.sleep(8000)]);
		if (this.#proc.exitCode === null) this.#proc.kill();
	}
}
