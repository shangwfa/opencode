# SaaS Task 技术实现方案

## 1. 文档状态

- 状态：设计草案
- 范围：OpenCode SaaS 服务中的 Task 控制面
- 代码范围：`packages/opencode`
- 前置依赖：SaaS Project（`saas-project`）、ProjectSecret、Session
- 参考实现：[`docs/project-v1-technical-design.md`](../project-v1-technical-design.md)

## 2. 背景与定位

Project 是代码开发场景的配置容器（必须绑定 Git 仓库）。Task 是更通用的任务容器：

- **不要求 Git 仓库**：飞书文档同步、客服问题处理、定时巡检等非代码场景
- **可关联 0~N 个 Project**：关联后复用 Project 的六类资源（Agent/Skill/MCP/AGENTS.md/Command/Tool）
- **自身可配六类资源**：与 Project 平行，同名覆盖关联 Project 的资源
- **底层由 opencode Session 执行**：创建 Session 传 `taskId` 时自动注入资源

| | Project | Task |
|---|---|---|
| Git 仓库 | 必须绑定并验证 | 无 |
| status | active / archived | 无 status 字段，DELETE 即删除 |
| 关联 Project | — | `project_ids` jsonb 数组，0~N 个 |
| 六类资源 | 独立表（`agent`/`skill`/`mcp`/...） | 复用 Project 的表，加 `task_id` 列 |
| Session 注入 | 创建时传 projectId | 创建时传 taskId（注入关联 Project + Task 自身资源） |
| 归档 | 软归档（status=archived） | 无（DELETE 即删除含子资源） |

## 3. 目标

Task V1 必须支持：

1. 显式创建、查询、更新、删除 Task；
2. Task 可关联 0~N 个 Project（`project_ids` 数组）；
3. Task 自身可管理六类资源（Agent/Skill/MCP/AGENTS.md/Command/Tool）；
4. MCP Secret 加密存储，复用 ProjectSecret；
5. 创建 Session 传 `taskId` 时，Task 自身资源；
6. 按 `taskId` 查询所有关联 Session（执行历史）；
7. 不破坏现有 Project 和 Session 链路。

## 4. 非目标

Task V1 不负责：

- 定时触发（后续版本）；
- Webhook 驱动（后续版本）；
- 子任务 / 任务依赖（后续版本）；
- Task 级 run 接口（通过 `POST /session { taskId }` 执行）；
- 多租户 / RBAC（上层服务管理）。

## 5. 核心设计决策

### 5.1 Task 是显式业务实体

```text
task_<ascending-id>
```

ID 由服务生成，与 Project 无关。Task 可以随时关联或取消关联 Project。

### 5.2 复用 Project 资源表，加 `task_id` 列

不新建 6 张资源表。在现有 `agent`/`skill`/`mcp`/`project_agents_md`/`project_command`/`project_tool` 六张表上各加 `task_id` 列：

| 场景 | `project_id` | `task_id` |
|---|---|---|
| Project 资源 | `prj_xxx` | NULL |
| Task 资源 | NULL | `task_xxx` |

一条资源**要么属于 Project，要么属于 Task**，不能同时属于两者（Service 层校验）。

唯一索引：每张表已有 `(project_id, name)` 唯一索引，新增 `(task_id, name)` 唯一索引（`WHERE task_id IS NOT NULL`）。

### 5.3 `project_ids` 用 jsonb 数组

不用关联表，直接在 `saas_task` 表存 `project_ids jsonb NOT NULL DEFAULT '[]'`。更新时整体替换。

### 5.4 无 status，DELETE 即删除

Task 没有 `status` 字段。`DELETE /saas/task/:taskID` 直接删除 Task 主记录 + 全部子资源（purge），不做软归档。

### 5.5 复用 ProjectSecret

MCP Secret 加密复用 `ProjectSecret.Service`（AES-256-GCM），AAD 前缀改为 `task:`。

### 5.6 资源 Schema 复用

Agent/Skill/MCP/Command/Tool 的 Input/Info Schema 直接 re-export SaasProject 的定义，仅 `projectID` 字段替换为 `taskID`。

## 6. 数据库设计

### 6.1 新增表

```sql
CREATE TABLE IF NOT EXISTS saas_task (
  id            text PRIMARY KEY,
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  project_ids   jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  time_created  bigint NOT NULL,
  time_updated  bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS saas_task_time_idx ON saas_task (time_created);
```

### 6.2 复用资源表加列

```sql
ALTER TABLE agent              ADD COLUMN IF NOT EXISTS task_id text;
ALTER TABLE skill              ADD COLUMN IF NOT EXISTS task_id text;
ALTER TABLE mcp                ADD COLUMN IF NOT EXISTS task_id text;
ALTER TABLE project_agents_md  ADD COLUMN IF NOT EXISTS task_id text;
ALTER TABLE project_command    ADD COLUMN IF NOT EXISTS task_id text;
ALTER TABLE project_tool       ADD COLUMN IF NOT EXISTS task_id text;

CREATE UNIQUE INDEX IF NOT EXISTS agent_task_name_idx
  ON agent (task_id, name) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS skill_task_name_idx
  ON skill (task_id, name) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mcp_task_name_idx
  ON mcp (task_id, name) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agents_md_task_idx
  ON project_agents_md (task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS command_task_name_idx
  ON project_command (task_id, name) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tool_task_name_idx
  ON project_tool (task_id, name) WHERE task_id IS NOT NULL;
```

### 6.3 Session 表加 `task_id` 列

```sql
ALTER TABLE session ADD COLUMN IF NOT EXISTS task_id text;
CREATE INDEX IF NOT EXISTS session_task_idx ON session (task_id);
```

### 6.4 Drizzle Schema 同步

`packages/opencode/src/saas-project/project.pg.ts`：六张资源表各加 `task_id: text()` 列。

`packages/opencode/src/session/session.pg.ts`：SessionTable 加 `task_id: text()`。

`packages/core/src/session/sql.ts`：SessionTable（SQLite 版）加 `task_id: text()`。

### 6.5 无外键

所有表不创建外键约束。Service 层负责存在性校验和显式 purge。

### 6.6 purge

```sql
BEGIN;
  DELETE FROM task_tool        WHERE task_id = ${id};
  DELETE FROM project_command  WHERE task_id = ${id};
  DELETE FROM project_agents_md WHERE task_id = ${id};
  DELETE FROM mcp              WHERE task_id = ${id};
  DELETE FROM skill            WHERE task_id = ${id};
  DELETE FROM agent            WHERE task_id = ${id};
  DELETE FROM saas_task        WHERE id = ${id};
COMMIT;
```

cleanupOrphans 同理覆盖全部 7 张表。

## 7. Service 层设计

### 7.1 文件结构

```
src/saas-task/
├── index.ts          SaasTask Service（CRUD + 资源管理 + purge）
└── task.pg.ts         Task 主表 Drizzle 定义
```

不新建 `secret.ts`（复用 `@/saas-project/secret`）。
不新建 `git.ts`（无 Git 验证）。

### 7.2 Schema 定义（`index.ts`）

```ts
export * as SaasTask from "."

import { Context, Effect, Layer, Schema } from "effect"
import { SaasProject } from "@/saas-project"
import { ProjectSecret } from "@/saas-project/secret"
import { Identifier } from "@/id/id"
import { Database } from "@/storage/db"

export const ID = Schema.String.check(
  Schema.isPattern(/^task_[0-9A-Za-z]+$/),
).pipe(Schema.brand("SaasTask.ID"))

export const ResourceName = SaasProject.ResourceName  // 复用

// Task 主表 Schema
export const Info = Schema.Struct({
  id: ID,
  title: Schema.String,
  description: Schema.String,
  projectIds: Schema.Array(SaasProject.ID),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
})

export const CreateInput = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  projectIds: Schema.optional(Schema.Array(SaasProject.ID)),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const UpdateInput = Schema.Struct({
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  projectIds: Schema.optional(Schema.Array(SaasProject.ID)),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

// 六类资源 Schema：复用 SaasProject 的 Input 定义
// AgentInput / SkillInput / McpInput / CommandInput / ToolInput 直接 re-export
export { SaasProject as _S }  // 内部引用
export const AgentInput = SaasProject.AgentInput
export const SkillInput = SaasProject.SkillInput
export const McpInput = SaasProject.McpInput
export const CommandInput = SaasProject.CommandInput
export const ToolInput = SaasProject.ToolInput

// 资源 Info：projectID → taskID
export const AgentInfo = Schema.Struct({
  ...Schema.Struct.omit(SaasProject.AgentInfo.fields, ["projectID"]).fields,
  taskID: ID,
  name: ResourceName,
})
// skill / mcp / command / tool 同理

// 错误
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "SaasTask.NotFound", { taskID: ID },
) {}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()(
  "SaasTask.StorageError", { message: Schema.String },
) {}
```

### 7.3 Interface

```ts
export interface Interface {
  // Task CRUD
  readonly create: (input: CreateInput) => Effect.Effect<Info, StorageError>
  readonly list: () => Effect.Effect<Info[], StorageError>
  readonly get: (taskID: ID) => Effect.Effect<Info, NotFoundError | StorageError>
  readonly update: (taskID: ID, input: UpdateInput) => Effect.Effect<Info, NotFoundError | StorageError>
  readonly remove: (taskID: ID) => Effect.Effect<void, NotFoundError | StorageError>
  readonly purge: (taskID: ID) => Effect.Effect<void, NotFoundError | StorageError>
  readonly cleanupOrphans: () => Effect.Effect<number, StorageError>

  // 六类资源 CRUD（与 SaasProject 平行，WHERE task_id = ${id}）
  readonly listAgents: (taskID: ID) => Effect.Effect<AgentInfo[], NotFoundError | StorageError>
  readonly upsertAgent: (taskID: ID, name: string, input: AgentInput) => Effect.Effect<AgentInfo, NotFoundError | StorageError>
  readonly removeAgent: (taskID: ID, name: string) => Effect.Effect<void, NotFoundError | StorageError>
  // skill / mcp / agents-md / command / tool 同理

  // MCP Secret（复用 ProjectSecret）
  readonly listMcpsWithSecrets: (taskID: ID) => Effect.Effect<
    Array<{ info: McpInfo; environment: Record<string, string>; headers: Record<string, string> }>,
    NotFoundError | ProjectSecret.SecretError | StorageError
  >
}
```

### 7.4 Service 实现

与 SaasProject.Service 实现几乎完全一致，关键差异：

| SaasProject | SaasTask |
|---|---|
| `requireWritableProject`（检查 status=active） | `requireTask`（仅检查存在，无 status） |
| `WHERE project_id = ${id}` | `WHERE task_id = ${id}` |
| `ON CONFLICT (project_id, name)` | `ON CONFLICT (task_id, name)` |
| Git 验证 + repository_credential | 无 |
| `archive`（软归档） | 无（`remove` = `purge`） |
| AAD `project:${id}:mcp:${resourceId}` | AAD `task:${id}:mcp:${resourceId}` |

### 7.5 Layer

```ts
export const live = layer.pipe(Layer.provide([ProjectSecret.live]))
// 不需要 ProjectGit.live
```

## 8. HTTP API 设计

### 8.1 端点列表

```
# Task CRUD
POST   /saas/task                         创建 Task
GET    /saas/task                         列表
GET    /saas/task/:taskID                 详情
PATCH  /saas/task/:taskID                 更新（含 projectIds 替换）
DELETE /saas/task/:taskID                 删除（含 purge 子资源）

# 六类资源（与 Project 平行，路径前缀 /saas/task/:taskID）
GET    /saas/task/:taskID/agents          列表
PUT    /saas/task/:taskID/agents/:name    upsert
DELETE /saas/task/:taskID/agents/:name    删除
# skill / mcp / agents-md / command / tool 同理

# Session 关联
GET    /saas/task/:taskID/sessions        该 Task 的执行历史
```

### 8.2 API 定义（`groups/saas-task.ts`）

```ts
const root = "/saas/task"
const errors = [HttpApiError.BadRequest, HttpApiError.NotFound, HttpApiError.ServiceUnavailable] as const

export const SaasTaskApi = HttpApi.make("saas-task").add(
  HttpApiGroup.make("saasTask")
    .add(
      HttpApiEndpoint.post("create", root, {
        payload: SaasTask.CreateInput,
        success: described(SaasTask.Info, "Created SaaS task"),
        error: errors,
      }),
      HttpApiEndpoint.get("list", root, { ... }),
      HttpApiEndpoint.get("get", `${root}/:taskID`, { ... }),
      HttpApiEndpoint.patch("update", `${root}/:taskID`, { ... }),
      HttpApiEndpoint.delete("remove", `${root}/:taskID`, { ... }),
      // agents / skills / mcps / agents-md / commands / tools（与 saas-project 完全平行）
      // sessions
      HttpApiEndpoint.get("listSessions", `${root}/:taskID/sessions`, {
        params: { taskID: SaasTask.ID },
        success: described(Schema.Array(Session.Info), "Task sessions"),
        error: errors,
      }),
    )
    .annotateMerge(OpenApi.annotations({ title: "SaaS Task", description: "SaaS task control plane." })),
)
```

### 8.3 Handler（`handlers/saas-task.ts`）

```ts
export const saasTaskHandlers = HttpApiBuilder.group(SaasTaskRootApi, "saasTask", (handlers) =>
  Effect.gen(function* () {
    const task = yield* SaasTask.Service
    const session = yield* Session.Service  // listSessions 端点用

    return handlers
      .handle("create", (ctx) => transport(task.create(ctx.payload)))
      .handle("list", () => transport(task.list()))
      .handle("get", (ctx) => transport(task.get(ctx.params.taskID)))
      .handle("update", (ctx) => transport(task.update(ctx.params.taskID, ctx.payload)))
      .handle("remove", (ctx) => transport(task.remove(ctx.params.taskID)))
      .handle("listAgents", (ctx) => transport(task.listAgents(ctx.params.taskID)))
      .handle("upsertAgent", (ctx) => transport(task.upsertAgent(ctx.params.taskID, ctx.params.name, ctx.payload)))
      // ...
      .handle("listSessions", (ctx) => transport(session.listByTaskId(ctx.params.taskID)))
  }),
)
```

错误映射与 SaasProject handler 一致：

```ts
function apiError(error: { readonly _tag: string }) {
  if (error._tag === "SaasTask.NotFound") return new HttpApiError.NotFound({})
  if (error._tag === "SaasTask.StorageError" || error._tag === "ProjectSecret.Error")
    return new HttpApiError.ServiceUnavailable({})
  return new HttpApiError.BadRequest({})
}
```

### 8.4 server.ts 装配

```ts
// api.ts 加 SaasTaskRootApi
export { SaasTaskApi as SaasTaskRootApi } from "./groups/saas-task"

// server.ts
import { SaasTask } from "@/saas-task"
import { saasTaskHandlers } from "./handlers/saas-task"

const saasTaskApiRoutes = HttpApiBuilder.layer(SaasTaskRootApi).pipe(
  Layer.provide(saasTaskHandlers),
  Layer.provide(SaasTask.live),
  Layer.provide(SaasProject.live),  // ProjectSecret 依赖
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)

// createRoutes 的 Layer.mergeAll 加 saasTaskApiRoutes
```

## 9. Session 注入设计

### 9.1 CreateInput 扩展

```ts
// session.ts
export const CreateInput = Schema.optional(
  Schema.Struct({
    ...
    projectId: Schema.optional(Schema.String),   // 已有
    taskId: Schema.optional(Schema.String),       // 新增
  }),
)
```

### 9.2 SessionInfo 加 taskID

```ts
// packages/schema/src/v1/session.ts SessionInfo 加
taskID: optional(Schema.String),
```

### 9.3 Session 表加 task_id

- `packages/core/src/session/sql.ts`：`task_id: text()`
- `packages/opencode/src/session/session.pg.ts`：`task_id: text()`
- `packages/core/src/session/projector.ts`：`sessionRow` 加 `task_id: info.taskID`
- `packages/opencode/src/session/session.ts`：`Info` 加 `taskID`，`fromRow`/`toRow` 处理

### 9.4 注入顺序

Session 创建时传 `taskId`，按以下顺序注入：

```
1. 遍历 Task 关联的所有 projectIds → 注入每个 Project 的六类资源
2. 注入 Task 自身的六类资源（同名覆盖 Project 的）
3. Session 行记录 task_id
```

同名资源覆盖语义：Task 资源后写入，upsert 覆盖先写入的 Project 资源。这是自然的覆盖语义，无需额外冲突处理。

### 9.5 注入函数

```ts
// session.ts create 方法
const create = Effect.fn("Session.create")(function* (input) {
  return yield* createNext({
    ...
    saasProjectID: input?.projectId,
    taskID: input?.taskId,
  }).pipe(
    // 已有：Project 资源注入（当直接传 projectId 时）
    Effect.tap((result) => injectProjectAgents(result.id, input?.projectId)),
    Effect.tap((result) => injectProjectSkills(result.id, input?.projectId)),
    Effect.tap((result) => injectProjectMcps(result.id, input?.projectId)),
    Effect.tap((result) => injectProjectAgentsMd(result.id, input?.projectId)),
    Effect.tap((result) => injectProjectCommands(result.id, input?.projectId)),
    Effect.tap((result) => injectProjectTools(result.id, input?.projectId)),
    // 新增：Task 关联 Project 资源注入
    Effect.tap((result) => injectTaskProjectResources(result.id, input?.taskId)),
    // 新增：Task 自身资源注入
    Effect.tap((result) => injectTaskAgents(result.id, input?.taskId)),
    Effect.tap((result) => injectTaskSkills(result.id, input?.taskId)),
    Effect.tap((result) => injectTaskMcps(result.id, input?.taskId)),
    Effect.tap((result) => injectTaskAgentsMd(result.id, input?.taskId)),
    Effect.tap((result) => injectTaskCommands(result.id, input?.taskId)),
    Effect.tap((result) => injectTaskTools(result.id, input?.taskId)),
  )
})
```

### 9.6 injectTaskProjectResources

```ts
const injectTaskProjectResources = Effect.fn("Session.injectTaskProjectResources")(function* (
  sessionID: SessionID,
  taskId?: string,
) {
  if (!taskId) return
  const taskService = Option.getOrUndefined(yield* Effect.serviceOption(SaasTask.Service))
  if (!taskService) return
  const exit = yield* Effect.exit(taskService.get(SaasTask.ID.make(taskId)))
  if (Exit.isFailure(exit)) return
  const projectIds = exit.value.projectIds ?? []
  for (const projectId of projectIds) {
    yield* injectProjectAgents(sessionID, projectId)
    yield* injectProjectSkills(sessionID, projectId)
    yield* injectProjectMcps(sessionID, projectId)
    yield* injectProjectAgentsMd(sessionID, projectId)
    yield* injectProjectCommands(sessionID, projectId)
    yield* injectProjectTools(sessionID, projectId)
  }
})
```

### 9.7 injectTaskAgents（及其他 Task 资源注入）

与 `injectProjectAgents` 逻辑完全一致，区别：
- 调用 `taskService.listAgents(SaasTask.ID.make(taskId))` 而非 `projectService.listAgents`
- 其余不变（注册到 Session 的逻辑相同）

### 9.8 Session.listByTaskId

```ts
const listByTaskId = Effect.fn("Session.listByTaskId")(function* (taskID: string) {
  const rows = yield* db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.task_id, taskID))
    .orderBy(desc(SessionTable.time_updated))
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRow)
})
```

Interface 加 `listByTaskId: (taskID: string) => Effect.Effect<Info[]>`。

## 10. 文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/saas-task/index.ts` | 新增 | SaasTask Service（CRUD + 资源 + purge） |
| `src/saas-task/task.pg.ts` | 新增 | `saas_task` 表 Drizzle 定义 |
| `src/saas-project/project.pg.ts` | 修改 | 6 张资源表各加 `task_id` 列 |
| `src/storage/schema-pg.ts` | 修改 | 导出 `SaasTaskTable` |
| `migration-pg/2026xxxx_saas_task/migration.sql` | 新增 | Task 主表 + 6 列 ALTER + 索引 |
| `migration-pg/2026xxxx_session_task_id/migration.sql` | 新增 | session 表加 task_id 列 |
| `src/server/routes/instance/httpapi/groups/saas-task.ts` | 新增 | API 端点定义 |
| `src/server/routes/instance/httpapi/handlers/saas-task.ts` | 新增 | Handler |
| `src/server/routes/instance/httpapi/api.ts` | 修改 | 加 `SaasTaskRootApi` |
| `src/server/routes/instance/httpapi/server.ts` | 修改 | 装配 `SaasTask.live` + `saasTaskHandlers` |
| `src/session/session.ts` | 修改 | CreateInput 加 `taskId` + 7 个 inject 函数 + `listByTaskId` |
| `src/session/session.pg.ts` | 修改 | SessionTable 加 `task_id` 列 |
| `packages/schema/src/v1/session.ts` | 修改 | SessionInfo 加 `taskID` |
| `packages/core/src/session/sql.ts` | 修改 | SessionTable 加 `task_id` 列 |
| `packages/core/src/session/projector.ts` | 修改 | sessionRow 写 `task_id` |

## 11. 与 SaasProject 的复用关系

| 组件 | 复用方式 |
|---|---|
| `ProjectSecret.Service` | 直接复用（AAD 改 `task:` 前缀） |
| `AgentInput`/`SkillInput`/`McpInput`/`CommandInput`/`ToolInput` | re-export SaasProject 的定义 |
| `PermissionRule` / `SkillResource` | re-export |
| `injectProjectAgents` 等 | 直接复用（遍历 projectIds 时调用） |
| `Session.fromRow`/`toRow` | 加 `taskID` 字段 |
| HTTP error mapping | 同模式的 `apiError` 函数 |

## 12. 测试方案

### 12.1 Task CRUD

- 创建 Task（无 projectIds）
- 创建 Task（关联 1 个 Project）
- 创建 Task（关联多个 Project）
- 列表 / 详情 / 更新（title / description / projectIds / metadata）
- 删除（含子资源 purge）
- 不存在 Task 返回 404

### 12.2 Task 资源 CRUD

- 六类资源的创建 / 列表 / upsert 同名覆盖 / 删除
- MCP Secret 加密 / 脱敏 / 更新保留
- 跨 Task 同名资源隔离
- 跨 Task-Project 同名资源隔离（同一张表，project_id vs task_id）

### 12.3 Session 注入

- 创建 Session 传 taskId，验证六类资源注入
- Task 关联 Project 时，验证 Project 资源 + Task 资源都注入
- 同名资源：Task 覆盖 Project
- 无 taskId 的 Session 不关联
- `GET /saas/task/:taskID/sessions` 返回正确列表
- PG 持久化：session.task_id、session 级资源表

### 12.4 purge

- 删除 Task 后 7 张表（saas_task + 6 资源表）全部清零
- cleanupOrphans 覆盖全部 7 张表

## 13. 错误与 HTTP 状态

| 领域错误 | HTTP |
|---|---:|
| TaskNotFound | 404 |
| ParseError / InvalidInput | 400 |
| SecretError / StorageError | 503 |
