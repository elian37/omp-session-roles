# omp-session-roles

[中文](README.md) | **English**

An [Oh My Pi (omp)](https://github.com/can1357/oh-my-pi) extension for **session-scoped model role overrides**. Inside a running conversation, use `/roles` to assign a model and thinking level to `task`, `plan`, `slow`, `advisor`, `default`, or any custom role:

- Only the current session is affected; other conversations, projects, and global config are untouched.
- No restart or exit required; newly spawned subagents use the new model immediately.
- Never writes `config.yml` or a project `.omp/config.yml`, and never touches providers, API keys, or credentials.

Overrides are stored as session entries (`custom` / `omp-session-roles/state`) in the session JSONL: they come back on resume and are not carried into new conversations.

Compatibility: omp 18.12.x, tested on 18.12.3. The plugin's UI text (panel labels, notifications) is in Chinese.

## Do you need the omp core patch?

**Short answer: no for the core use case; yes if you want every role consumer to follow the override.**

Upstream issue [#5858](https://github.com/can1357/oh-my-pi/issues/5858) (extensions cannot change roles per session) is still open as of 2026-10-20. In 18.12.x the extension API can only write the process-wide `Settings` singleton, which would leak into other sessions, so this plugin does not do that. It runs in one of two modes, detected at startup; the second line of `/roles show` tells you which:

| Where the role is resolved | Stock omp (compatibility mode) | With core patch (full mode) |
|---|---|---|
| task / eval `agent()` / workpool subagents (`@task`, `@slow`, `@smol`, `@plan`, …) | ✅ model rewritten via the official `before_subagent_spawn` hook | ✅ resolved by core |
| Nested subagents (a subagent spawning subagents) | ✅ when the parent session has a session file (with `--no-session` only the first level) | ✅ |
| The role the main agent is currently using gets changed | ✅ switches immediately when idle, otherwise at the end of the running turn | ✅ |
| Roles referencing each other (e.g. `plan: @slow` and you override `slow`), `default` inheritance | ✅ | ✅ |
| Advisor watchdog, plan-mode main model, Ctrl+P role cycling, `/switch @role`, other extensions' `ctx.models.resolve("@role")` | ❌ still read the original config | ✅ |

The core patch is small (7 files, +166/−15): it gives each top-level session a write-through settings view and adds `pi.setSessionModelRoles()` / `pi.getSessionModelRoles()`. Design, changed files, contract, and evidence are in [`core-patch/README.md`](core-patch/README.md) (Chinese). The patch only changes source; **it does not modify your installed `omp.exe`**. To use it, run omp from the patched source entry (see "Optional: enable the core patch" below).

## Install

Requires omp 18.12.x, plus git; bun is only needed to run the tests.

```powershell
git clone https://github.com/elian37/omp-session-roles.git
omp plugin link .\omp-session-roles      # link the local directory as an omp plugin
omp plugin list                          # should list omp-session-roles
```

Extensions are loaded when omp starts, so **restart omp once after installing**. After that, `/roles` works in any session without further restarts. At runtime the plugin reuses omp's bundled modules; no `bun install` is needed.

> **Command name clash**: if another extension also registers `/roles`, the one loaded later wins. Plugins (`omp plugin link`) load after extensions in `~/.omp/agent/extensions/`, so `/roles` is handled by this plugin (verified). Disabling the other extension avoids confusion.

## Usage

### Interactive panel: `/roles`

- Lists every known role: built-ins plus custom roles from `modelRoles` / `cycleOrder` / `modelTags`. Nothing is hard-coded; the list comes from omp's `getKnownRoleIds`.
- Each row shows the role, the model it actually resolves to (with thinking level), and a source tag: session / global / project / `--config` / runtime / built-in default.
- Type to search. Press Enter on a role to open its actions:
  - **Change model…**: opens omp's native model picker (the same component as Alt+P: search, all providers, role chips), then asks for a thinking level.
  - **Set thinking level…**: keeps the model, changes only the thinking level: unspecified / off / any level the model supports / auto.
  - **Restore original (…)**: removes the session override for that role.
- The last entry, "clear all session overrides", asks for confirmation.
- Changes apply immediately. While overrides exist, the status bar lists them.
- RPC hosts without the native picker get a provider → model list instead, 28 items per page.

### Commands

| Command | Effect |
|---|---|
| `/roles` | Open the panel |
| `/roles show` | Show every effective binding in this session, with source and original value |
| `/roles set task MODEL` | Session override for `task` (same for plan, slow, advisor, default, custom roles) |
| `/roles set task MODEL plan MODEL2` or `/roles set task=MODEL plan=MODEL2` | Batch set, atomic: if any entry fails, nothing is applied |
| `/roles reset task` / `/roles reset task plan` | Restore the original config for those roles |
| `/roles reset all` | Clear every override in this session |
| `/roles inherit` | In a forked session, explicitly inherit the source session's overrides |
| `/roles help` | Usage |

`MODEL` accepts anything omp understands: `provider/id`, a bare id, a fuzzy name, or a role alias such as `@slow`, optionally with a thinking suffix like `openai-codex/gpt-6.1-sol:high`, `gemini-3.8-flash:low`, or `…:auto`. The value is normalized to `provider/id[:thinking]` and echoed back so you can check it.

Examples:

```text
/roles set task google-antigravity/gemini-3.8-flash:low
/roles set plan openai-codex/gpt-6.1-sol:high slow openai-codex/gpt-6.1-sol:xhigh
/roles show
/roles reset all
```

## Behavior

- **Precedence**: session override > omp's normal resolution (env / runtime / `--config` / project / global / built-in default). Roles without an override are inherited as usual.
- **Subagents**: subagents **spawned after** a change use the new model; running ones are not affected. The subagent's routing note shows the override that applied. A concrete model pinned for a specific agent in `task.agentModelOverrides`, or passed explicitly in a task call, still wins, per omp's own precedence.
- **Main agent**: the model switches only when the role the main agent is currently on (e.g. `default`, or a role reached via Ctrl+P) is changed or restored, and only at a turn boundary, never mid-turn. A model picked explicitly with `/model`, or plan mode's temporary model, is left alone.
- **Persistence**: every change appends a full snapshot tagged with the ID of the session that wrote it.
  - Resume / switch back to the same session: overrides are restored.
  - New session: original config.
  - Fork (`/fork`, btw promotion): original config by default, with a hint to run `/roles inherit` to inherit explicitly.
  - `/branch` (continue from an earlier message): treated as the same conversation, overrides kept.
  - Overrides follow the session tree: navigating with `/tree` to a point before an override was set rolls it back too.
- **Errors**:
  - An unknown model, a model without credentials, or a model of the wrong kind for the role (e.g. a chat model for an image role) is rejected with a clear message, and the existing binding is kept.
  - If an override becomes unusable after resume (expired credentials, removed model), you get a warning, and affected subagent spawns are **refused with a reason** rather than silently falling back to the original config.

## Testing

```powershell
cd omp-session-roles
bun install
bun run test         # 25 unit + behavior tests: parsing, validation, subagent routing, isolation, atomicity, persistence, fork, main-agent switch
bun run check        # strict TypeScript type check (src, test, e2e)
bun run e2e          # end-to-end acceptance A–G against real omp (RPC mode; makes a few real model requests: main haiku + subagent gemini-3.8-flash)
bun run e2e:panel    # drives the full /roles panel over RPC; if ~/.omp/agent/extensions/model-roles.ts exists, also checks /roles resolves to this plugin
bun run e2e:install  # link → load → uninstall in an isolated PI_CONFIG_DIR
bun run e2e:patched  # runs the "enable the core patch" commands verbatim in a temp dir and checks full mode
bun run test:core    # core patch unit tests (set OMP_PKG to a patched pi-coding-agent package, see core-patch/README.md)
```

The e2e runs use their own session dir, project dir, and a `--config` overlay (base roles set to haiku). They load only this plugin plus a probe that records each provider request (`e2e/probe-requests.ts`), and they watch the global and project config files with `fs.watch` plus mtime and hash checks.

Results on stock omp 18.12.3, 2026-10-20 (`bun run e2e`, 19/19 passed):

| Check | Evidence |
|---|---|
| A Session isolation | A concurrent session in another process still shows the original binding in `/roles show`, and its task subagent requests haiku; after `/new` in the same process the original value is shown |
| B Subagents really use the override | Before the change the subagent's provider request was `anthropic/claude-haiku-5-5`; after it, `google-antigravity/gemini-3.8-flash`. The main agent stayed on haiku |
| C Roles are independent | Setting plan, slow, and advisor one at a time changed only that row each time |
| D Nothing written to config | Global `config.yml`, project `.omp/config.yml`, and the overlay file: no `fs.watch` events during the whole run, mtime and hash unchanged |
| E Reset | After `/roles reset all` every role is back to its original value |
| F Resume | Switching back restores overrides; after restarting the process with `--resume`, overrides are restored and the subagent requests gemini |
| G Unavailable model | An unknown model is rejected with "model not found" and the binding is kept; a batch with one bad entry applies nothing |
| Main agent switch | After overriding `default`, the main agent's real requests go to gemini; `reset default` switches back to haiku |
| Fork | A forked session starts on the original config, suggests `/roles inherit`, and only inherits after running it |

The real TUI was also checked: `/roles` panel → task → change model (native "Select Model" picker, search `antigravity/gemini-3.8-fl`) → thinking `low`; the panel immediately showed `task … :low` as a session override and the status bar updated.

Core patch evidence is in [`core-patch/README.md`](core-patch/README.md): on 18.12.3, unit tests 7/7, probe end-to-end, plugin RPC end-to-end 6/6, and the patched source entry's TUI showing full mode.

## Optional: enable the core patch (full mode)

The patch does not touch `omp.exe`. Instead, install a separate copy of the omp source package, patch it, and run it with bun. The patch version must match your omp version:

```powershell
$ver = ((omp --version) -split '/')[1]          # e.g. 18.12.3
$dir = "$HOME\tools\omp-patched-$ver"
New-Item -ItemType Directory -Force $dir | Out-Null
Set-Location $dir
'{ "name": "omp-patched", "private": true }' | Set-Content package.json
bun add "@oh-my-pi/pi-coding-agent@$ver" --backend=copyfile   # copyfile: don't hard-link edits into bun's global cache
$patch = "<path to omp-session-roles>\core-patch\omp-$ver-session-model-roles.patch"   # replace with the real path
$env:GIT_CEILING_DIRECTORIES = $dir   # if $dir sits inside a git repo, git apply resolves paths from that repo root and silently skips them
Push-Location node_modules\@oh-my-pi\pi-coding-agent
git apply --check $patch
git apply $patch
Select-String -Quiet -Path src\config\settings.ts -Pattern setSessionModelRoles   # must print True
Pop-Location
# Launch (still uses the same ~/.omp/agent; the plugin loads via omp plugin link as usual)
bun "$dir\node_modules\@oh-my-pi\pi-coding-agent\src\cli.ts"
```

You can add an alias to `$PROFILE`: `function omp-patched { bun "$HOME\tools\omp-patched-18.12.3\node_modules\@oh-my-pi\pi-coding-agent\src\cli.ts" @args }`.

- Roll back: run `git apply -R $patch` in the same directory, or delete `$dir`. The original `omp.exe` is never modified.
- Verified: `e2e/patched-install.ps1` runs the commands above verbatim (only `$dir` points to a temp dir under `e2e/`) and the plugin reports full mode from the source entry. The patch itself passed unit tests, probe end-to-end, plugin RPC end-to-end (6/6), and a TUI launch from source on 18.12.3 (see `core-patch/README.md`).
- Not verified: plan-mode switching and real advisor requests in the TUI; ACP mode. After omp auto-updates, reinstall with the patch matching the new version (`core-patch/` files are named by version). If no patch exists for your version yet, full mode is unavailable and the plugin falls back to compatibility mode.

## Uninstall

```powershell
omp plugin uninstall omp-session-roles     # removes only the link and lockfile entry under ~/.omp/plugins; source is kept
# then restart omp
```

- The plugin never writes config files, so there is nothing to restore.
- Existing `omp-session-roles/state` entries in session JSONL become inert after uninstalling and are never sent to the model; they can stay.
- If you enabled the core patch: delete the `$HOME\tools\omp-patched-*` directory and the alias in `$PROFILE`.

## Layout

```text
src/index.ts      extension entry: session events, before_subagent_spawn routing, turn-boundary main-agent switch, /roles command
src/state.ts      persisted snapshot format; tells "owned by this session" from "inherited via fork" by session ID
src/resolve.ts    validation, role resolution, and subagent pattern rewriting on top of omp's own resolver
src/report.ts     role table shared by /roles show and the panel
src/panel.ts      native select + ModelPickerComponent panel; list fallback for RPC hosts
src/commands.ts   /roles argument parsing
test/             unit and behavior tests (bun test)
e2e/              end-to-end scripts against real omp (RPC driver, request probe, panel driver, install check)
core-patch/       core patch (18.12.2 / 18.12.3), docs, patch unit tests
```

## License

[MIT](LICENSE)
