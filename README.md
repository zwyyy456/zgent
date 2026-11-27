# Zgent v1.1

macOS 和 Linux 的本地任务调度器。终端是日常入口。官方 Antigravity 和 Claude Code 也可通过 MCP 派活。Codex 和 Claude Agent SDK 在独立 Git worktree 中执行任务，用户在终端或 Web 处理审批和验收。

## 安装与启动

使用 Node.js 26.13.0、pnpm 10.26.1、Git、系统 C 编译器、Codex CLI 0.166.0 或以上，以及 Antigravity CLI。Node 内嵌 SQLite 至少需要 3.51.3。Daemon 会检查本机 Codex 的工作区和审批 socket 隔离。

```sh
pnpm install --frozen-lockfile
pnpm build
./bin/zgent /path/to/git-repo
```

在 Zgent 仓库目录运行 `export PATH="$PWD/bin:$PATH"` 后，可在其他项目目录直接输入 `zgent`。首次运行会探测本机 CLI 和已有的 `~/.codex`，按需启动 Daemon。输入 `/web` 打开浏览器会话，`zgent daemon status` 查看进程，`zgent daemon stop` 请求停止。退出终端界面后，已派发的任务可以继续。

默认状态目录在 macOS 为 `~/Library/Application Support/zgent`，Linux 为 `${XDG_STATE_HOME:-$HOME/.local/state}/zgent`。可以用 `ZGENT_STATE_HOME` 指定其他目录。首次启动不需要写配置。需要覆盖默认值时，在状态目录创建 `config.private.json`，参见 [配置示例](docs/config.example.json)。运行时目录由当前用户拥有，并与状态目录及登记的仓库分开。外部目录的 `0755` 会告警并保留原权限。状态目录和私有配置分别使用 `0700` 和 `0600`。

按档案的可用性提示登录。默认 Codex 使用 `codex login`，AGY 使用 `agy acp --login`，主控启动时通过 `--gemini-dir` 隔离设置。可选的 Claude Agent SDK 使用独立的 Anthropic API key 或 Bedrock、Vertex 身份，通过启动 Daemon 的环境提供。官方 Claude Code 继续使用自己的登录。

## 选择模型和派活

- 内置 `sol`、`astra` 和只读 `review`。`/worker` 查看档案，`/worker astra` 切换当前主会话的默认 worker，`/refresh` 重新读取模型目录。每项任务固定所选档案、模型和基线。[OpenAI Codex 模型可用性说明](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)
- 新建 AGY 会话时会在首条消息前列出 ACP 报告的模型，`/model` 可以切换。主控通过只读项目和调度工具工作。`/project` 打开或切换项目，`/sessions` 列会话，`/session <编号>` 继续已有对话。[Antigravity ACP](https://antigravity.google/docs/ide/extensions/acp/)
- Claude 的 Opus、Fable 等按账号和运行时目录配置。选择计划、API 或云计费来源由本地档案决定。控制台将已观测用量和计费来源分开显示。[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript)
- 停止主会话的回答与取消该轮派发的任务组是两项独立操作。选定的主控只用获准的项目和 worker 档案。

## 接入官方客户端

Daemon 在状态目录生成 `agy-mcp.private.json` 和 `claude-code-mcp.private.json`，每个客户端使用独立的本地凭据。用 Zgent 打开的 Git 项目自动向这两个客户端开放派活和查询。

- Antigravity App 在 **Customizations → Installed → MCP Servers** 查看配置文件路径，将生成的 `mcpServers.zgent` 合并到原配置，再重启该 MCP 服务。
- Claude Code 可用 `claude --strict-mcp-config --mcp-config <状态目录>/claude-code-mcp.private.json` 启动单次会话，路径有空格时加引号。
- 在 TUI 用 `/project` 查看项目 ID。两个官方客户端用该 ID 调用 `list_profiles` 核对档案，再按 [主控规范](docs/agent-guidance/install.md) 派活。支持 MCP Apps 的宿主可以在 `list_tasks` 和 `get_task` 结果中打开任务卡片。审批可在 TUI 或 Web 完成。
- 默认只能控制各自发起的任务。要给某个官方客户端跨客户端追加说明或取消的权限，可在本地配置为该客户端登记项目并显式设置 `control: "project"`。`read` 独立控制可见范围。

## 工作区、审批与恢复

终端主会话默认在同轮首次派活时拍快照，纳入已跟踪和未被忽略的新文件。各任务在独立 worktree 中执行。`/base head` 改用提交基线，`/base snapshot` 改回工作区快照。官方 MCP 默认用项目 `HEAD`。用 `/resume <任务 ID> <说明>` 可显式续做已停止、留有持久上下文的 Codex 任务，新任务采用本轮所选基线。

默认并发两个 worker，执行预算 30 分钟、人工请求 30 分钟、总时限 120 分钟。可在 worker profile 设置 `execution_minutes`、`request_minutes` 和 `total_minutes`，以及 `max_active` 档案并发上限。工具网络默认关闭，可按档案登记域名。

`/diff` 查看实际增量。`/apply` 先预检整份补丁，再写入当前工作区，保留暂存区和提交历史。`/discard` 确认后清理候选。成功应用后也会清理，发现候选中有任务结束后的修改或未归档内容时会保留现场。`/tasks` 显示应用状态，`/worktrees` 显示保留候选。应用中断时，核对文件后可用 `/resolve-apply` 记录结果。旧 worker 停止状态不明时，从 Web 确认停止并对账。

## 验证

```sh
pnpm build
pnpm check
```

检查包括类型与合同、原生工作区和 socket 隔离，以及模拟调度、ACP、恢复和 SSE 联调。可用 `ZGENT_TEST_CODEX` 指定用于原生检查的本机 Codex。更多现场步骤见 [统一验收](docs/acceptance.md)。

公共 v1 合同保存在 [contracts workspace](packages/contracts)。SQLite 先加载原始 [19 表基线](apps/daemon/src/db/schema.sql)，再应用 [主会话迁移](apps/daemon/src/db/sessions.sql) 和 [个人版迁移](apps/daemon/src/db/personal.sql)。设计见 [个人版方案](docs/personal-edition-design.md)。
