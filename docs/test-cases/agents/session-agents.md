# Session Agents（V2 会话级 Agent）

本文档只描述当前 V2 HTTP API 和当前 SaaS 架构。V1 `/session/...`、`/message`、`{name, prompt, permission}` 命令已移除；API payload 使用 `{ id, config }`，Agent 字段以 `ConfigAgent.Info` 为准。

## 环境与运行

仅在 SaaS + PostgreSQL + 可用 OpenSandbox 环境执行。按 [`../test-env.sh`](../test-env.sh) 配置环境，确保 Docker 服务、目标 PG 和沙箱服务可用：

```bash
source docs/test-cases/test-env.sh 3
# 服务启用 Basic Auth 时设置密码；用户名默认为 opencode，也可用 OPENCODE_AUTH='user:password' 指定完整凭证
export OPENCODE_PASSWORD='本地服务密码'
bun docs/test-cases/scripts/session-agents-v2.mjs
```

需要真实模型调用时，`MODEL` 必须指向该服务已配置且可用的模型，再运行：

```bash
bun docs/test-cases/scripts/session-agents-runtime-v2.mjs
```

两个脚本通过 V2 HTTP API 测试，使用 `finally` 删除所创建的 Session。不要对共享会话运行清理操作。

### V2 契约速查

| 操作 | V2 路由 | 成功响应 |
|---|---|---|
| 创建会话 | `POST /api/session` | `{ data: Session }` |
| 列出有效 Agent | `GET /api/session/:sessionID/agents` | `{ data: SessionAgent.Info[] }` |
| 创建/替换 Session 覆盖 | `POST /api/session/:sessionID/agents`，body `{ id, config }` | `SessionAgent.Info` |
| 删除一个覆盖 | `DELETE /api/session/:sessionID/agents/:agentID` | `204` |
| 清空 Session 覆盖 | `DELETE /api/session/:sessionID/agents` | `204` |
| 重扫沙箱 Agent 文件 | `POST /api/session/:sessionID/agents/refresh` | `{ data: SessionAgent.Info[] }` |
| 选择会话 Agent | `POST /api/session/:sessionID/agent`，body `{ agent }` | `204` |
| 发送消息并等待执行事件 | `POST /api/session/:sessionID/prompt_stream` | SSE |
| 查询持久化消息 | `GET /api/session/:sessionID/message?order=asc` | `{ data: Message[] }` |

`ConfigAgent.Info` 字段包括 `model`、`request`、`system`、`description`、`mode`、`hidden`、`color`、`steps`、`disabled`、`permissions`。不支持 V1 顶层 `temperature` 或 `permission` 字段。Session 重复 upsert 会替换该 Session 保存的部分 config；有效 Agent 再按全局/Location → Session → 沙箱定义逐字段合并。

## 自动化用例

### T16.1–T16.5：CRUD、合并与回退

`session-agents-v2.mjs` 通过 HTTP 验证：

1. 创建自定义 `session/reviewer`，响应 `source=session`，mode/system/description 与提交值一致。
2. 同 ID 再次 POST，验证覆盖记录 upsert 且新 config 替换旧 config；未提交的 Session 字段不会被当作 PATCH 保留。
3. 列表返回有效 Agent，并验证来源字段和 Session Agent 内容。
4. 第二个 Session 看不到第一个 Session 的定义。
5. refresh 成功返回有效列表；沙箱文件优先级、Markdown 解码和失败处理由 Core 测试验证。
6. 删除单项后 Session 来源覆盖消失；clear 后列表仍可读取。

### T16.6：自定义 primary Agent 实际生成

`session-agents-runtime-v2.mjs` 使用真实模型，通过 V2 API 创建 Session Agent、切换 Agent、调用 `prompt_stream`，并同时断言：

- SSE 包含 `session.execution.succeeded` 且不包含 `session.execution.failed`；
- 持久化 assistant 文本包含 Agent system prompt 指定的唯一标记。

此项依赖可用模型配置和外部模型服务。模型不可用时记为环境阻塞，不得将 4xx、provider error 或超时记作通过。

### T16.7–T16.8、T16.16、T16.18：权限与 subagent

当前以 Core 行为测试作为自动化依据：

- `packages/core/test/permission.test.ts`：Session Agent permission 规则参与授权判断；
- `packages/core/test/tool-subagent.test.ts`：Session 定义的 subagent 可被调度，子 Session 关联正确 parent、Agent 和 Location。

V2 在线 E2E 的覆盖要求：通过 `prompt_stream` 让 primary 请求 subagent 工具；断言 SSE/持久化消息中的工具调用和完成状态、子 Session parent/agent 关系、主子 Session 沙箱目录共享。多 subagent 并行与权限拒绝后的执行恢复也应检查。当前脚本**尚未覆盖这些在线模型驱动场景**，不能以 Core 测试替代线上执行链路验收。

### T16.9–T16.10：隔离与删除清理

- Session 隔离由 HTTP 冒烟用例覆盖。
- PostgreSQL upsert/唯一键及 Session 删除级联由 `packages/core/test/session/agents-pg.test.ts` 覆盖。运行方式：

  ```bash
  (cd packages/core && OPENCODE_DATABASE_URL="$PG_URL" bun test --timeout 60000 test/session/agents-pg.test.ts)
  ```

### T16.11–T16.15：完整流程与错误响应

HTTP 冒烟脚本验证创建/更新/读取/删除/清空，并覆盖：

- 不存在 Session 的 create/list/refresh 返回 `404`；
- 缺少 `id`、非法 `mode` 返回 `400`；
- 超过 256 KiB 的配置返回 `413 SessionAgentContentTooLargeError`。

HTTP 冒烟脚本在设置 `PG_URL` 时会额外使用 `psql` 验证 API 创建对应的 `session_agents` 行、删除覆盖后行数归零，以及删除 Session 后级联清理。单独运行 `agents-pg.test.ts` 则用于隔离验证数据库服务的 upsert 和外键级联行为。

### T16.17：内置 ID 与 Session 覆盖

旧版“`compaction`/`title`/`summary` 均拒绝”的预期不再作为 V2 断言：当前 V2 Session Agent 使用 Agent ID 和 `ConfigAgent.Info` 覆盖模型；`SessionContext.selectTitle` 还会按有效配置解析 `title` Agent。当前协议没有保留 ID 禁止列表。

HTTP 冒烟脚本验证 `title` Session 覆盖可被创建并在响应中生效；还应通过一次实际标题生成确认该覆盖被执行。`compaction`/`summary` 的 Session 覆盖是否属于受支持能力需产品契约确认；未确认前不将它们标成“保留名”或“通过/失败”。

### T16.19–T16.20：模型覆盖与全局回退

- Agent 模型覆盖字段为 `config.model`，结构采用 `ConfigModel.Selection`；Session 所选模型则通过 `/api/session/:sessionID/model` 修改。旧版 `temperature` 不在当前 Agent Schema 中。
- 未配置 Session 覆盖时应继续使用全局/Location Agent；ServerFetch API 测试验证 list fallback，Core SessionRunner 测试验证 prompt 实际选择和 system prompt。
- 真实模型路由需补在线断言：切换 Agent 后核对 assistant 消息/执行日志中的模型选择，并确保对话成功。当前 runtime 脚本覆盖 system prompt 生效，**尚未验证 Agent 自定义模型路由**。

### T16.29：主子 Agent 沙箱共享

V2 不使用项目 worktree 作为会话隔离依据。验收应以同一主 Session/Location 的 sandbox 为准：主 Agent 写入唯一文件，子 Agent 读取并返回其内容；同时检查两边的 Session 关系和 `/workspace` 下文件状态。`tool-subagent.test.ts` 仅验证 Location 关联，不能代替真实沙箱 HTTP E2E。当前尚无对应在线脚本。

### T16.30：沙箱重建后的文件/VCS 状态

旧用例中的 worktree 重建前提不适用于 SaaS 会话架构，不能原样迁移。若需验证沙箱重建，应改成验证 Session 对应沙箱的持久化策略：重建前后对同一 `/workspace` 文件做读取和 diff，并检查 PG 中的 Session/sandbox 元数据。具体期望取决于当前 Sandbox volume 配置；本功能文档不把旧 worktree 用例列为适用项。

## T-SUB 子任务专项

旧脚本的 `/session/:id/message`、`/agents/create` 请求全部属于 V1，已不再作为可执行命令。当前已由 `tool-subagent.test.ts` 覆盖 foreground/background 子任务完成、Session Agent 调度、父子关系、Location 共享及失败恢复相关行为。

在线 E2E 尚需单独覆盖 watchdog 生命周期、并行子任务、失败后主 Agent 恢复及服务重启后的消息/PG 状态。执行过程应检查 SSE tool started/completed/failed 事件、最终 assistant 消息、子 Session 记录及 PG 关联；单看 HTTP 状态码不足以通过。

## 覆盖结论与缺口

### 本轮实测记录（2026-09-26）

本轮用工作区源码构建的隔离 SaaS 容器（`14097`）、本地 PostgreSQL `opencode-v2-up`、本地 OpenSandbox 和 `Yd-DeepSeek/deepseek-v4-flash` 执行：

- `session-agents-v2.mjs`：**24 项 HTTP/PG 检查通过**，包括真实沙箱 Markdown 写入与 refresh、PG 行读写和 Session 删除级联；
- `session-agents-runtime-v2.mjs`：primary Agent system prompt 真实模型执行通过，收到 **17 个 SSE 事件**，并验证 fork 未继承 Session Agent；
- `packages/core/test/session/agents.test.ts`、`tool-subagent.test.ts`、`permission.test.ts`、`session-runner.test.ts`：**337 pass / 0 fail**；
- `packages/server/test/session-agents.test.ts`：**1 pass / 0 fail**；
- PG `agents-pg.test.ts`：**2 pass / 0 fail**；Core/Server typecheck、两个脚本的 Node 语法检查和 `git diff --check` 通过。

该实测没有执行在线权限拦截、多 Agent 并行协作、Session Agent 指定不同模型、自动 title generation 覆盖、sandbox 重建等场景；这些仍列为缺口，不能据本轮记录推断通过。

| 验收面 | 当前证据 | 状态 |
|---|---|---|
| V2 Agent CRUD、错误响应、隔离 | HTTP 冒烟脚本 | 覆盖 |
| 字段级来源合并、sandbox Markdown | Core `session/agents.test.ts` | 覆盖；目标服务沙箱文件实扫仍需在线场景 |
| PG upsert、唯一键、API 写入与级联删除 | `agents-pg.test.ts` + HTTP 脚本 `PG_URL` 检查 | 覆盖 |
| primary prompt 生效、SSE 终态 | 真实模型 runtime 脚本 | 有条件覆盖，取决于模型服务 |
| permission 实际拦截工具 | Core `permission.test.ts` | 单测覆盖；HTTP 工具执行链路缺口 |
| subagent 真实工具调用、沙箱共享、多 Agent 并行 | Core 调度测试 | 单测覆盖；在线 E2E 缺口 |
| Agent 专属模型路由、title generation override | 字段/SessionRunner 单测 | 部分覆盖；在线 E2E 缺口 |
| ConfigAgent 全部可选字段（request headers/body、steps、hidden、disabled 等） | Schema 解码及分散单测 | 缺少 API round-trip + PG 字段矩阵 |
| fork 不继承 Session Agent | `session-runner.test.ts` + runtime HTTP 脚本 | 覆盖；runtime 脚本先执行真实模型消息再 fork；空 Session fork 返回 `400 empty_session` |
| sandbox 重建/VCS | 无 worktree 前提 | 需按 volume 持久化策略重新定义，不适用旧用例 |

本轮测试结果需按上表逐项记录；Core/Server 单测通过不能写成所有 HTTP/E2E 用例通过。完整 HTTP 脚本：[`../scripts/session-agents-v2.mjs`](../scripts/session-agents-v2.mjs)、[`../scripts/session-agents-runtime-v2.mjs`](../scripts/session-agents-runtime-v2.mjs)。
