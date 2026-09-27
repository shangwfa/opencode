# Team Agent 编排测试（V2）

验证通过 V2 Session Agent API 建立角色成员，并由 HTTP 控制面按依赖顺序调用 primary/subagent，完成分析、实现、审查、修复（若需要）、汇总和成员复用。每一轮通过 SSE 观察真实执行结果，并用 PostgreSQL 确认 Session Agent 与消息持久化。

> 本用例覆盖 Agent 编排，不覆盖 Skill。团队成员是同一 Session 中的 Agent 配置，不等同于各自拥有独立 Session 的多 Agent 团队服务。

## 当前 V2 契约

- 创建 Session：`POST /api/session`，body 显式指定 `location.directory=/workspace` 和模型。
- 创建/更新 Session Agent：`POST /api/session/:sessionID/agents`，body `{ "id": "session/<name>", "config": { ... } }`。
- 选择本轮 Agent：`POST /api/session/:sessionID/agent`，body `{ "agent": "session/<name>" }`。
- 提交一轮并消费事件：`POST /api/session/:sessionID/prompt_stream`，body `{ "text": "...", "metadata": {}, "delivery": "queue" }`，响应为 SSE。
- 当前表为 `session_agents` 和 `session_message`；不得以旧 `session`、`message` 或 `exec_log` 表结构推断 V2 行为。
- 本用例的“按依赖编排”由测试客户端显式串行发送请求，并将上游文本带入下游 prompt；它不验证模型自主调用编排工具。
- 旧版 `/session/:id/agents/create`、`/session/:id/message`、`prompt_async` 等路径不属于当前 V2 契约。

## 环境与执行

```bash
source docs/test-cases/test-env.sh 3
export BASE=http://localhost:14099 # 指向以当前源码构建的隔离 SaaS Docker 容器
export OPENCODE_PASSWORD='测试服务口令'

# 对当前隔离 Docker SaaS + 本地 PG 执行完整 HTTP/SSE/PG 场景
bun docs/test-cases/scripts/team-agent-v2.mjs
```

脚本每轮验证 SSE 执行成功事件和 assistant 输出；角色响应文本仅作为下一阶段输入，不把模型措辞本身当作编排正确的充分证据。若脚本未运行或断言失败，结果不得记为通过。

## 用例

### T52.1 组建团队并持久化角色

建立 lead（primary）、analyst（primary）、coder（subagent）、reviewer（subagent）四个 Session Agent。核对创建 API 返回、Session Agent 列表与 PG `session_agents` 中的四条配置，包含 `agent_id` 和各自 `config.mode`。选择 lead 作为当前 Agent。

### T52.2–T52.5 依赖链：工单、分析、实现、审查

1. lead 将任务整理为团队工单。
2. analyst 输出功能要点、边界条件与验收标准。
3. coder 收到 analyst 输出后实现 `divide(a,b)`，包括除零处理。
4. reviewer 收到实现文本并给出 `[APPROVED]` 或 `[NEEDS_FIX]`。

每轮均断言 prompt_stream HTTP 状态为 200、SSE 包含 `session.execution.succeeded` 且不含 `session.execution.failed`，并检查最终持久化 assistant 消息的 Agent ID 与本轮选择一致。T52.3–T52.5 的文本检查要基于实际响应（验收/除零信息、`def divide`、review verdict），不能只验证 HTTP 成功。

### T52.6 条件修复循环

仅当 reviewer 给出 `[NEEDS_FIX]` 时，把反馈与原实现发给 coder；再把修复结果交 reviewer 复审，直到 `[APPROVED]` 或测试超时/失败。若首次审查即通过，记录为“未触发”，不得记为已验证的修复循环。

### T52.7 汇总归档与 T52.9 成员复用

lead 汇总分析、最终实现和审查结果。随后在同一 Session 再次选择 coder 执行独立的 `multiply(a,b)` 任务，并由 lead 更新汇总。核对各轮有对应的 assistant 消息和 Agent ID，证明同一 Session Agent 配置可在多轮 API 请求中复用。

### T52.8 PostgreSQL 消息/配置核对

通过 PG 查询 `session_agents` 确认四个角色配置；通过 `session_message` 按 Session 检查 assistant 消息及其 `data` 中的 Agent 信息/响应内容。V2 不用旧 `exec_log agent-create` 作为创建审计依据；如果当前 schema 没有相应事件表/字段，记录为能力边界，不以旧版查询替代。

### T52.10 动态团队

动态规划团队属于独立扩展用例：脚本让现有 lead 先输出严格 JSON 团队计划（3 个角色：primary 分析、subagent 实现、subagent 审查），校验角色/顺序字段后，通过 V2 Session Agent API 动态创建角色，再按依赖顺序把上游产出带入下游 `prompt_stream`。还会检查最终 reviewer 质量门、动态 Agent PG 行、消息 Agent 归属与汇总。旧 Python 示例调用旧接口，已不作为可执行脚本。

## 当前测试状态

| 用例 | 当前 V2 状态 | 验证依据 |
|---|---|---|
| T52.1 组建团队与 PG 配置 | 通过 | 四个 Session Agent，PG mode=primary×2/subagent×2 |
| T52.2–T52.5 依赖链与质量门 | 通过 | lead/analyst/coder/reviewer SSE 成功；分析、divide 实现及除零处理断言通过；reviewer 首轮批准 |
| T52.6 修复循环 | 未触发（SKIP） | 首轮 reviewer 返回 `[APPROVED]`；修复分支未实测 |
| T52.7 汇总、T52.9 成员复用 | 通过 | lead 汇总、coder 再执行 multiply、lead 更新汇总；各轮 Agent ID/SSE 核对通过 |
| T52.8 PG 消息核对 | 通过 | `session_message` 中共 12 条 assistant 消息，含静态和动态角色；Session/Agent 清理后无残留 |
| T52.10 动态团队 | 通过 | 模型生成并校验 3 角色 JSON；API 动态创建；3 角色按依赖顺序 SSE 完成；review verdict、lead 汇总及 4 条动态 Agent assistant 消息均通过 PG 核对 |

脚本：[`../scripts/team-agent-v2.mjs`](../scripts/team-agent-v2.mjs)。状态表只在脚本完成并通过对应断言后更新；中断、失败或未触发的分支不记作通过。

**2026-09-26 V2 实跑**：当前源码 Docker SaaS 隔离容器 `opencode-saas-team-e2e`（端口 14099），连接本地 `opencode-v2-up` PG，模型 `Yd-DeepSeek/deepseek-v4-flash`。包含 T52.10 的最终运行输出 18 项 PASS，动态 JSON 团队计划、3 个动态 Agent、依赖顺序执行、review verdict、lead 汇总与 PG 记录均通过。首次 reviewer 已批准，因此 T52.6 输出 SKIP，不计通过。静态和动态文本角色均显式配置全工具 deny，确保验证的是控制面编排。测试 Session 和 Agent 行已由 PG 断言确认清理。一轮未设置工具权限的早期尝试曾在 coder 工具调用后中断；随后显式拒绝工具调用并重跑成功，该失败不计入通过结果。

## 历史记录（非当前 V2 通过证据）

以下记录来自 2026-09-06 至 2026-09-14 的旧镜像/旧接口环境，只能说明当时的测试情况，不能证明当前 V2 路由或 PostgreSQL schema 已通过：

- 2026-09-06：旧镜像记录过静态团队与动态团队流程；包含 `/agents/create`、`/message`、`prompt_async` 和旧表查询。
- 2026-09-14：旧记录明确只有 T52.1 组队实测；T52.2–T52.10 未运行。

本文件当前 V2 状态以本节表格及 V2 脚本实际运行结果为准。
