# omp-session-roles

**中文** | [English](README.en.md)

Oh My Pi（omp）扩展：**当前会话独立的模型角色配置**。在正在运行的对话里用 `/roles` 给 `task`、`plan`、`slow`、`advisor`、`default` 以及自定义角色指定模型和 Thinking Level：

- 只对当前会话生效，其他对话、项目和全局配置都不受影响；
- 不需要重启或退出，新启动的子 Agent 立刻使用新模型；
- 不写入 `config.yml`、项目 `.omp/config.yml`，也不改 Provider / API Key / 认证信息。

覆盖值作为会话条目（`custom` / `omp-session-roles/state`）保存在会话 JSONL 里，Resume 时恢复，新建对话时不会带上。

适配版本：omp 18.12.x，已在 18.12.3 上实测。

## 是否需要 OMP 核心补丁

**结论：不需要补丁也能满足验收标准；如果要覆盖面完整，再加补丁。**

官方 Issue [#5858](https://github.com/can1357/oh-my-pi/issues/5858)（扩展 API 不能按会话修改角色）截至 2026-10-20 仍未解决。18.12.x 的扩展 API 只能写进程全局的 `Settings` 单例，写进去会泄漏到其他会话，所以插件不走这条路。插件用两种模式运行，启动时自动检测，`/roles show` 第二行会显示当前是哪种：

| 解析路径 | 原版 omp（兼容模式） | 加核心补丁（完整模式） |
|---|---|---|
| task / eval `agent()` / workpool 子 Agent（`@task`、`@slow`、`@smol`、`@plan` 等） | ✅ 走官方钩子 `before_subagent_spawn` 重写模型 | ✅ 由核心直接解析 |
| 嵌套子 Agent（子 Agent 再派生子 Agent） | ✅ 父会话有会话文件时生效（`--no-session` 下只覆盖第一层） | ✅ |
| 主 Agent 正在使用的角色被修改 | ✅ 空闲时立即切换；运行中在回合结束后切换 | ✅ |
| 角色互相引用（如 `plan: @slow` 时覆盖 `slow`），`default` 继承 | ✅ | ✅ |
| advisor watchdog、plan 模式主模型、Ctrl+P 角色轮换、`/switch @role`、其他扩展的 `ctx.models.resolve("@role")` | ❌ 仍读原始配置 | ✅ |

核心补丁很小（7 个文件，+166/−15），给每个顶层会话一个会写回全局的 settings 视图，再新增 `pi.setSessionModelRoles()` / `pi.getSessionModelRoles()`。补丁原理、改动点、Contract 和验证证据见 [`core-patch/README.md`](core-patch/README.md)。补丁只改源码，**不改你装的 `omp.exe`**，要用就从源码入口启动（见下文「可选：启用核心补丁」）。

## 安装

需要 omp 18.12.x，以及 git、bun（仅运行测试时需要）。

```powershell
git clone https://github.com/elian37/omp-session-roles.git
omp plugin link .\omp-session-roles      # 把本地目录链接为 omp 插件
omp plugin list                          # 应列出 omp-session-roles
```

扩展只在 omp 启动时加载，所以**安装后要重启一次 omp**。之后在任何会话里都能直接用 `/roles`，不用再重启。插件运行时直接复用 omp 内置模块，不需要 `bun install`。

> **命令重名**：如果你另有扩展也注册了 `/roles`，omp 按加载顺序后者生效；插件（`omp plugin link`）晚于 `~/.omp/agent/extensions/` 中的扩展加载，所以 `/roles` 由本插件处理（已实测）。为避免混淆，建议禁用另一个扩展。

## 使用

### 交互面板：`/roles`

```text
╭─ 会话模型角色 · 仅当前会话生效，不写配置文件 ─────────────╮
│ 兼容模式：…                                                │
│  ❯ default    anthropic/claude-opus-5-5  [全局]            │
│    task       google-antigravity/gemini-3.8-flash:low [会话]│
│    …                                                        │
│ ↑↓ 选择角色 · Enter 编辑 · Esc 关闭                          │
╰────────────────────────────────────────────────────────────╯
```

- 列出全部已知角色，包括内置角色和 `modelRoles` / `cycleOrder` / `modelTags` 里的自定义角色。角色列表不写死，来自 omp 的 `getKnownRoleIds`。
- 每行显示角色、实际解析到的模型（含 Thinking），以及来源标签：`会话` / `全局` / `项目` / `--config` / `运行时` / `内置默认`。
- 支持输入文字搜索。在某个角色上按 Enter 打开操作菜单：
  - **更换模型…**：打开 omp 原生模型选择器（与 Alt+P 同一个组件，支持搜索、所有 Provider、角色标记），选好后再选 Thinking Level；
  - **设置 Thinking Level…**：保持模型不变，只改 Thinking：不指定 / off / 模型支持的各档 / auto；
  - **恢复原始配置（…）**：删除该角色的会话覆盖。
- 列表末尾有「↺ 清除全部会话覆盖」，需要确认。
- 修改立即生效。有覆盖时状态栏显示「会话角色覆盖：task, plan」。
- 在 RPC 宿主（如 GooeyPi）里没有原生选择器，改为「先选 Provider → 再选模型」的列表，每页 28 项。

### 快捷命令

| 命令 | 作用 |
|---|---|
| `/roles` | 打开面板 |
| `/roles show` | 显示当前会话全部有效绑定、来源和原始值 |
| `/roles set task MODEL` | 会话级覆盖 task（plan、slow、advisor、default、自定义角色同理） |
| `/roles set task MODEL plan MODEL2` 或 `/roles set task=MODEL plan=MODEL2` | 批量设置，原子操作：任一项失败，全部不生效 |
| `/roles reset task` / `/roles reset task plan` | 恢复指定角色的原始配置 |
| `/roles reset all` | 清除当前会话全部覆盖 |
| `/roles inherit` | 在分叉出来的会话里，显式继承来源会话的覆盖 |
| `/roles help` | 用法 |

`MODEL` 写法和 omp 识别的一致：`provider/id`、裸 id、模糊名、`@slow` 这类角色别名都可以，可带 Thinking 后缀，例如 `openai-codex/gpt-6.1-sol:high`、`gemini-3.8-flash:low`、`…:auto`。保存时会规范成 `provider/id[:thinking]`，修改结果会回显，方便核对。

示例：

```text
/roles set task google-antigravity/gemini-3.8-flash:low
/roles set plan openai-codex/gpt-6.1-sol:high slow openai-codex/gpt-6.1-sol:xhigh
/roles show
/roles reset all
```

## 行为说明

- **优先级**：当前会话覆盖 > omp 原有配置解析结果（env / 运行时 / `--config` / 项目 / 全局 / 内置默认）。没有覆盖的角色照常继承。
- **子 Agent**：修改后**新启动**的子 Agent 用新模型，已在运行的不受影响。子 Agent 的路由说明里会标注「会话角色覆盖：task → …」。`task.agentModelOverrides` 里给某个 agent 写死的具体模型，以及调用 task 时显式传的具体模型，按 omp 原有优先级仍然优先。
- **主 Agent**：只有当前主 Agent 正在用的角色（例如 `default`，或经 Ctrl+P 切到的角色）被修改或恢复时才会切换模型；运行中的回合结束后才切，不会打断。用 `/model` 显式选的模型、plan 模式的临时模型不会被改动。
- **会话持久化**：每次修改追加一条完整快照，并标记写入它的会话 ID。
  - Resume / 切回同一会话：恢复覆盖。
  - 新建会话：使用原始配置。
  - Fork（`/fork`、btw 提升）：默认使用原始配置，并提示可用 `/roles inherit` 显式继承。
  - `/branch`（从之前某条消息继续）：视为同一对话，保留覆盖。
  - 覆盖跟随会话树分支：用 `/tree` 回到设置之前的节点，覆盖也随之回退。
- **错误处理**：
  - 模型不存在、存在但没有凭据、种类不适用于该角色（例如图像角色选了聊天模型），都会明确报错，原绑定不变。
  - Resume 时如果某个覆盖已经不可用（凭据过期、模型下线），会给出警告；相关子 Agent 启动时会被**拒绝并说明原因**，不会悄悄退回原配置。

## 测试

```powershell
cd omp-session-roles
bun install
bun run test         # 单元 + 行为测试（25 个）：解析/校验/子 Agent 路由/隔离/原子性/持久化/分叉/主 Agent 切换
bun run check        # TypeScript 严格类型检查（src、test、e2e）
bun run e2e          # 真实 omp 端到端验收 A–G（RPC 模式，会产生少量真实模型请求：主 haiku + 子 gemini-3.8-flash）
bun run e2e:panel    # 通过 RPC 驱动 /roles 面板全流程；若存在 ~/.omp/agent/extensions/model-roles.ts，同时验证 /roles 由本插件响应
bun run e2e:install  # 在隔离的 PI_CONFIG_DIR 里 link → 加载 → uninstall
bun run e2e:patched  # 原样执行「启用核心补丁」命令（临时目录），验证源码入口下插件进入完整模式
bun run test:core    # 核心补丁单测（OMP_PKG 指向已打补丁的 pi-coding-agent 包，见 core-patch/README.md）
```

e2e 使用独立的会话目录、项目目录和 `--config` 覆盖文件（基础角色设为 haiku），只加载本插件和一个记录 provider 请求的探针（`e2e/probe-requests.ts`），并用 `fs.watch` + mtime + hash 监控全局和项目配置文件。

2026-10-20 在 omp 18.12.3（原版）上的实测结果（`bun run e2e`，19/19 通过）：

| 验收项 | 证据 |
|---|---|
| A 会话隔离 | 另一个并发进程中的会话 `/roles show` 仍是原始值，它的 task 子 Agent 实际请求 haiku；同进程 `/new` 后显示原始值 |
| B 子 Agent 真实生效 | 设置前，子 Agent 的 provider 请求是 `anthropic/claude-haiku-5-5`；设置后是 `google-antigravity/gemini-3.8-flash`，主 Agent 仍为 haiku |
| C 角色独立 | 分别设置 plan / slow / advisor，每次只有对应那一行变化 |
| D 配置不落盘 | 全局 `config.yml`、项目 `.omp/config.yml`、覆盖文件：整个过程没有任何 `fs.watch` 事件，mtime 与 hash 不变 |
| E 恢复 | `/roles reset all` 后全部角色回到原始值 |
| F 会话恢复 | 切回会话后覆盖恢复；进程重启加 `--resume` 后覆盖恢复，子 Agent 实际请求 gemini |
| G 模型不可用 | 不存在的模型报「找不到模型」，原绑定不变；批量设置中一项失败，全部不生效 |
| 主 Agent 切换 | 覆盖 `default` 后，主 Agent 的实际请求变为 gemini；`reset default` 后恢复 haiku |
| Fork | 分叉会话默认使用原始配置并提示 `/roles inherit`，执行后才继承 |

真实 TUI 也验证过（wmux 临时窗格）：`/roles` 面板 → 选 task → 更换模型（原生 `Select Model` 选择器，搜索 `antigravity/gemini-3.8-fl`）→ Thinking 选 `low`，面板立即显示 `task … :low [会话]`，状态栏同步更新。

核心补丁的测试和证据见 [`core-patch/README.md`](core-patch/README.md)：18.12.3 上单测 7/7、探针端到端、插件 RPC 端到端 6/6，源码入口 TUI 显示「完整模式」。

## 可选：启用核心补丁（完整模式）

补丁不改 `omp.exe`，做法是另装一份 omp 源码包、打上补丁、用 bun 从源码启动。版本必须与补丁一致：

```powershell
$ver = ((omp --version) -split '/')[1]          # 例如 18.12.3
$dir = "$HOME\tools\omp-patched-$ver"
New-Item -ItemType Directory -Force $dir | Out-Null
Set-Location $dir
'{ "name": "omp-patched", "private": true }' | Set-Content package.json
bun add "@oh-my-pi/pi-coding-agent@$ver" --backend=copyfile   # copyfile：避免硬链接改到 bun 全局缓存
$patch = "<omp-session-roles 仓库路径>\core-patch\omp-$ver-session-model-roles.patch"   # 替换为实际路径
$env:GIT_CEILING_DIRECTORIES = $dir   # $dir 若位于某个 Git 仓库内，git apply 会按外层仓库根解析路径并静默跳过，这行防止此情况
Push-Location node_modules\@oh-my-pi\pi-coding-agent
git apply --check $patch
git apply $patch
Select-String -Quiet -Path src\config\settings.ts -Pattern setSessionModelRoles   # 必须输出 True
Pop-Location
# 启动（读写的仍是同一个 ~/.omp/agent；插件照常通过 omp plugin link 加载）
bun "$dir\node_modules\@oh-my-pi\pi-coding-agent\src\cli.ts"
```

可在 `$PROFILE` 里加一个别名：`function omp-patched { bun "$HOME\tools\omp-patched-18.12.3\node_modules\@oh-my-pi\pi-coding-agent\src\cli.ts" @args }`。

- 回滚：在同一目录执行 `git apply -R $patch`，或直接删除 `$dir`。原 `omp.exe` 从未被改动。
- 已验证：`e2e/patched-install.ps1` 原样执行上面的命令（仅把 `$dir` 换成 `e2e/` 下的临时目录），源码入口加载插件后显示「完整模式」。核心补丁本身在 18.12.3 上的单测、探针端到端、插件 RPC 端到端（6/6）和源码入口 TUI 启动均已通过（见 `core-patch/README.md`）。
- 未验证：plan 模式切换和 advisor 真实请求没在 TUI 中跑过；ACP 模式未测。omp 自动升级到新版本后，需要换用对应版本的补丁（`core-patch/` 下同名版本号）重新安装；补丁目录里暂无更新版本时，完整模式不可用，插件会自动回到兼容模式。

## 卸载 / 恢复原状

```powershell
omp plugin uninstall omp-session-roles     # 只移除 ~/.omp/plugins 中的链接与锁文件条目，不删源码
# 然后重启 omp
```

- 插件从不写任何配置文件，所以没有配置需要恢复。
- 会话 JSONL 里已有的 `omp-session-roles/state` 条目，卸载后不再生效，也不会进入模型上下文，可以保留。
- 如果启用过核心补丁：删掉 `$HOME\tools\omp-patched-*` 目录和 `$PROFILE` 里的别名即可。

## 目录

```text
src/index.ts      扩展入口：会话事件、before_subagent_spawn 路由、主 Agent 回合边界切换、/roles 命令
src/state.ts      持久化快照格式；按会话 ID 区分「本会话」与「分叉继承」
src/resolve.ts    基于 omp 自身解析器的校验、角色解析、子 Agent 模式串重写
src/report.ts     角色表（/roles show 与面板共用）
src/panel.ts      原生 select + ModelPickerComponent 面板；RPC 宿主的列表回退
src/commands.ts   /roles 参数解析
test/             单元与行为测试（bun test）
e2e/              真实 omp 端到端脚本（RPC 驱动、请求探针、面板驱动、安装检查）
core-patch/       核心补丁（18.12.2 / 18.12.3）、说明、补丁单测
```
