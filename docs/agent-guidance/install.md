# 主 Agent 规范的接入与验收

本目录的模板供使用 Zgent 的项目接入时参考。身份验证、审批和并发上限由 Daemon 执行。

## Claude Code

将 `CLAUDE.md` 的正文作为一个独立章节合并到目标项目已有的 `CLAUDE.md`；保留原有内容并消除冲突。项目没有该文件时才创建项目级 `CLAUDE.md`。官方也支持 `.claude/CLAUDE.md`，不需要同时维护两份。[1]

如需保留独立文件，可将模板保存为项目内 `docs/codex-orchestrator.md`，在已有 `CLAUDE.md` 添加独占一行的 `@docs/codex-orchestrator.md`。导入行不要放进代码块。新会话运行 `/context all`，检查 Memory files 中是否加载了该配置。[1]

## Antigravity App

将 `agy-orchestrator.md` 保存为目标项目根目录的 `.agents/rules/codex-orchestrator.md`；已有同名文件时手工合并。保留模板顶部的 `trigger: always_on` frontmatter。当前官方文档明确：`rules/*.md` 缺少有效 `trigger` 会被忽略；不要把 IDE 的旧路径或 CLI 的 MCP 配置路径当作 App 规则路径。[2]

在 App 的 **Customizations → Installed → Skills & Rules** 中筛选 **Rules**；再到 **Settings → Projects → 目标项目 → Customizations** 检查项目作用域。若项目已有 `AGENTS.md` 或 `GEMINI.md` 并希望集中维护，也可只合并模板 Markdown 正文（去掉 frontmatter），避免重复加载。[2]

## 第一次使用的检查

1. 按 [启动说明](../../README.md) 配置两个客户端并确认均能列出部署的七个工具。
2. 正式 Daemon 启用后，向主 Agent 提供实际已注册的 `project_id`；让它调用 `list_profiles`，不要预填猜测的 Sol/Astra 模型 ID。
3. 选一个小任务，确认派发前输出的是已核实的路径/符号、约束、基线和验收方式；不会仅把用户原话转发给 worker。
4. 确认重试复用原 `request_id`、`wait_tasks` 超时仍保留运行中任务；这由 Daemon 的测试验证，主 Agent 规范只约束调用方式。
5. 收活时检查主 Agent 是否引用真实 diff 和验证证据，并用中文区分“已观测”“worker 自报”“未运行”；不自动合并或自批。

两份模板的工作流程相同，仅入口与 AGY frontmatter 不同。以后修改共享流程时同步更新两份；它们不依赖 ACP、Claude SDK、MCP Apps、SSE 或自研聊天界面。

## 官方依据

- [1] [Claude Code：How Claude remembers your project](https://code.claude.com/docs/en/memory) — 项目文件、导入语法及加载检查；核验日期 2026-11-26。
- [2] [Google Antigravity：Rules](https://antigravity.google/docs/rules/) — App 规则目录、frontmatter 与界面检查方式；核验日期 2026-11-26。

工具字段和限制见 [MCP v1 合同](../../packages/contracts/mcp-tools.json)。
