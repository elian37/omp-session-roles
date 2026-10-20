/** Smoke-test probe: append one JSON line per real provider request (which session, which model). */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const log = process.env.SESSION_ROLES_PROBE_LOG;
	if (!log) return;
	pi.on("before_provider_request", (_event, ctx) => {
		appendFileSync(
			log,
			`${JSON.stringify({
				at: new Date().toISOString(),
				agent: ctx.agent,
				sessionId: ctx.sessionManager.getSessionId(),
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			})}\n`,
		);
	});
}
