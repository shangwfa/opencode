# Compose Agent 编排测试（V2）

验证 Session-scoped primary Agent 如何通过 V2 `subagent` 工具并行分发任务，并核验 child Session、Sandbox 文件副作用、PostgreSQL 持久化和 Session 隔离。

> 本用例仅覆盖 Agent/subagent 编排。Skill 用例不在本轮范围内。

## 当前 V2 契约

- 创建 Session：`POST /api/session`，工作目录显式使用 `/workspace`。
- 创建/更新 Session Agent：`POST /api/session/:sessionID/agents`，body 为 `{ "id": "...", "config": { ... } }`。
- 选择当前 Session Agent：`POST /api/session/:sessionID/agent`，body 为 `{ "agent": "..." }`。
- Sandbox Agent 文件：放在 Session Sandbox 的 `/workspace/.opencode/agents/*.md`，再调用 `POST /api/session/:sessionID/agents/refresh` 扫描。
- 模型执行：`POST /api/session/:sessionID/prompt_stream`，验证 SSE 过程及 tool terminal event。
- 当前子 Agent 工具名为 `subagent`；旧版 `task`、`/session/:id/agents/create`、`/message`、`/exec` 不作为 V2 测试接口。
- child Session 需断言 `parentID`、Agent ID、完成事件、文件副作用及 PG `session_v2.parent_id`。

## 环境

```bash
source docs/test-cases/test-env.sh 3
export BASE=http://localhost:14099
export OPENCODE_PASSWORD='隔离测试服务口令'
export PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up'
export MODEL='{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'
# 可选但要覆盖 T42.5 时必须提供：目标为可丢弃的 SaaS 测试容器名
export COMPOSE_RESTART_CONTAINER=opencode-saas-compose-e2e

bun docs/test-cases/scripts/compose-agent-v2.mjs
```

脚本直接通过 HTTP 操作 V2 API；用 `psql` 核对 Agent/child Session 行；若设置 `COMPOSE_RESTART_CONTAINER`，只重启指定测试容器。脚本结束时删除 fixture 文件与测试 Sessions。不要将输出中的 `SKIP` 记作通过。

## 用例

### T42.1：V2 Compose Agent 与 implementer Agent fixture

1. 通过 V2 API 创建 `/workspace` Session。
2. 通过 Session Agent API 创建 `session/compose-<nonce>` primary Agent，并选择该 Agent。
3. 在同一 Session 的 Sandbox 写入 `implementer-<nonce>.md`，定义 subagent mode 和文件修改权限；调用 agents refresh。
4. 断言 API 返回 Agent source/config 正确，PG `session_agents` 保存 Compose Agent `mode=primary`。

### T42.2：并行 subagent 编排和文件副作用

发送明确要求同时创建两个独立文件的 `prompt_stream` 请求。SSE/执行断言：

- Compose Agent 在同一回合发起两个 `subagent` tool call，两个 call 均有成功终态；
- 两次调用产生不同 child Session ID；两个 child 的 `parentID` 都等于 Compose Session，`agent` 都为 Sandbox implementer；
- 对两个 child 调用 V2 `session.wait`，确认都进入 idle；
- 通过 Session filesystem API 读回 `/workspace/compose-alpha-<nonce>.py` 和 `compose-beta-<nonce>.py`，文件内容分别与分配任务一致；
- PG `session_v2` 中存在两条对应的 `parent_id` 记录。

该用例判定工具调用过程、child Session 归属及实际 Sandbox 文件结果；只检查 Compose Agent 的最终文本不算通过。

### T42.3：Session Agent 隔离

创建第二个 Session，断言它的 Agent 列表中没有第一个 Session 的 `session/compose-<nonce>` 定义，并通过 PG 确认该 Agent 行只属于原 Session。

### T42.4：服务重启后的 Agent 持久化

仅当提供 `COMPOSE_RESTART_CONTAINER` 时执行：创建单独的持久化 Session Agent，记录 PG 行；重启指定 SaaS 测试容器后，通过 Agent API 与 PG 再次读取配置并核对 system/config 未变。未设置容器名时脚本必须输出 `SKIP`，不能算作通过。

## 本轮执行结果

| 用例 | HTTP/SSE | Sandbox 结果 | PG | 状态 |
|---|---|---|---|---|
| T42.1 V2 Agent fixture | V2 create/switch/refresh 通过 | Sandbox implementer Agent 被发现 | `session_agents` mode=primary | 通过 |
| T42.2 双 subagent 并行与文件结果 | 两次 `subagent` tool call 均返回 child ID；child 均 idle | 两个目标文件内容精确匹配 | 两条 `session_v2.parent_id` 记录 | 通过 |
| T42.3 Session Agent 隔离 | 第二 Session Agent list 不含 Compose Agent | — | 第二 Session 不存在该 Agent 行 | 通过 |
| T42.4 容器重启持久化 | 重启后 Agent API 读回配置 | — | Agent PG 行及 system 字段保持一致 | 通过 |

**2026-09-26 实跑记录**：隔离 SaaS Docker 容器 `opencode-saas-compose-e2e`（端口 `14099`）连接 `opencode-v2-up` PostgreSQL，使用 `Yd-DeepSeek/deepseek-v4-flash` 执行脚本。10 项断言全部通过，包含 HTTP、SSE、两份 Sandbox 文件、child Session 归属、Session Agent 隔离、容器重启后的 API/PG 持久化以及结束时 PG Session/Agent 零残留。测试容器已清理。

执行脚本：[`../scripts/compose-agent-v2.mjs`](../scripts/compose-agent-v2.mjs)。
