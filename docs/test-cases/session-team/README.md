# Session Team 测试用例

> 基于 [扣子 AI 团队快速入门](https://docs.coze.cn/cozespace_coze_ai_team_quickstart) 文档场景，**纯基于 opencode SaaS 会话（Session）** 模拟全部场景。不依赖 Project/Task。

## 核心思路

扣子的"项目"映射为 opencode 的 **Session**——每个 Session 是一个独立工作空间，可配置多个 Agent（primary + subagent），Agent 之间通过 task 工具调度协作，消息历史和资源在 Session 内持续沉淀。

## 消息规则

- 用户消息不 @ Agent 时必须传 `noReply: true`，只记录消息，不触发默认 Agent 回复。
- 用户 @ Agent 时，`agent` 必须是 `primary` Agent，由该 Agent 回复。
- `subagent` 不能作为用户入口；只能由 primary Agent 通过 `task` 工具调度。

## 场景映射

| 扣子场景 | opencode Session 实现 | 测试文件 |
|---------|---------------------|---------|
| 项目化工作空间（独立对话/文件/资产） | 创建 Session + 配置多 Agent | [`01-create-team.md`](./01-create-team.md) |
| 打造行业专家 Agent（职业模板/专业设定） | Session Agent 预配置 prompt（法务/运营/数据等） | [`02-agent-roles.md`](./02-agent-roles.md) |
| Agent 分工执行 + @ 指定 Agent | primary agent 通过 task 工具调度 subagent | [`03-agent-dispatch.md`](./03-agent-dispatch.md) |
| 多人多 Agent 协作 | 多个独立 Session 各自配置 Agent 团队 | [`04-team-collab.md`](./04-team-collab.md) |
| 云端与本地统一托管 | 不同 provider/model 的 Agent 统一调度 | [`05-cloud-local.md`](./05-cloud-local.md) |
| 项目资产沉淀（上下文持续积累） | Session 消息历史 + Agent/Skill/MCP PG 持久化 | [`06-context-persistence.md`](./06-context-persistence.md) |
| 清理与资源回收 | DELETE Session 级联清理 | [`07-cleanup.md`](./07-cleanup.md) |

## 概念对照

| 扣子 | opencode Session |
|------|-----------------|
| 项目 | Session（独立工作空间） |
| Agent | Session Agent（`POST /session/:id/agents/create`） |
| 行业专家模板 | 预配置 prompt + permission + model 的 Agent |
| @ 指定 Agent | 仅指定 primary Agent；primary Agent 可通过 task 工具调度 subagent |
| 云端 Agent | 使用云端 provider（如 zhipuai）的 Agent |
| 本地 Agent | 使用本地/自建 provider 的 Agent |
| 团队成员 | 多个独立 Session |
| 项目资产 | Session 消息历史 + Agent/Skill/MCP 配置 |

## 关键 API

```
# Session 生命周期
POST   /session                          创建 Session（= 创建项目工作空间）
GET    /session/:id                       获取 Session
GET    /session                           列出所有 Session
PATCH  /session/:id                       更新 Session（title 等）
DELETE /session/:id                       删除 Session（级联清理）
POST   /session/:id/fork                  Fork Session（= 分享上下文给团队成员）

# Session Agent（= 组建 AI 团队）
GET    /session/:id/agents                列出 Agent
POST   /session/:id/agents/create         创建 Agent（primary / subagent）
DELETE /session/:id/agents/:name          删除 Agent

# Session 对话（= 团队协作）
POST   /session/:id/message               发送消息（指定 agent 执行）
POST   /session/:id/prompt_async          异步发送消息
GET    /session/:id/message               获取消息历史
POST   /session/:id/abort                 中断执行

# Session 资源（= 项目资产）
POST   /session/:id/skills/create         创建 Skill
POST   /session/:id/mcps/create           创建 MCP
POST   /session/:id/agents-md/create      创建 AGENTS.md
GET    /session/:id/children              获取 Fork 子会话
```

## 运行方式

```bash
source ../test-env.sh 3
source ../test-lib.sh

# 按顺序执行
bash 01-create-team.md
bash 02-agent-roles.md
bash 03-agent-dispatch.md
bash 04-team-collab.md
bash 05-cloud-local.md
bash 06-context-persistence.md
bash 07-cleanup.md
```

## 前置条件

- SaaS 服务运行在 `http://localhost:14096`
- PG 可连接（`$PG_URL`）
- 至少一个可用 provider（默认 `zhipuai` / `glm-5.1`）
- 依赖 `../test-env.sh` 和 `../test-lib.sh`
