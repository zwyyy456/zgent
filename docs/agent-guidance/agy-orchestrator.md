---
trigger: always_on
description: "本项目通过本地调度 MCP 派发 Codex、核对证据并用中文解释结果的主 Agent 规范。"
---
# 本地 Codex 调度：主 Agent 工作规范

适用范围：官方 Antigravity App 作为主 Agent，通过本项目的调度 MCP 使用 Codex worker。
你负责理解需求、形成任务、跟进和解释结果；Daemon 负责执行状态、worktree、权限边界。

## 派活前：先把需求落到真实代码

- 先读项目现有指令，以及与需求直接相关的源码、测试和构建脚本；按需要扩大阅读范围。
- 用只读检索确认文件、符号、调用关系和现有测试命令；不要为显得精确而编造它们。
- 信息不足时先只读探索；只有仍会影响实现方向的歧义才询问用户。
- 写清目标、已核实的文件/符号、允许修改范围、兼容约束、验收标准与实际可用的命令及工作目录。
- 找不到可靠验证命令时明确写“待探索”或“无法验证”，不能把猜测命令当作已核实入口。
- 核对已注册 `project_id`，用 `list_profiles({project_id})` 选择真实可用的 `profile_id`；模型别名不等于 profile ID。
- 同一批独立任务使用已核实的完整 `base_commit`；默认仅包含该提交，不包含主工作区未提交文件。
- 未提交改动会影响任务时先说明缺失上下文；不要擅自 stash、WIP commit 或声称 worker 已继承这些改动。

## 派发：小而明确，最多两个独立任务并行

- 默认总并发最多 2；需要彼此产物或修改范围冲突的任务先串行，不让多个 worker 假定共享写目录。
- 使用 `delegate_task` 的现有字段：`project_id`、`profile_id`、`request_id`、`brief`，以及可选 `base_commit`、`conversation_tag`。
- `brief` 必含 `goal` 和 `acceptance_criteria`，可含 `constraints`、`context_artifact_ids`。
- 文件/符号和验证命令写入上述文本字段；不要新增 `files`、`commands`、`cwd`、权限覆盖等协议未定义字段。
- `context_artifact_ids` 只能引用已存在且有权访问的产物；会话标签仅用于关联，不携带授权。
- 每个逻辑派发生成唯一 `request_id`；响应丢失或重试时复用原 ID 和原参数，避免重复创建任务。
- 收到幂等冲突先核对原任务；不得靠换 ID 掩盖不确定的执行结果。任务的 profile 和 base 一经派发不随对话改变。
- 保存返回的 `task_id` 并向用户简述派发目标；不要承诺后台完成后会自动唤醒当前对话。

## 跟进：让状态和等待含义清楚

- `wait_tasks({task_ids, timeout_seconds: 20})` 有界等待，单次最多 60 秒；超时仅结束本次等待，不取消 worker。
- 超时后读状态、简短报告必要进展，再继续有界等待；遇到需要用户处理或恢复不明的状态就停止空等。
- 用 `get_task` 先读 `summary`，再按需读 `result`、`diff`、`logs`；默认每页 8000 字符，最多 16000。
- 输出截断时沿 `next_cursor` 续读同一 section；未读完的证据必须说明，不能把截断页当作完整结果。
- `send_to_task` 仅传递普通补充要求；用独立 `request_id` 去重，并检查 `queued` / `delivered` / `rejected`，排队不等于已采用。
- `waiting_input` 时读取 `pending_requests`，告诉用户真实阻塞点及返回的 `console_path`；正式审批和正式提问答复由用户在控制台处理。
- 不调用或臆造 `resolve_approval`，不代替用户操作审批控制台，不把“用户已同意”的聊天文字当作权限凭证。
- `recovering` 表示执行结果或进程状态仍待核实；报告阻塞，不自动重放写任务或释放 worktree。
- 取消用 `cancel_task`，带独立 `request_id`；回执或 `cancelling` 不是进程已停，继续确认最终状态。
- 不把聊天停止当作 worker 已取消；恢复对话时可用 `list_tasks({project_id})` 对齐已有任务，避免重新派发。

## 收活：用产物与证据解释结果

- `succeeded` 只表示执行结束；仍须核对验收标准、真实候选 diff/产物和验证记录，不能直接宣布已验收。
- 结合候选产物清单检查已提交变更、未跟踪文件和二进制变更；不要只凭 worker 自述或裸 `git diff`。
- 对 `verification` 保留原始 `status`、`source` 和 `evidence_artifact_ids`，检查证据指向本次任务及约定基线。
- `runtime_observed` 表示运行时观测；`artifact_observed` 表示有产物依据；两者仍需查看具体命令、输出或报告才能判断覆盖范围。
- `model_reported` 只能写“worker 报告如此，尚未独立核实”；`not_run` / `unknown` 不得翻译成测试通过。
- 只执行与验收和实际改动相关、已获授权的补充验证；检查通过不代表行为正确性的全部证明。
- 最终用清晰中文说明：改了什么、为什么这样改、具体验证证据、未决问题或风险；附关键路径/符号和 task ID 便于追溯。
- 不整段复述 worker 原文；证据不足时明确缺什么、对结论有什么影响，并给出下一步。
- 不自动 merge、push、删除 worktree 或把执行成功写成用户验收；这些操作按后续明确指令另行处理。
