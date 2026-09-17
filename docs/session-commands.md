# Session Commands — 会话级自定义命令

## 概述

Session Commands 允许在指定 session 内动态创建、更新、删除自定义命令（commands），不影响其他 session。这是 `SessionAgent` / `SessionTool` 之后第三套 session overlay 机制，模式完全对称。

- **SQLite 模式（本地）**：`noopLayer`，数据存内存，不持久化（本地无 session commands）
- **PG 模式（SaaS）**：`pgLayer`，数据持久化到 `session_commands` 表，支持多 pod

合并优先级：session 级命令覆盖同名的 instance 级命令（内置 `init`/`review`、config 中的 `command.*`、MCP prompts、skills），session 级独有的命令追加到列表末尾。

## 文件清单

| 文件 | 说明 |
|------|------|
| `packages/opencode/src/command/session-command.pg.ts` | PG 表定义 |
| `packages/opencode/src/command/session-command.ts` | session overlay 服务（noopLayer / layer / pgLayer） |
| `packages/opencode/migration-pg/20260704120000_session_commands/migration.sql` | PG migration |
| `packages/opencode/src/storage/schema-pg.ts` | 导出 `SessionCommandTable` |
| `packages/opencode/src/command/index.ts` | `Command.Service` 增加 session overlay 合并方法 |
| `packages/opencode/src/session/prompt.ts` | 调用方改用 `sessionGet` / `sessionList` |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` | commands 端点定义 |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | command handlers |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | 挂载 `SessionCommand.layer` |
| `packages/opencode/test/command/session-command-crud.test.ts` | 内存层 CRUD 测试 |
| `packages/opencode/test/command/session-command-pg.test.ts` | PG 层集成测试 |

## 数据模型

### PG 表：`session_commands`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | text PK | `scmd_` 前缀 |
| `session_id` | text NOT NULL | FK → `session(id)` ON DELETE CASCADE |
| `name` | text NOT NULL | 命令名（如 `test`） |
| `description` | text | 可选描述 |
| `template` | text NOT NULL | 提示词模板（支持 `$1`/`$ARGUMENTS`/`!`cmd`/`@file`） |
| `agent` | text | 可选，指定执行代理 |
| `model` | text | 可选，覆盖默认模型 |
| `subtask` | boolean | 可选，强制子代理调用 |
| `hints` | jsonb NOT NULL DEFAULT `[]` | 占位符列表（如 `["$ARGUMENTS"]`） |
| `time_created` | bigint NOT NULL | |
| `time_updated` | bigint NOT NULL | |

约束：`UNIQUE(session_id, name)`。

### Row / Input 类型

```typescript
// Row（数据库行）
type Row = {
  id: string
  session_id: string
  name: string
  description?: string | null
  template: string
  agent?: string | null
  model?: string | null
  subtask?: boolean | null
  hints: string[]
  time_created: number
  time_updated: number
}

// Input（创建/更新参数）
type Input = {
  name: string
  description?: string
  template: string
  agent?: string
  model?: string
  subtask?: boolean
  hints?: readonly string[]  // 省略时由 template 自动推导
}
```

字段语义参见 [opencode commands 文档](https://opencode.ai/docs/commands/)。

## 服务层：`SessionCommand`

三套 Layer，与 `SessionAgent` / `SessionTool` 完全对称：

| Layer | 数据库 | 用途 |
|-------|--------|------|
| `noopLayer` | 无 | SQLite 模式，`list` 返回 `[]`，`upsert` 返回内存对象不持久化 |
| `layer` | SQLite (Drizzle) | Drizzle 查询（预留） |
| `pgLayer` | PostgreSQL | 原始 SQL，`ON CONFLICT DO UPDATE` 实现 upsert |

接口方法：`list(sessionID)` / `get(sessionID, name)` / `upsert(sessionID, input)` / `remove(sessionID, name)` / `removeAll(sessionID)`。

## Overlay 合并：`Command.Service`

`Command.Service`（`command/index.ts`）新增五个 session 方法，与 `Agent.sessionList` / `sessionGet` 对称：

| 方法 | 行为 |
|------|------|
| `sessionList(sessionID)` | 合并 instance 级命令 + session 级命令，session 覆盖同名，追加独有项 |
| `sessionGet(name, sessionID?)` | 优先返回 session 级命令，否则回退 instance 级 |
| `sessionCreate(sessionID, input)` | `upsert` 到 `session_commands`，`hints` 缺省时从 `template` 自动推导 |
| `sessionRemove(sessionID, name)` | 删除单个 session 命令 |
| `sessionClear(sessionID)` | 清空该 session 所有命令 |

**合并逻辑**（`sessionList`）：

```typescript
const overlay = new Map(rows.map((r) => [r.name, rowToInfo(r)]))
return base
  .map((c) => overlay.get(c.name) ?? c)               // session 覆盖同名 base
  .concat([...overlay.values()].filter((c) =>          // 追加 session 独有项
    !base.some((b) => b.name === c.name)))
```

**非 PG 模式**（`noopLayer` 或无 `OPENCODE_DATABASE_URL`）：`sessionList` 直接返回 instance 级列表，`sessionCreate` 抛错。

## 调用方：`SessionPrompt`

`session/prompt.ts` 的 `command()` 方法改用 session 版本：

```typescript
const cmd = yield* commands.sessionGet(input.command, input.sessionID)
if (!cmd) {
  const available = (yield* commands.sessionList(input.sessionID)).map((c) => c.name)
  // ...
}
```

instance handler（`instance.ts`）和 ACP（`directory.ts`）仍使用无 session 参数的 `list()` / `get()`，因为它们是 instance 级别。

## HTTP API

所有端点均在 `session` group 下，路径前缀 `/session/:sessionID`。

| 方法 | 路径 | 名称 | 说明 |
|------|------|------|------|
| GET | `/session/:sessionID/commands` | `commands` | 列出合并后的命令（session + instance） |
| POST | `/session/:sessionID/commands/create` | `commandsCreate` | 创建/更新 session 命令 |
| DELETE | `/session/:sessionID/commands/:name` | `commandsDelete` | 删除单个 session 命令 |
| DELETE | `/session/:sessionID/commands` | `commandsClear` | 清空 session 所有命令 |

### 创建 payload

```jsonc
{
  "name": "test",                       // 必需
  "template": "Run tests for $ARGUMENTS", // 必需
  "description": "Run tests",           // 可选
  "agent": "build",                     // 可选
  "model": "anthropic/claude-3-5-sonnet", // 可选
  "subtask": false,                     // 可选
  "hints": ["$ARGUMENTS"]               // 可选，缺省时自动推导
}
```

## 测试

```bash
cd packages/opencode

# 内存层 CRUD（12 用例）
bun test test/command/session-command-crud.test.ts

# PG 层集成（需 OPENCODE_DATABASE_URL）
OPENCODE_DATABASE_URL=postgres://... bun test test/command/session-command-pg.test.ts
```

## 与同类机制对比

| 维度 | `SessionAgent` | `SessionTool` | **`SessionCommand`** |
|------|----------------|---------------|----------------------|
| 文件 | `agent/session-agent.ts` | `tool/session-tool.ts` | `command/session-command.ts` |
| PG 表 | `session_agents` | `session_tools` | `session_commands` |
| ID 前缀 | `sag_` | `stl_` | `scmd_` |
| overlay 合并点 | `agent.ts` sessionList/sessionGet | `registry.ts` tools() | `command/index.ts` sessionList/sessionGet |
| 合并语义 | session 覆盖 base，保留 native/hidden | session 覆盖 base | session 覆盖 base |
