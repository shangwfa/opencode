# SaaS Scheduler 技术实现方案

## 1. 文档状态

- 状态：设计草案
- 范围：OpenCode SaaS 服务中的通用定时调度系统
- 代码范围：`packages/opencode`
- 前置依赖：SaaS Task、Session、croner
- 参考实现：[`docs/test-cases/saas-task/technical-design.md`](../saas-task/technical-design.md)
- 测试用例：[`scheduler.md`](./scheduler.md)

## 2. 背景与定位

SaaS Task 需要定时触发执行（如飞书文档同步、客服巡检、定时报告）。调度系统需要独立于具体任务类型，未来 Webhook、Pipeline 等也可复用同一调度器。

**核心原则**：调度系统不耦合 Task。Schedule 是独立资源，通过 `owner_type + owner_id` 关联任意类型的被调度对象。

## 3. 目标

1. 独立 `schedule` 表，通用调度配置；
2. 独立 `Scheduler` Service，通过 `register(ownerType, handler)` 注册执行器；
3. Task 注册 handler 后，定时触发创建 Session 执行任务；
4. 后台 fiber 定时扫描 `schedule` 表，扫描到期的 schedule 并分发到 handler；
5. 未来其他类型（webhook、pipeline 等）只需注册 handler，无需改动调度器；
6. Task 表零改动。

## 4. 非目标

- 分布式锁（多实例部署后续加 PG advisory lock）；
- 任务队列 / 优先级调度；
- 失败重试机制（第一版记录失败，不自动重试）；
- 复杂依赖编排（子任务、DAG）。

## 5. 核心设计

### 5.1 独立 Schedule 表

```sql
CREATE TABLE schedule (
  id            text PRIMARY KEY,           -- sch_ 前缀
  owner_type    text NOT NULL,              -- 'task' | 'webhook' | 'pipeline' | ...
  owner_id      text NOT NULL,              -- task_xxx / wh_xxx / ...
  cron          text NOT NULL,              -- "0 9 * * 1-5"
  enabled       boolean NOT NULL DEFAULT true,
  payload       jsonb NOT NULL DEFAULT '{}', -- 执行附加参数
  last_run_at   bigint,                     -- 上次执行时间
  next_run_at   bigint,                     -- 下次预计执行时间
  run_count     integer NOT NULL DEFAULT 0,
  last_error    text,                       -- 上次失败原因
  time_created  bigint NOT NULL,
  time_updated  bigint NOT NULL
);

CREATE INDEX schedule_next_run_idx ON schedule (next_run_at) WHERE enabled = true;
CREATE INDEX schedule_owner_idx ON schedule (owner_type, owner_id);
```

- **无外键**：遵循阿里建表规范，Service 层校验。
- **`payload` jsonb**：存执行附加参数（如 model 覆盖、自定义 prompt），默认 `{}`。
- **`next_run_at`**：创建/更新时用 croner 算出，调度器扫描用。
- **`last_error`**：上次执行失败原因，成功后清空。

### 5.2 Scheduler Service

```ts
type ScheduleHandler = (ownerId: string, payload: unknown) => Effect<void>

interface Scheduler.Interface {
  // 注册执行器
  register(ownerType: string, handler: ScheduleHandler): void

  // Schedule CRUD
  create(input: CreateInput): Effect<ScheduleInfo>
  update(id: ID, input: UpdateInput): Effect<ScheduleInfo>
  remove(id: ID): Effect<void>
  get(id: ID): Effect<ScheduleInfo>
  list(ownerType: string, ownerId: string): Effect<ScheduleInfo[]>

  // 调度器
  tick(): Effect<void>  // 扫描到期 schedule，分发到 handler
}
```

### 5.3 执行流程

```
Scheduler.tick()（每 30 秒）
  → SELECT * FROM schedule WHERE enabled = true AND next_run_at <= now
  → for each schedule:
      → 查找 handler[owner_type]
      → 若无 handler：记录 last_error，跳过
      → handler(owner_id, payload)
        → 成功：UPDATE last_run_at=now, next_run_at=新值, run_count++, last_error=NULL
        → 失败：UPDATE last_run_at=now, next_run_at=新值, run_count++, last_error=错误信息
```

**并发控制**：调度器单 fiber 顺序执行，同一 schedule 不会并发触发。不同 schedule 之间也不并发（第一版简单可靠）。

### 5.4 Task Handler 注册

```ts
// app layer 启动时
scheduler.register("task", (taskId, payload) =>
  Effect.gen(function* () {
    const taskService = yield* SaasTask.Service
    const sessionService = yield* Session.Service

    // 1. 获取 Task
    const task = yield* taskService.get(SaasTask.ID.make(taskId))

    // 2. 创建 Session（传 taskId，自动注入资源）
    const session = yield* sessionService.create({
      taskId,
      title: `Scheduled: ${task.title}`,
    })

    // 3. 发送任务描述作为首条消息
    const p = payload as { prompt?: string; model?: { providerID: string; modelID: string } }
    yield* sessionService.prompt({
      sessionID: session.id,
      parts: [{ type: "text", text: p.prompt ?? task.description }],
      ...(p.model ? { model: p.model } : {}),
    })
  })
)
```

### 5.5 调度器启动

在 app layer（`server.ts` 或 `app-runtime.ts`）启动时 fork 后台 fiber：

```ts
// 在 AppLayer 构建中 fork
Effect.gen(function* () {
  const scheduler = yield* Scheduler.Service
  yield* Effect.gen(function* () {
    yield* scheduler.tick()
  }).pipe(
    Effect.schedule(Schedule.spaced("30 seconds")),
    Effect.forever,
    Effect.forkScoped,
  )
})
```

### 5.6 cron 解析（croner）

只用 croner 的解析能力算 `next_run_at`，不用它的定时触发：

```ts
import { Cron } from "croner"

function nextRunFromCron(cron: string): number | null {
  try {
    const next = new Cron(cron).nextRun()
    return next ? next.getTime() : null
  } catch {
    return null
  }
}
```

创建/更新 schedule 时：
```ts
const next = nextRunFromCron(input.cron)
if (!next) return yield* new InvalidCronError({ cron: input.cron })
// 存入 schedule.next_run_at
```

执行后更新：
```ts
const next = nextRunFromCron(schedule.cron)
// UPDATE schedule SET next_run_at = next
```

### 5.7 Task 删除时清理 Schedule

Task `purge` 时删除关联的 schedule：

```ts
// SaasTask.purge
yield* storage(() => client()`DELETE FROM schedule WHERE owner_type = 'task' AND owner_id = ${id}`)
```

## 6. 数据模型

### 6.1 Schema 定义

```ts
export const ID = Schema.String.check(
  Schema.isPattern(/^sch_[0-9A-Za-z]+$/),
).pipe(Schema.brand("Scheduler.ID"))

export const OwnerType = Schema.Literals(["task"])  // 后续扩展

export const Info = Schema.Struct({
  id: ID,
  ownerType: Schema.String,
  ownerId: Schema.String,
  cron: Schema.String,
  enabled: Schema.Boolean,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  lastRunAt: Schema.optional(Schema.Number),
  nextRunAt: Schema.optional(Schema.Number),
  runCount: Schema.Number,
  lastError: Schema.optional(Schema.String),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
})

export const CreateInput = Schema.Struct({
  ownerType: Schema.String,
  ownerId: Schema.String,
  cron: Schema.String,
  payload: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const UpdateInput = Schema.Struct({
  cron: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  payload: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
```

### 6.2 错误定义

```ts
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "Scheduler.NotFound", { scheduleID: ID },
) {}

export class InvalidCronError extends Schema.TaggedErrorClass<InvalidCronError>()(
  "Scheduler.InvalidCron", { cron: Schema.String },
) {}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()(
  "Scheduler.StorageError", { message: Schema.String },
) {}
```

## 7. HTTP API

### 7.1 通用 Schedule API

```
POST   /saas/schedule                              创建
GET    /saas/schedule?ownerType=task&ownerId=xxx   列表（按 owner 过滤）
GET    /saas/schedule/:scheduleID                  详情
PATCH  /saas/schedule/:scheduleID                  更新（cron/enabled/payload）
DELETE /saas/schedule/:scheduleID                  删除
```

### 7.2 Task 便捷接口

```
POST   /saas/task/:taskID/schedule                 为 Task 创建定时
GET    /saas/task/:taskID/schedule                 查看 Task 的定时配置列表
DELETE /saas/task/:taskID/schedule/:scheduleID     删除 Task 的某个定时
```

Task 便捷接口是对通用 API 的封装：
- `POST /saas/task/:taskID/schedule` 内部调用 `scheduler.create({ ownerType: "task", ownerId: taskID, ... })`
- `GET /saas/task/:taskID/schedule` 内部调用 `scheduler.list("task", taskID)`

### 7.3 API 定义

```ts
const root = "/saas/schedule"
const taskRoot = "/saas/task"

// 通用 Schedule API
HttpApiEndpoint.post("create", root, { ... })
HttpApiEndpoint.get("list", root, {
  query: Schema.Struct({
    ownerType: Schema.String,
    ownerId: Schema.String,
  }),
  ...
})
HttpApiEndpoint.get("get", `${root}/:scheduleID`, { ... })
HttpApiEndpoint.patch("update", `${root}/:scheduleID`, { ... })
HttpApiEndpoint.delete("remove", `${root}/:scheduleID`, { ... })

// Task 便捷接口
HttpApiEndpoint.post("createTaskSchedule", `${taskRoot}/:taskID/schedule`, {
  params: { taskID: SaasTask.ID },
  payload: Schema.Struct({
    cron: Schema.String,
    payload: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  success: described(Scheduler.Info, "Task schedule"),
  ...
})
HttpApiEndpoint.get("listTaskSchedules", `${taskRoot}/:taskID/schedule`, {
  params: { taskID: SaasTask.ID },
  success: described(Schema.Array(Scheduler.Info), "Task schedules"),
  ...
})
HttpApiEndpoint.delete("removeTaskSchedule", `${taskRoot}/:taskID/schedule/:scheduleID`, {
  params: { taskID: SaasTask.ID, scheduleID: Scheduler.ID },
  success: Schema.Void,
  ...
})
```

### 7.4 Handler

```ts
export const schedulerHandlers = HttpApiBuilder.group(SchedulerRootApi, "scheduler", (handlers) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Service

    return handlers
      // 通用 API
      .handle("create", (ctx) => transport(scheduler.create(ctx.payload)))
      .handle("list", (ctx) => transport(scheduler.list(ctx.query.ownerType, ctx.query.ownerId)))
      .handle("get", (ctx) => transport(scheduler.get(ctx.params.scheduleID)))
      .handle("update", (ctx) => transport(scheduler.update(ctx.params.scheduleID, ctx.payload)))
      .handle("remove", (ctx) => transport(scheduler.remove(ctx.params.scheduleID)))
      // Task 便捷接口
      .handle("createTaskSchedule", (ctx) =>
        transport(scheduler.create({
          ownerType: "task",
          ownerId: ctx.params.taskID,
          cron: ctx.payload.cron,
          payload: ctx.payload.payload,
        })),
      )
      .handle("listTaskSchedules", (ctx) =>
        transport(scheduler.list("task", ctx.params.taskID)),
      )
      .handle("removeTaskSchedule", (ctx) =>
        transport(scheduler.remove(ctx.params.scheduleID)),
      )
  }),
)
```

### 7.5 server.ts 装配

```ts
import { Scheduler } from "@/scheduler"
import { schedulerHandlers } from "./handlers/scheduler"

const schedulerApiRoutes = HttpApiBuilder.layer(SchedulerRootApi).pipe(
  Layer.provide(schedulerHandlers),
  Layer.provide(Scheduler.live),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)

// createRoutes 的 Layer.mergeAll 加 schedulerApiRoutes
```

### 7.6 调度器 fiber 启动

在 `app-runtime.ts` 的 AppLayer 构建中 fork：

```ts
// AppNodeBuilderV1.build 后追加
Layer.provideMerge(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      yield* Effect.gen(function* () {
        yield* scheduler.tick()
      }).pipe(
        Effect.schedule(Effect.scheduleSpaced("30 seconds")),
        Effect.forever,
        Effect.forkScoped,
      )
    }),
  ),
)
```

## 8. Task purge 清理 Schedule

SaasTask Service 的 `purge` 方法增加：

```ts
await tx`DELETE FROM schedule WHERE owner_type = 'task' AND owner_id = ${id}`
```

## 9. 文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/scheduler/index.ts` | 新增 | Scheduler Service（CRUD + tick + handler 注册） |
| `src/scheduler/schedule.pg.ts` | 新增 | `schedule` 表 Drizzle 定义 |
| `migration-pg/2026xxxx_saas_schedule/migration.sql` | 新增 | schedule 表创建 |
| `src/storage/schema-pg.ts` | 修改 | 导出 ScheduleTable |
| `src/server/routes/instance/httpapi/groups/scheduler.ts` | 新增 | API 端点定义 |
| `src/server/routes/instance/httpapi/handlers/scheduler.ts` | 新增 | Handler |
| `src/server/routes/instance/httpapi/api.ts` | 修改 | 加 SchedulerRootApi |
| `src/server/routes/instance/httpapi/server.ts` | 修改 | 装配 Scheduler.live + schedulerApiRoutes + fiber |
| `src/saas-task/index.ts` | 修改 | purge 增加 DELETE FROM schedule |
| `package.json` | 修改 | 加 croner 依赖 |

## 10. 依赖

```bash
cd packages/opencode
bun add croner
```

croner：零依赖 cron 解析库，支持 Bun/Node/Deno，内置 TypeScript 类型。

## 11. 测试方案

### 11.1 Schedule CRUD

- 创建 schedule（ownerType=task）
- 列表（按 owner 过滤）
- 详情 / 更新（cron/enabled/payload）/ 删除
- 不存在 schedule 返回 404
- 无效 cron 表达式返回 400

### 11.2 Task 便捷接口

- `POST /saas/task/:taskID/schedule` 创建定时
- `GET /saas/task/:taskID/schedule` 列表
- `DELETE /saas/task/:taskID/schedule/:scheduleID` 删除

### 11.3 调度器触发

- 创建 schedule（cron = 每 1 分钟）
- 等待 60 秒
- 验证 Session 被创建（`GET /saas/task/:taskID/sessions`）
- 验证 schedule.last_run_at / run_count 更新

### 11.4 禁用 / 启用

- 创建 schedule 后禁用
- 等待超过 next_run_at
- 验证未触发

### 11.5 Task purge 清理

- 为 Task 创建 schedule
- 删除 Task
- 验证 schedule 被清理

## 12. 错误与 HTTP 状态

| 领域错误 | HTTP |
|---|---:|
| ScheduleNotFound | 404 |
| InvalidCron | 400 |
| ParseError | 400 |
| StorageError | 503 |
