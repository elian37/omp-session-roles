# omp 会话级模型角色覆盖层（核心补丁，18.12.2 / 18.12.3）

- 补丁（统一 diff，相对对应版本 `@oh-my-pi/pi-coding-agent` 包根目录 `package/`，可用 `git apply`）：
  - `omp-18.12.2-session-model-roles.patch` → 18.12.2
  - `omp-18.12.3-session-model-roles.patch` → 18.12.3
- 单测：`tests/session-model-roles.test.ts`
- 上游：can1357/oh-my-pi#5858（截至 2026-10-20 仍为 OPEN）

## 两个版本的补丁

先确认版本：`omp --version`（输出形如 `omp/18.12.3`），或看包内 `package.json` 的 `version`，然后选同版本的补丁。

两个补丁的改动内容逐行相同（同样 7 个文件，+166/−15），区别只在 hunk 行号：18.12.3 的 `types.ts` 偏移 25 行，`sdk.ts` 偏移 13 行。18.12.2 版补丁对 18.12.3 也能 `git apply`（带 offset 提示）；18.12.3 版是在 18.12.3 git 工作副本上应用后重新 `git diff` 导出的，行号精确。

18.12.3 相对 18.12.2 的源码差异已核查：`settings.ts`、`cfg-protocol.ts`、`loader.ts`、`runner.ts`、`model-presets.ts` 没有变化；新增代码里没有 `settings ===` 身份比较，也没有新的角色读取路径绕过会话视图。新增的 job widget 作者（`createModelJobWidgetAuthor({ settings, … })`，读 `widget` 角色）拿到的是会话视图，所以同样受覆盖层影响。补丁无需改动语义。


## 为什么必须改核心

主会话的 `session.settings` 就是进程全局的 `Settings` 单例（`src/sdk.ts` 中 `Settings.init`）。所有角色读取最终都走 `settings.getModelRole(role)` / `cfgModelRoles.get(settings)`，包括 advisor、`model-controls`（Ctrl+P 角色轮换、plan 角色）、task 派生策略、`ctx.models.resolve("@role")`。18.12.2 的扩展 API 只能写这个全局单例：

- `override()` / `overrideModelRoles()` 写的是进程全局的 runtime 层，同一进程里其他顶层会话（ACP 多会话、SDK 多会话）都会看到，也会被 `/settings` 显示为 runtime 覆盖；
- 「改完再恢复」在并发会话和异步 spawn 之间做不到原子。

因此必须让每个顶层会话拥有自己的 settings 实例，且该实例读取时能叠加会话覆盖层，写入时仍落到原全局/项目配置。

## 设计：write-through 会话视图

`Settings.sessionView()` 返回父实例的一个 overlay 子实例，额外打上 `#writeThrough` 标记：

- **读**：父实例实时合并视图 + 本视图的 `#sessionModelRoles`（只合并在 `modelRoles` 键上，优先级高于 env 以外的所有层）。
- **写/持久化**：`writeValue`、`unsetGlobalValue`、`writeEntry`、`writeMember`、`pinDefaultValue`、`clearOverrideValue`、`setModelRole`、`setProjectModelRole`、`clearProjectModelRole`、`overrideModelRoles`、`flush`、`reloadFromDisk`、`reloadForCwd` 全部转发给父实例；`getCwd`、`getConfigFiles`、`isProjectModelRoleRuntimeOverrideActive` 也读父实例。父实例写入后通过已有的 overlay 子实例转发机制（`#childForwarders`）通知视图的监听器，行为与之前直接用全局单例一致。
- **会话覆盖层**：`setSessionModelRoles(roles)` 整表替换（`{}` 清空），然后 `#rebuildMerged()`，并在 `modelRoles` 有效值变化时触发 `cfgModelRoles` 变更通知（视图自己的监听器 + 其 overlay 子实例）。全局单例上调用会抛错，覆盖层从不进入任何 YAML 层，也从不 `queueSave`。
- **子 Agent**：`createSubagentSettings` 本来就是 `parent.overlay(...)`，父实例换成视图后，子 Agent 通过读穿自动继承覆盖层，无需改 `task/executor.ts`。

## 改动文件与理由

| 文件 | 改动 | 理由 |
|---|---|---|
| `src/config/settings.ts` | `SettingProvenance` 加 `"session"`；新增 `#sessionModelRoles`、`#writeThrough`、`sessionView()`、`writeTarget()`、`setSessionModelRoles()`、`getSessionModelRoles()`；上述写/持久化方法在视图上转发；`#rebuildMerged()` 合并覆盖层并让视图跟随父实例的 cwd；`getProvenance(cfgModelRoles)` / `getModelRoleProvenance(role)` 对覆盖角色返回 `"session"`；`cloneForCwd()` 对视图仍返回视图并复制覆盖层；`overlay()` 用 `getCwd()` 作为子实例 cwd | 特性主体 |
| `src/sdk.ts` | `createAgentSession` 对**顶层**会话（无 `parentTaskPrefix`/`taskDepth`）把 `options.settings`/`Settings.init()` 结果包成 `sessionView()`，之后 `settings` 变量（`session.settings`、扩展 runner、advisor host、model-controls、tool session、task spawn）全部用该视图；`bindsProcessState` 复用同一判断 | 每个顶层会话一个视图，子 Agent 不再包一层 |
| `src/extensibility/extensions/types.ts` | `ExtensionAPI` 新增 `setSessionModelRoles` / `getSessionModelRoles`；`ExtensionRuntime` 接口新增同名成员 | Contract 声明 |
| `src/extensibility/extensions/loader.ts` | runtime 占位桩（初始化前调用抛 `ExtensionRuntimeNotInitializedError`）与 `ConcreteExtensionAPI` 方法 | 与其他 action 方法保持同一模式 |
| `src/extensibility/extensions/runner.ts` | `initialize()` 中把两个方法绑定到 runner 构造时拿到的会话 settings | 见下文「为什么不改各处 ExtensionActions」 |
| `src/internal-urls/cfg-protocol.ts` | `settings === persistent` 改为 `settings.writeTarget() === persistent`（两处）；`PROVENANCE_LABELS` 加 `session`；会话级写入后的遮蔽检查加入 `"session"` | 不改的话，`cfg://.../save` 在视图上会走「独立实例」分支，额外在全局 runtime 层留下一个覆盖（回归）；新 provenance 需要标签 |
| `src/config/model-presets.ts` | `SOURCE_LABELS` 加 `session` | `Record<SettingProvenance, string>` 需完整，preset 遮蔽提示会用到 |

### 为什么不改各处 ExtensionActions

原任务建议在 `runtime-init.ts`、`extension-ui-controller.ts`（两处）、`acp-agent.ts` 的 actions 里分别实现。实际上这两个方法只需要「本 runner 所属会话的 settings」，而 `ExtensionRunner` 构造时已持有该实例（`sdk.ts` 传入的 `settings`，即会话视图）。在 `runner.initialize()` 统一绑定可覆盖 TUI、print/json、RPC、ACP 以及子 Agent（`task/executor.ts`、`persisted-revive.ts` 也走 `initializeExtensions`）全部模式，未来新增宿主也不会漏，改动更小。

### 交互层（`src/modes/controllers/*`）

已核查：角色相关的显示和解析（model hub、`/model` 选择器、`@role` 补全、Ctrl+P、plan 角色、advisor 选择）都读 `this.ctx.settings` / `session.settings`，即会话视图，因此**未改任何 controller**。`selector-controller.ts` 中对全局 `settings` 代理的直接引用只用于状态栏、分支摘要、树过滤、禁用 provider，与角色无关。`InteractiveMode` 的 `cfgModelRoles.listen(this.settings, …)`（plan 模式切换模型）挂在会话视图上，覆盖层变更会触发它（单测已覆盖 `cfgModelRoles.listen(view, …)`）。

## Contract 1–5 如何满足

1. **只属于调用方会话**：覆盖层存在视图实例的私有字段中，同一全局单例的另一个视图、全局单例本身都读不到（单测「two views…」；端到端中 `pi.pi.settings.getModelRole("slow")` 仍为配置值）。
2. **之后创建的子 Agent 继承**：子 Agent settings 是视图的 overlay，读穿继承（单测「overlay children…」；端到端中 task 子 Agent 实际请求模型 = 覆盖值）。已运行子 Agent 的模型在 spawn 时已决定，不会被切换；但其 settings 读到的是实时值，后续在该子 Agent 内的新角色解析会看到更新。
3. **所有角色读取都看到覆盖层**：覆盖层合并在 `#merged`，`getModelRole`/`getModelRoles`/`cfgModelRoles.get`/`@role` 展开/`resolveConfiguredModelPatterns`/task 策略/advisor/model-controls/`ctx.models.resolve` 都经过它；`getModelRoleProvenance` 与 `getProvenance(cfgModelRoles)` 返回 `"session"`。
4. **写操作 write-through**：所有写与持久化方法转发给父实例；`cfg://` 保存分支用 `writeTarget()` 判断「共享持久实例」，保持原行为（单测「writes through a view persist…」检查 `config.yml` 落盘内容不含覆盖层）。
5. **不碰全局 runtime 层**：实现不调用 `override()`/`overrideModelRoles()`，全局 `#overrides` 不变。

## 应用 / 构建 / 回滚

在 18.12.2 的 `@oh-my-pi/pi-coding-agent` 包根目录（含 `src/`、`package.json`）下：

```bash
git apply --check /path/to/omp-<版本>-session-model-roles.patch
git apply /path/to/omp-<版本>-session-model-roles.patch
# 回滚
git apply -R /path/to/omp-<版本>-session-model-roles.patch
```

- 包内 `package.json` 的入口是 `src/*.ts`，用 bun 从源码运行即生效：`bun <pkg>/src/cli.ts ...`。
- 补丁**不修改** `dist/cli.js`（npm 包内的打包产物）和用户安装的 `omp.exe`（bun 编译的单文件）。要让日常 `omp` 生效，需要在上游 monorepo 应用补丁后重新 `bun build --compile`，或改用源码入口启动；本次未做。
- 若用 bun 安装依赖再打补丁，Windows 上请用 `bun install --backend=copyfile`，避免硬链接回全局缓存导致改动污染其他项目。

## 验证证据（18.12.2）

| 项 | 命令 / 方法 | 结果 |
|---|---|---|
| 补丁可应用 | 在干净的 `npm pack @oh-my-pi/pi-coding-agent@18.12.2` 解包目录 `package/` 执行 `git apply --check <patch>` | 通过 |
| 单测 | `OMP_PKG=<已打补丁的包> bun test core-patch/tests/` | 7 pass / 0 fail，52 个 expect |
| 类型检查 | `tsgo -p tsconfig.typecheck.json`（临时 tsconfig：strict、bundler 解析、`@types/bun`），对打补丁前后各跑一次比较 | 两次都是 393 条错误且逐条相同（都是包外环境基线，如 `.md` 文本 import 缺声明、DOM lib 冲突），**补丁没有新增错误**。上游 monorepo 的正式 tsconfig 不在 npm 包内，未用它检查 |
| 端到端 | 隔离 `PI_CODING_AGENT_DIR`（`agent.db` 通过 SQLite backup API 从只读连接拷出；`config.yml` 为新建的最小配置：default/slow/task = `anthropic/claude-haiku-5-5`），`bun src/cli.ts -p --no-session -e probe-ext.ts "<让主 Agent 调用一次 task>"`；探针扩展在 `session_start` 调 `pi.setSessionModelRoles({slow, task: "google-antigravity/gemini-3.8-flash"})` | `ctx.models.resolve('@slow')` 与 `@task` 由 haiku 变为 gemini-3.8-flash；全局 `pi.pi.settings.getModelRole("slow")` 仍为 haiku；task 子 Agent（depth 1）的 `ctx.model` 和实际 assistant 消息 wire 模型都是 `google-antigravity/gemini-3.8-flash`，回复 `OK`；主 Agent 仍是 haiku，最终输出 `DONE OK`；隔离 `config.yml` 运行前后逐字节相同 |

## 验证证据（18.12.3）

工作副本：本地临时目录（`package/` 为 git 副本；`e2e/node_modules/@oh-my-pi/pi-coding-agent` 为 `bun add --backend=copyfile` 安装的 18.12.3 依赖树中已打补丁的副本；`iso-agent/` 为隔离 agentDir）。

| 项 | 命令 / 方法 | 结果 |
|---|---|---|
| 补丁可应用 | 在干净的 `npm pack @oh-my-pi/pi-coding-agent@18.12.3` 解包目录 `package/` 执行 `git apply --check omp-18.12.3-session-model-roles.patch` | 通过（18.12.2 版补丁也通过，仅 offset） |
| 单测 | `OMP_PKG=<已打补丁的 18.12.3 包> bun test core-patch/tests/` | 7 pass / 0 fail，52 个 expect |
| 类型检查 | 同 18.12.2 的 tsgo 方法，打补丁前后对比 | 前后都是 397 条，逐条相同，补丁没有新增错误 |
| 探针端到端 | 同 18.12.2：隔离 `PI_CODING_AGENT_DIR`，`bun src/cli.ts -p --no-session -e probe-ext.ts`，探针 `setSessionModelRoles({slow, task: gemini-3.8-flash})` | `@slow`/`@task` 从 haiku 变为 gemini-3.8-flash；全局单例 `slow` 仍是 haiku；task 子 Agent 实际 wire 模型是 `google-antigravity/gemini-3.8-flash`，回复 `OK`；主 Agent 是 haiku，输出 `DONE OK`；隔离 `config.yml` 运行前后字节相同 |
| 插件本体端到端（RPC） | `bun <补丁副本>/src/cli.ts --mode rpc --no-extensions -e <本仓库>/src/index.ts -e <请求探针> --config <overlay：default/task/plan/slow/advisor=haiku> …`；探针在 `before_provider_request` 记录请求模型、`ctx.models.resolve('@advisor'/'@task')`、`pi.getSessionModelRoles()` 与全局单例值 | 6/6 通过：(a) `/roles show` 第二行为「完整模式：已检测到核心补丁…」；(b) `/roles set task google-antigravity/gemini-3.8-flash` 后，task 子 Agent 实际请求模型为 gemini-3.8-flash，主 Agent 仍为 haiku；核心覆盖层 `{task: gemini}` 已安装，`pi.pi.settings` 的 `task` 仍为 haiku；(c) `/roles set advisor xai-oauth/grok-4.7` 后，主会话请求时 `ctx.models.resolve('@advisor')` 从 haiku 变为 `xai-oauth/grok-4.7`，全局单例 `advisor` 仍为 haiku；隔离 `config.yml` 与 overlay 文件 mtime+hash 不变 |
| TUI 启动（主会话，2026-10-20） | `bun <补丁副本>/src/cli.ts --no-extensions -e <本仓库>/src/index.ts --no-session --no-title --no-lsp --no-skills`，执行 `/roles set advisor google-antigravity/gemini-3.8-flash:low` 后打开 `/roles` | 源码入口的 TUI 正常启动；面板第二行为「完整模式」，`advisor` 行显示 `…:low [会话]`，状态栏显示「会话角色覆盖：advisor」；用户 `config.yml` hash 不变。只验证了启动与面板，未在 TUI 中跑 plan 模式切换 |

## 未验证项与风险

- **ACP 未实测**；TUI 只验证了源码入口启动与 `/roles` 面板（见上表），plan 模式的会话覆盖切换未在 TUI 中实测。RPC 已用插件本体实测（见上）。这些模式读写角色的路径已核查为会话视图，runner 统一绑定方法。
- **advisor 只验证了解析结果**：(c) 证明了 `@advisor` 在会话内解析为覆盖值，但测试配置里 `advisor.enabled: false`，没有真正触发 advisor 请求。
- **未跑上游完整测试套件**（npm 包不含 `test/`）；可能有上游单测断言「顶层 `session.settings === Settings.instance`」，合入上游时需要一起调整。
- **身份比较**：已检查并修正 `cfg-protocol.ts` 的 `settings === persistent`。其他 `=== settings` 比较（`judgment` 缓存、registry effect 绑定、`interactive-mode` 的 `change.settings !== this.session.settings`）都比较同一会话实例，不受影响。仍可能有未发现的依赖顶层 `session.settings` 等于全局单例的地方。
- **辅助会话**：`/tan` fork 等显式传入全局 `settings` 代理的辅助会话会得到自己的空视图，**不继承**主会话覆盖层（与 Contract「子 Agent 继承」无冲突，但值得知道）。安全扫描（`security/coordinator.ts`）用 `cloneForCwd`，会复制覆盖层。
- **同一 AgentSession 跨 /new、/resume、/fork 保留覆盖层**（视图挂在 AgentSession 上）；插件需在 `session_start`/`session_switch`/`session_branch`/`session_tree` 后自行重设。
- 覆盖层值只校验为非空字符串，不校验模型是否存在；无效值与配置里写错角色值的表现相同（解析失败时走原有回退逻辑）。
- 视图会在父实例 cwd 变化后的下一次读取或重建时同步 cwd；在两者之间，直接读私有 `#cwd` 的内部路径可能短暂使用旧 cwd（公开的 `getCwd()` 始终转发父实例）。
