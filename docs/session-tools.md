# SessionTool — 会话级自定义工具

## 1. 概述

### 背景

代码库中已有三套成熟的 session overlay 机制，模式完全一致：

| 资源类型 | session overlay 服务 | PG 表 | 迁移 |
|----------|---------------------|-------|------|
| Agent | `src/agent/session-agent.ts` (`SessionAgent`) | `agent.pg.ts` → `session_agents` | `20260521120000_session_agents` |
| Skill | `src/skill/session-skill.ts` (`SessionSkill`) | `skill.pg.ts` → `session_skill` | `20260517120000_session_skill` |
| MCP | `src/mcp/session-mcp.ts` (`SessionMcp`) | `session-mcp.pg.ts` → `session_mcps` | `20260604135000_session_mcp` |

每种机制允许在特定 session 中动态添加/覆盖/删除配置（agent prompt、skill 内容、MCP server），不修改全局状态。PG 模式下持久化到数据库表，支持多 pod；SQLite/单机模式下 `noopLayer` 数据不持久化。

### 目标

新建 **`SessionTool`**，允许在特定 session 中动态注册**自定义工具**。工具以 JS/TS 源码形式存储在数据库中，运行时动态加载并复用 opencode 已有的工具执行管道（`fromPlugin` 包装逻辑），与磁盘工具、插件工具完全等价。

### 设计语义

| 字段 | 说明 |
|------|------|
| `name` | 工具唯一标识（同 session 内唯一），即 LLM 看到的 tool ID |
| `description` | 工具描述（LLM 用于判断何时调用） |
| `code` | JS/TS 模块源码，导出符合 `ToolDefinition`（`@opencode-ai/plugin`）的对象 |

`code` 中导出的模块格式与磁盘工具（`tool/*.ts`）、插件工具完全一致：

```typescript
// code 字段内容示例
import { z } from "zod"

export default {
  description: "Add two numbers",
  args: {
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
  },
  async execute(args, ctx) {
    return { title: "Add", output: `${args.a} + ${args.b} = ${args.a + args.b}` }
  },
}
```

> **注**：`code` 在运行时通过临时文件 + `import()` 加载，Bun 自动编译 TS。加载后删除临时文件（模块已缓存在内存中）。对 code 内容做 Map 缓存避免重复编译。

---

## 2. 命名避坑（关键）

`SessionTools`（**复数**）已被两个模块占用：

| 文件 | 导出 | 用途 |
|------|------|------|
| `src/session/tools.ts` | `SessionTools.resolve` | 运行时将 `ToolRegistry` 解析为 AI SDK 工具 |
| `src/session/mark-timed-out.ts` | `SessionTools.Service` / `SessionTools.markTimedOut` | 标记超时工具 |

新功能 **必须用单数 `SessionTool`**：

| 维度 | 值 |
|------|-----|
| namespace | `SessionTool`（单数） |
| Service tag | `@opencode/SessionTool` |
| ID 前缀 | `stl_` |
| PG 表名 | `session_tools` |
| 文件路径 | `src/tool/session-tool.ts`（与 `src/session/tools.ts` 不同目录，不冲突） |

---

## 3. 数据模型

### 3.1 PG 表定义

**新文件：`packages/opencode/src/tool/session-tool.pg.ts`**

照抄 `session-mcp.pg.ts`（最简模板），字段简化为 `name` / `description` / `code`（均为 `text`，无 jsonb）：

```typescript
import { pgTable, text, index, uniqueIndex } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"
import { SessionTable } from "../session/session.pg"

export const SessionToolTable = pgTable(
  "session_tools",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull(),
    code: text().notNull(),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("session_tools_session_idx").on(table.session_id),
    uniqueIndex("session_tools_session_name_idx").on(table.session_id, table.name),
  ],
)
```

### 3.2 迁移文件

**新文件：`packages/opencode/migration-pg/20260703120000_session_tools/migration.sql`**

照抄 `20260604135000_session_mcp/migration.sql` 结构：

```sql
CREATE TABLE IF NOT EXISTS "session_tools" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"code" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_tools_session_id_session_id_fk') THEN
    ALTER TABLE "session_tools" ADD CONSTRAINT "session_tools_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_tools_session_idx" ON "session_tools" ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_tools_session_name_idx" ON "session_tools" ("session_id", "name");
```

迁移由 `src/storage/db.ts` 的 `migratePg()` 自动执行（按 sha256 hash 去重，幂等）。

### 3.3 schema-pg.ts re-export

**修改：`packages/opencode/src/storage/schema-pg.ts`**

末尾追加一行：

```typescript
export { SessionToolTable } from "../tool/session-tool.pg"
```

---

## 4. Session overlay 服务

**新文件：`packages/opencode/src/tool/session-tool.ts`**

照抄 `src/mcp/session-mcp.ts`（结构最干净的模板），适配字段为 `name` / `description` / `code`。

### 4.1 类型定义

```typescript
import z from "zod"
import { randomBytes } from "crypto"
import { Effect, Context, Layer } from "effect"
import { Database, and, asc, eq } from "../storage/db"
import { SessionToolTable } from "./session-tool.pg"
import type { SessionID } from "../session/schema"

export namespace SessionTool {
  export const Row = z.object({
    id: z.string(),
    session_id: z.string(),
    name: z.string(),
    description: z.string(),
    code: z.string(),
    time_created: z.number(),
    time_updated: z.number(),
  })
  export type Row = z.infer<typeof Row>

  export type Input = {
    name: string
    description: string
    code: string
  }
```

### 4.2 Interface + Service

```typescript
  function id() {
    return `stl_${randomBytes(12).toString("base64url")}`
  }

  const db = <T>(
    fn: (
      d: Parameters<typeof Database.use>[0] extends (trx: infer D) => unknown ? D : never,
    ) => T,
  ) => Effect.promise(() => Database.use(fn) as Promise<T>)

  export interface Interface {
    readonly list: (sessionID: SessionID) => Effect.Effect<Row[]>
    readonly get: (sessionID: SessionID, name: string) => Effect.Effect<Row | undefined>
    readonly upsert: (sessionID: SessionID, input: Input) => Effect.Effect<Row>
    readonly remove: (sessionID: SessionID, name: string) => Effect.Effect<void>
    readonly removeAll: (sessionID: SessionID) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTool") {}
```

### 4.3 noopLayer（SQLite / 单机模式）

数据不持久化，`list` 返回空数组。`upsert` 返回构造的 Row 对象（给调用方用），但实际不存储：

```typescript
  export const noopLayer = Layer.succeed(
    Service,
    Service.of({
      list: () => Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      upsert: (_sessionID, input) =>
        Effect.succeed({
          id: id(),
          session_id: _sessionID as string,
          name: input.name,
          description: input.description,
          code: input.code,
          time_created: Date.now(),
          time_updated: Date.now(),
        } as Row),
      remove: () => Effect.void,
      removeAll: () => Effect.void,
    }),
  )
```

### 4.4 layer（SQLite drizzle ORM 实现）

通过 drizzle ORM 操作 `SessionToolTable`。因无 jsonb 字段，`Row.parse(row)` 直接可用，无需 `parsePgRow` 转换：

```typescript
  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of({
        list: Effect.fn("SessionTool.list")(function* (sessionID) {
          const rows = yield* db((d) =>
            d.select().from(SessionToolTable)
              .where(eq(SessionToolTable.session_id, sessionID))
              .orderBy(asc(SessionToolTable.name)).all(),
          )
          return rows.map((row: unknown) => Row.parse(row))
        }),

        get: Effect.fn("SessionTool.get")(function* (sessionID, name) {
          const row = yield* db((d) =>
            d.select().from(SessionToolTable)
              .where(and(eq(SessionToolTable.session_id, sessionID), eq(SessionToolTable.name, name)))
              .get(),
          )
          if (!row) return undefined
          return Row.parse(row)
        }),

        upsert: Effect.fn("SessionTool.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const row = {
            id: id(),
            session_id: sessionID,
            name: input.name,
            description: input.description,
            code: input.code,
            time_created: now,
            time_updated: now,
          } as any
          const rows = yield* db((d: any) =>
            d.insert(SessionToolTable).values(row)
              .onConflictDoUpdate({
                target: [SessionToolTable.session_id, SessionToolTable.name],
                set: {
                  description: input.description,
                  code: input.code,
                  time_updated: now,
                } as any,
              })
              .returning(),
          )
          const result = (rows as any[])[0]
          if (!result) throw new Error("SessionTool upsert returned no rows")
          return Row.parse(result)
        }),

        remove: Effect.fn("SessionTool.remove")(function* (sessionID, name) {
          yield* db((d) =>
            d.delete(SessionToolTable)
              .where(and(eq(SessionToolTable.session_id, sessionID), eq(SessionToolTable.name, name)))
              .run(),
          )
        }),

        removeAll: Effect.fn("SessionTool.removeAll")(function* (sessionID) {
          yield* db((d) =>
            d.delete(SessionToolTable).where(eq(SessionToolTable.session_id, sessionID)).run(),
          )
        }),
      })
    }),
  )
```

### 4.5 pgLayer（PG raw SQL 实现）

通过 `postgres` 库的 tagged template 绕过 drizzle PG 的 `.all()` shim 问题（与 `SessionAgent` / `SessionMcp` 的 `pgLayer` 完全对称）。无 jsonb 字段，只需 `Number()` 转换 bigint：

```typescript
  function parsePgRow(r: any): Row {
    return Row.parse({
      ...r,
      time_created: Number(r.time_created),
      time_updated: Number(r.time_updated),
    })
  }

  export const pgLayer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const sql = (Database.Client() as any).$client

      const query = (strings: TemplateStringsArray, ...values: any[]) =>
        Effect.promise(() => sql(strings, ...values) as Promise<any[]>)

      return Service.of({
        list: Effect.fn("SessionTool.list")(function* (sessionID) {
          const rows = yield* query`SELECT * FROM session_tools WHERE session_id = ${sessionID} ORDER BY name ASC`
          return rows.map(parsePgRow)
        }),

        get: Effect.fn("SessionTool.get")(function* (sessionID, name) {
          const rows = yield* query`SELECT * FROM session_tools WHERE session_id = ${sessionID} AND name = ${name}`
          if (rows.length === 0) return undefined
          return parsePgRow(rows[0])
        }),

        upsert: Effect.fn("SessionTool.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const newId = id()
          const rows = yield* query`
            INSERT INTO session_tools (id, session_id, name, description, code, time_created, time_updated)
            VALUES (${newId}, ${sessionID}, ${input.name}, ${input.description}, ${input.code}, ${now}, ${now})
            ON CONFLICT (session_id, name) DO UPDATE SET
              description = EXCLUDED.description, code = EXCLUDED.code, time_updated = EXCLUDED.time_updated
            RETURNING *
          `
          if (!rows[0]) throw new Error("SessionTool upsert returned no rows")
          return parsePgRow(rows[0])
        }),

        remove: Effect.fn("SessionTool.remove")(function* (sessionID, name) {
          yield* query`DELETE FROM session_tools WHERE session_id = ${sessionID} AND name = ${name}`
        }),

        removeAll: Effect.fn("SessionTool.removeAll")(function* (sessionID) {
          yield* query`DELETE FROM session_tools WHERE session_id = ${sessionID}`
        }),
      })
    }),
  )
}
```

---

## 5. 工具代码动态加载机制

### 5.1 加载策略

`code` 字段是 JS/TS 模块源码。加载流程：

```
code 字符串
  ↓ 写入临时文件（.ts 扩展名，Bun 自动编译 TS → JS）
临时文件
  ↓ import(pathToFileURL(file).href)（与磁盘工具 import 路径完全一致）
模块对象
  ↓ mod.default ?? mod（支持 default export 和命名 export）
ToolDefinition（{ description, args, execute }）
  ↓ fromSessionToolDef(id, def, directory, worktree)（独立包装，不修改 fromPlugin）
Tool.Def（合并到 registry）
```

> **不修改 `fromPlugin`**：详见第 6 章的"为什么不提取模块级函数"一节。session tools 用独立的 `fromSessionToolDef` 包装，与现有 `fromPlugin` 互不干扰。

### 5.2 临时文件 + 缓存

**设计要点：**
- 临时文件用唯一文件名（`Date.now()` + `random`），避免模块缓存冲突
- `import()` 完成后立即删除临时文件——ES module 一旦加载就缓存在内存（以 URL 为 key），删除源文件不影响已加载的模块
- 用 `Map<string, Module>` 以 code 内容为 key 做二级缓存，避免相同 code 重复写文件 + import

**代码位置：** 模块级函数，放在 `registry.ts` 中（与 `fromPlugin` 相邻）。

```typescript
import os from "os"
import path from "path"
import { pathToFileURL } from "url"

// code 内容 → 已加载模块的缓存，避免重复编译
const sessionToolCodeCache = new Map<string, Promise<any>>()

async function importToolCode(code: string): Promise<any> {
  const cached = sessionToolCodeCache.get(code)
  if (cached) return cached

  const promise = (async () => {
    const fs = await import("fs/promises")
    const file = path.join(
      os.tmpdir(),
      `opencode-stl-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
    )
    await fs.writeFile(file, code)
    try {
      return await import(pathToFileURL(file).href)
    } finally {
      await fs.unlink(file).catch(() => {})
    }
  })()

  sessionToolCodeCache.set(code, promise)
  return promise
}
```

> **缓存清理**：code 缓存以内容为 key，upsert 相同内容不会产生新条目。session 删除时可选清理（`removeAll` 后清除该 session 相关的缓存条目），但因 Map 以 code 内容（而非 sessionID）为 key，清理需要在 registry 层记录 sessionID → code 的映射。MVP 阶段不清理（工具代码体积小，条目有限），后续优化。

---

## 6. registry.ts 集成方案

### 6.1 设计原则：不修改 `fromPlugin`，独立包装 session tools

#### 为什么不能提取模块级 `fromToolDefinition`

原始方案曾考虑将 `fromPlugin` 提取为模块级函数 `fromToolDefinition`，把闭包依赖改为运行时 `yield* Agent.Service` / `yield* InstanceState.context`。**这个方案不可行，会破坏所有现有工具。**

原因在于工具 execute 的运行时 context 不完整：

```typescript
// session/prompt.ts:1242-1247
const tools = yield* SessionTools.resolve({...}).pipe(
  Effect.provideService(Plugin.Service, plugin),
  Effect.provideService(Permission.Service, permission),
  Effect.provideService(ToolRegistry.Service, registry),
  Effect.provideService(MCP.Service, mcp),
  Effect.provideService(Truncate.Service, truncate),
  // ⚠️ 没有 provide Agent.Service
  // ⚠️ 没有 provide InstanceRef
)
```

工具 execute 通过 `EffectBridge.make()` 的 `run.promise(...)` 调用（`session/tools.ts:123`），运行在 bridge 的 runtime context 中。该 context 只继承了 bridge 创建时的服务，**不包含 `Agent.Service` 和 `InstanceRef`**。

现有 `fromPlugin` 能正常工作，是因为它在 **闭包创建时**（registry layer 初始化阶段）就捕获了 `agent`/`truncate`/`ctx`，execute 运行时直接用闭包值，不 yield 任何服务。

如果改成 `yield* Agent.Service`，execute 运行时会在 context 中查找 `Agent.Service`——找不到就会 `Effect.die`，**所有磁盘工具和插件工具全部崩溃**。

#### 正确方案：layer 闭包内独立定义 `fromSessionToolDef`

在 registry.ts 的 `layer` 的 `Effect.gen` 闭包中（与 `fromPlugin` **同级**，而非 `InstanceState.make` 内层），定义一个专用于 session tools 的包装函数 `fromSessionToolDef`。

**关键设计**：与 `fromPlugin` 完全一致的闭包捕获模式——`agent` 和 `truncate` 在 layer 闭包创建时捕获，不依赖 execute 运行时 context。`directory`/`worktree` 在 `tools()` 调用时预获取并传入闭包（而非 execute 运行时 yield）。

```typescript
// registry.ts — layer 闭包内，InstanceState.make 之后、tools() 之前定义
//
// 与 fromPlugin 同级，闭包捕获外层的 agent(line 119) 和 truncate(line 97)。
// directory/worktree 由调用方在 tools() 调用时预获取后传入。
// execute 运行时不 yield 任何服务，与 fromPlugin 的安全性完全一致。
function fromSessionToolDef(
  id: string,
  def: ToolDefinition,
  directory: string,
  worktree: string | undefined,
): Tool.Def {
  const args = def.args ?? {}
  const entries = Object.entries(args)
  const allZod = entries.every((entry) => isZodType(entry[1]))
  const zodParams = allZod ? z.object(args) : undefined
  const jsonSchema = zodParams ? zodJsonSchema(zodParams) : legacyJsonSchema(entries)
  const parameters = zodParams
    ? Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success)
    : Schema.Unknown
  return {
    id,
    parameters,
    jsonSchema,
    description: def.description,
    execute: (args, toolCtx) =>
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        const pluginCtx: PluginToolContext = {
          ...toolCtx,
          ask: (req) => bridge.promise(toolCtx.ask(req)),
          directory,          // ← 闭包捕获（tools() 调用时预获取）
          worktree,           // ← 闭包捕获
        }
        const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
        const output = typeof result === "string" ? result : result.output
        const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
        const attachments = typeof result === "string" ? undefined : result.attachments
        // agent / truncate 是外层闭包捕获的，不 yield
        const info = yield* agent.get(toolCtx.agent)
        const out = yield* truncate.output(output, {}, info)
        return {
          title: typeof result === "string" ? "" : (result.title ?? ""),
          output: out.truncated ? out.content : output,
          attachments,
          metadata: {
            ...metadata,
            truncated: out.truncated,
            ...(out.truncated && { outputPath: out.outputPath }),
          },
        }
      }).pipe(
        Effect.withSpan("Tool.execute", {
          attributes: {
            "tool.name": id,
            "session.id": toolCtx.sessionID,
            "message.id": toolCtx.messageID,
            ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
          },
        }),
      ),
  }
}
```

**与 `fromPlugin` 的对比：**

| 维度 | `fromPlugin`（现有，不修改） | `fromSessionToolDef`（新增） |
|------|----------------------------|---------------------------|
| 定义位置 | `InstanceState.make` 闭包内 | `layer` 闭包内（同层） |
| 闭包捕获 `agent` | ✅ 外层 `layer` 闭包 | ✅ 同一个外层 `layer` 闭包 |
| 闭包捕获 `truncate` | ✅ 外层 `layer` 闭包 | ✅ 同一个外层 `layer` 闭包 |
| 获取 directory/worktree | `ctx.directory`（`InstanceState.make` 回调参数） | 调用方传参（`tools()` 中预获取） |
| execute 运行时 yield 服务 | 仅 `EffectBridge.make()` | 仅 `EffectBridge.make()` |
| **现有工具受影响** | **不改，零风险** | 不涉及 |

### 6.2 在 layer 中注入 SessionTool.Service

在 `registry.ts` 的 `layer` 的 `Effect.gen` 中，新增可选服务注入（与 handler 中 `mcpSessionSvc` 模式一致）：

```typescript
// 在 layer 的 Effect.gen 中，yield 其他服务之后
const sessionToolSvc = Option.getOrUndefined(yield* Effect.serviceOption(SessionTool.Service))
```

需要在文件顶部添加 import：

```typescript
import { SessionTool } from "./session-tool"
import { Option } from "effect"  // 若未导入
```

### 6.3 在 `tools()` 方法中合并 session tools（Map 覆盖策略）

`tools()` 方法（`registry.ts:309-353`）已接受 `sessionID` 参数，是合并 session overlay 的理想位置。

**合并策略：Map 覆盖**——与 `Agent.sessionList`（`agent.ts:528-542`）的 Map 合并模式一致。全局工具先入 Map，session tools 覆盖同名全局工具，使 session tool 能定制/替换现有工具行为。

**改动位置：** `tools()` 的 `Effect.fn("ToolRegistry.tools")` 内，在 `filtered` 计算之后、`Effect.forEach` 之前插入 session tool 加载逻辑。

```typescript
const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
  const filtered = (yield* all()).filter((tool) => {
    // ... 现有过滤逻辑完全不变 ...
  })

  // ── 新增：加载 session tools ──────────────────────────────
  let sessionDefs: Tool.Def[] = []
  if (input.sessionID && sessionToolSvc && Flag.OPENCODE_DATABASE_URL) {
    // 在 tools() 调用时预获取 directory/worktree（非 execute 运行时）
    // tools() 通过 all() → InstanceState.get(state) 已运行在 InstanceState scope 中
    const ictx = yield* InstanceState.context.pipe(
      Effect.catchAll(() => Effect.succeed(undefined)),
    )

    const rows = yield* sessionToolSvc.list(input.sessionID).pipe(
      Effect.catchAll(() => Effect.succeed([] as SessionTool.Row[])),
    )
    for (const row of rows) {
      const mod = yield* Effect.tryPromise({
        try: () => importToolCode(row.code),
        catch: () => null as any,
      }).pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (!mod) continue
      const def = (mod.default ?? mod) as ToolDefinition
      if (!isPluginTool(def)) continue
      // directory/worktree 预获取后传入，execute 闭包捕获
      sessionDefs.push(
        fromSessionToolDef(row.name, def, ictx?.directory ?? "", ictx?.worktree),
      )
    }
  }
  // ──────────────────────────────────────────────────────────

  // Map 覆盖合并：session tool 覆盖同名的全局工具
  const merged = new Map<string, Tool.Def>()
  for (const def of filtered) merged.set(def.id, def)
  for (const def of sessionDefs) merged.set(def.id, def)

  return yield* Effect.forEach(
    [...merged.values()],
    // ... 现有 Effect.forEach 包装逻辑完全不变 ...
    { concurrency: "unbounded" },
  )
})
```

**关键设计决策：**

| 决策 | 理由 |
|------|------|
| **不修改 `fromPlugin`** | 现有磁盘工具/插件工具的加载和执行路径零改动，零风险 |
| **`fromSessionToolDef` 在 layer 闭包内** | 与 `fromPlugin` 共享同一闭包的 `agent`/`truncate`，execute 运行时不 yield 任何服务 |
| **directory/worktree 在 `tools()` 调用时预获取** | 不依赖 execute 运行时 context（该 context 无 `InstanceRef`），降级为空字符串 |
| **Map 覆盖合并** | 与 `Agent.sessionList` 一致；session tool 可覆盖同名全局工具 |
| 用 `Flag.OPENCODE_DATABASE_URL` 守卫 | 与 `SessionAgent` / `SessionMcp` 一致，单机模式（noopLayer）下 session tools 不可用 |
| `Effect.catchAll` / `tryPromise` 降级 | session tool 加载失败不阻断 LLM 请求，逐个跳过失败的工具 |
| `row.name` 作为 tool ID | LLM 看到的工具名 = 数据库中的 name；同名时覆盖全局工具 |

### 6.4 Layer 装配

在 `registry.ts` 的 `node` 定义中添加 `SessionTool` 的 LayerNode，并在 `defaultLayer` 中根据 `Flag.OPENCODE_DATABASE_URL` 选择 `pgLayer` 或 `noopLayer`：

```typescript
// 新增 SessionTool LayerNode
const sessionToolNode = LayerNode.make({
  service: SessionTool.Service,
  layer: Flag.OPENCODE_DATABASE_URL ? SessionTool.pgLayer : SessionTool.noopLayer,
  deps: [],
})

// 在 node 的 deps 中添加
export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    // ... 现有 deps ...
    sessionToolNode,  // 新增
  ] as any,
})
```

> **注**：`defaultLayer` 中不需要额外 provide——`LayerNode.make` 的 `layer` 字段会在 `LayerNode.compile(node)` 时自动编译。`sessionToolNode` 声明了 `layer` 字段，所以它的 layer 已自带。

---

## 7. HTTP API 设计

### 7.1 路由声明

**修改：`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`**

#### Payload 定义

```typescript
export const ToolCreatePayload = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  code: Schema.String,
})
```

#### SessionPaths 新增

```typescript
export const SessionPaths = {
  // ... 现有路径 ...
  tools:       `${root}/:sessionID/tools`,
  toolsCreate: `${root}/:sessionID/tools/create`,
  toolsDelete: `${root}/:sessionID/tools/:name`,
} as const
```

#### HttpApiEndpoint 声明

在 `SessionApi` 的 `HttpApiGroup.make("session")` 链中，紧接 mcps 端点块之后添加：

```typescript
HttpApiEndpoint.get("tools", SessionPaths.tools, {
  params: { sessionID: SessionID },
  query: WorkspaceRoutingQuery,
  success: described(Schema.Array(Schema.Unknown), "Session tools"),
  error: [HttpApiError.BadRequest, ApiNotFoundError],
}).annotateMerge(
  OpenApi.annotations({
    identifier: "session.tools",
    summary: "List session tools",
    description: "Get custom tools attached to a specific OpenCode session.",
  }),
),
HttpApiEndpoint.post("toolsCreate", SessionPaths.toolsCreate, {
  params: { sessionID: SessionID },
  query: WorkspaceRoutingQuery,
  payload: ToolCreatePayload,
  success: described(Schema.Unknown, "Created session tool"),
}).annotateMerge(
  OpenApi.annotations({
    identifier: "session.tools.create",
    summary: "Create session tool",
    description: "Create or update a custom tool attached to a specific OpenCode session. Only available in SaaS mode.",
  }),
),
HttpApiEndpoint.delete("toolsDelete", SessionPaths.toolsDelete, {
  params: { sessionID: SessionID, name: Schema.String },
  query: WorkspaceRoutingQuery,
  success: described(Schema.Void, "Session tool removed"),
}).annotateMerge(
  OpenApi.annotations({
    identifier: "session.tools.delete",
    summary: "Delete session tool",
    description: "Remove a custom tool from a specific OpenCode session.",
  }),
),
HttpApiEndpoint.delete("toolsClear", SessionPaths.tools, {
  params: { sessionID: SessionID },
  query: WorkspaceRoutingQuery,
  success: described(Schema.Void, "Session tools cleared"),
}).annotateMerge(
  OpenApi.annotations({
    identifier: "session.tools.clear",
    summary: "Clear session tools",
    description: "Remove all custom tools attached to a specific OpenCode session.",
  }),
),
```

### 7.2 Handler 实现

**修改：`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`**

#### 服务注入

```typescript
import { SessionTool } from "@/tool/session-tool"

// 在 HttpApiBuilder.group 的 Effect.gen 中
const toolSessionSvc = Option.getOrUndefined(yield* Effect.serviceOption(SessionTool.Service))
```

#### Handler 函数

```typescript
const listTools = Effect.fn("SessionHttpApi.tools")(function* (ctx: {
  params: { sessionID: SessionID }
}) {
  yield* requireSession(ctx.params.sessionID)
  if (!toolSessionSvc) return []
  return yield* toolSessionSvc.list(ctx.params.sessionID).pipe(Effect.catch(() => Effect.succeed([])))
})

const createTool = Effect.fn("SessionHttpApi.toolsCreate")(function* (ctx: {
  params: { sessionID: SessionID }
  payload: { name: string; description: string; code: string }
}) {
  if (!toolSessionSvc) throw new Error("Session tools are only available in SaaS mode")
  return yield* toolSessionSvc.upsert(ctx.params.sessionID, ctx.payload)
})

const deleteTool = Effect.fn("SessionHttpApi.toolsDelete")(function* (ctx: {
  params: { sessionID: SessionID; name: string }
}) {
  if (!toolSessionSvc) throw new Error("Session tools are only available in SaaS mode")
  yield* toolSessionSvc.remove(ctx.params.sessionID, ctx.params.name)
})

const clearTools = Effect.fn("SessionHttpApi.toolsClear")(function* (ctx: {
  params: { sessionID: SessionID }
}) {
  if (!toolSessionSvc) throw new Error("Session tools are only available in SaaS mode")
  yield* toolSessionSvc.removeAll(ctx.params.sessionID)
})
```

#### Handler 注册

在 `handlers.handle(...)` 链末尾追加：

```typescript
.handle("tools", listTools)
.handle("toolsCreate", createTool)
.handle("toolsDelete", deleteTool)
.handle("toolsClear", clearTools)
```

### 7.3 API 端点一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/session/:sessionID/tools` | 列出 session 自定义工具 |
| POST | `/session/:sessionID/tools/create` | 创建/更新 session 自定义工具（upsert） |
| DELETE | `/session/:sessionID/tools/:name` | 删除单个 session 自定义工具 |
| DELETE | `/session/:sessionID/tools` | 清空所有 session 自定义工具 |

---

## 8. Session 销毁时的级联清理

`session_tools` 表的 `session_id` 字段有 `ON DELETE cascade` 外键约束（见迁移 SQL），所以 session 删除时 PG 会自动级联删除该 session 的所有 tools 记录。

**无需在应用层额外实现清理逻辑**——与 `SessionAgent`、`SessionSkill`、`SessionMcp` 完全一致。

code 缓存（`sessionToolCodeCache` Map）在 MVP 阶段不随 session 删除清理。理由：
- Map 以 code 内容为 key，非 sessionID
- 工具代码体积小，条目有限
- 进程重启后缓存自然清空

---

## 9. 测试方案

### 9.1 内存层 CRUD 测试

**新文件：`packages/opencode/test/tool/session-tool-crud.test.ts`**

参考 `test/agent/session-agent-crud.test.ts`（247 行），测试 `noopLayer` 下的行为：

```typescript
// 测试 noopLayer 的 upsert 返回正确 Row
// 测试 noopLayer 的 list 始终返回 []
// 测试 noopLayer 的 get 始终返回 undefined
// 测试 noopLayer 的 remove/removeAll 不抛异常
```

### 9.2 PG 层集成测试

**新文件：`packages/opencode/test/tool/session-tool-pg.test.ts`**

参考 `test/skill/session-skill-pg.test.ts`（154 行）和 `test/agent/session-agent-pg.test.ts`（227 行），测试 `pgLayer`：

```typescript
// 测试 upsert → list 往返一致性
// 测试 upsert 同名工具触发 onConflictDoUpdate（覆盖 description/code）
// 测试 get 按名称查找
// 测试 remove 删除单个
// 测试 removeAll 清空
// 测试 session 删除时级联清理（ON DELETE cascade）
```

### 9.3 动态加载测试

**新文件：`packages/opencode/test/tool/session-tool-load.test.ts`**

测试 `importToolCode` 函数：

```typescript
// 测试加载有效的 JS code
// 测试加载有效的 TS code（Bun 编译）
// 测试加载 default export
// 测试加载命名 export
// 测试 code 缓存命中（相同 code 不重复 import）
// 测试语法错误的 code 抛异常
```

### 9.4 HTTP API 测试

**新文件：`packages/opencode/test/server/session-tools.test.ts`**

参考 `test/server/session-agents.test.ts` / `test/server/session-skills.test.ts`：

```typescript
// 测试 POST create → GET list → DELETE → GET list 为空
// 测试 DELETE clear 清空所有
// 测试非 SaaS 模式下 create 返回错误
```

### 9.5 测试运行

```bash
# 从 packages/opencode 目录运行（不能从 repo root）
cd packages/opencode
bun test test/tool/session-tool-crud.test.ts
bun test test/tool/session-tool-pg.test.ts
```

---

## 10. 安全考量

| 风险 | 缓解 |
|------|------|
| code 中执行恶意代码 | **风险与现有磁盘工具/插件工具等同**。session tool 的 code 由 session 创建者提供，运行在宿主机/沙箱中，与 `tool/*.ts` 磁盘工具和插件工具的信任模型一致。opencode 本身就允许用户自定义工具执行任意代码（shell、write 等）。 |
| code 中的 `import()` 拉取外部模块 | 与磁盘工具行为一致，不做额外限制。沙箱模式下工具执行在隔离容器中。 |
| code 注入导致临时文件竞争 | 临时文件名包含 `Date.now()` + `Math.random()`，足够唯一。 |
| code 缓存内存泄漏 | MVP 阶段不清理。生产环境可加 LRU 上限或随 session 清理。 |

---

## 11. 边界情况

| 场景 | 处理方式 |
|------|----------|
| 非 SaaS 模式（无 PG） | `noopLayer` 生效，`list` 返回 `[]`，`upsert` 返回构造的 Row 但不存储。`createTool` handler 在非 SaaS 模式下抛 `"Session tools are only available in SaaS mode"` |
| code 加载失败（语法错误） | `importToolCode` 抛异常，`tools()` 中逐个 `try/catch` 跳过，该工具不出现在 LLM 工具列表中 |
| code 导出格式不符 `ToolDefinition` | `isPluginTool(def)` 检查失败，跳过该工具 |
| 同名 session tool 与全局工具 | **Map 覆盖**：session tool 覆盖同名的全局工具（`merged.set(def.id, def)`，session tool 后入 Map）。与 `Agent.sessionList` 的覆盖模式一致。LLM 只看到一个工具（session 版本）。session tool 被删除后自动回退到全局工具（下次 `tools()` 调用时 Map 中只有全局版本） |
| session 删除 | PG 级联删除（`ON DELETE cascade`） |
| LLM 请求期间 session tool 被删除 | 每次 `tools()` 调用重新从 PG 读取，自然反映最新状态。正在执行的工具调用不受影响（execute 闭包已持有引用） |

---

## 12. 实现步骤

> 建议按以下顺序实现，每步完成后可独立 typecheck。

| 步骤 | 内容 | 涉及文件 |
|------|------|----------|
| 1 | PG 表定义 | `src/tool/session-tool.pg.ts`（新建） |
| 2 | 迁移文件 | `migration-pg/20260703120000_session_tools/migration.sql`（新建） |
| 3 | schema-pg re-export | `src/storage/schema-pg.ts`（修改，+1 行） |
| 4 | session overlay 服务 | `src/tool/session-tool.ts`（新建） |
| 5 | registry.ts 集成 | `src/tool/registry.ts`（修改：+`importToolCode` +`fromSessionToolDef`（闭包内，不改 `fromPlugin`） + `tools()` Map 合并 + LayerNode） |
| 6 | HTTP API 路由声明 | `src/server/routes/instance/httpapi/groups/session.ts`（修改） |
| 7 | HTTP API handler | `src/server/routes/instance/httpapi/handlers/session.ts`（修改） |
| 8 | typecheck | `cd packages/opencode && bun typecheck` |
| 9 | 测试 | `test/tool/session-tool-*.test.ts`（新建） |

---

## 13. 涉及文件清单

### 新建文件（5 个）

| 文件 | 说明 |
|------|------|
| `packages/opencode/src/tool/session-tool.pg.ts` | PG 表定义 |
| `packages/opencode/src/tool/session-tool.ts` | session overlay 服务（noopLayer / layer / pgLayer） |
| `packages/opencode/migration-pg/20260703120000_session_tools/migration.sql` | 数据库迁移 |
| `packages/opencode/test/tool/session-tool-crud.test.ts` | 内存层 CRUD 测试 |
| `packages/opencode/test/tool/session-tool-pg.test.ts` | PG 层集成测试 |

### 修改文件（5 个）

| 文件 | 改动 |
|------|------|
| `packages/opencode/src/storage/schema-pg.ts` | +1 行 re-export |
| `packages/opencode/src/tool/registry.ts` | +`importToolCode` 模块级函数 + `fromSessionToolDef` layer 闭包内函数（**不修改现有 `fromPlugin`**） + `tools()` 中 Map 覆盖合并 session tools + LayerNode |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` | +`ToolCreatePayload` +`SessionPaths` 4 条路径 +4 个 `HttpApiEndpoint` |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | +`SessionTool` import +`toolSessionSvc` 注入 +4 个 handler 函数 +4 个 `.handle()` 注册 |
| `packages/opencode/test/tool/session-tool-load.test.ts`（可选） | 动态加载测试 |

---

## 附录 A：与现有 session overlay 的对称性对比

| 维度 | SessionAgent | SessionSkill | SessionMcp | **SessionTool** |
|------|-------------|-------------|-----------|----------------|
| 文件 | `agent/session-agent.ts` | `skill/session-skill.ts` | `mcp/session-mcp.ts` | **`tool/session-tool.ts`** |
| PG 表 | `agent.pg.ts` | `skill.pg.ts` | `session-mcp.pg.ts` | **`tool/session-tool.pg.ts`** |
| namespace | `SessionAgent` | `SessionSkill` | `SessionMcp` | **`SessionTool`** |
| Service tag | `@opencode/SessionAgent` | `@opencode/SessionSkill` | `@opencode/SessionMcp` | **`@opencode/SessionTool`** |
| ID 前缀 | `sag_` | `ssk_` | `smc_` | **`stl_`** |
| 特有字段 | prompt/permission/model/... | description/content/resources | type/command/url/headers/enabled | **description/code** |
| noopLayer | ✅ | ✅ | ✅ | ✅ |
| layer (drizzle) | ✅ | ✅ | ✅ | ✅ |
| pgLayer (raw SQL) | ✅ | ❌ | ✅ | ✅ |
| 领域 Service 合并 | `Agent.sessionList` (Map 覆盖) | `Skill.all` / `Skill.available` | 直接 CRUD | **`ToolRegistry.tools()` 合并** |
| HTTP API | agents (4 端点) | skills (5 端点, 含 load) | mcps (4 端点) | **tools (4 端点)** |
| 级联删除 | `ON DELETE cascade` | `ON DELETE cascade` | `ON DELETE cascade` | ✅ |

## 附录 B：code 字段完整示例

```typescript
// 一个完整的 session tool code 示例
// 支持 default export 和命名 export 两种形式

// === 形式 1: default export（推荐） ===
export default {
  description: "Fetch the current weather for a city",
  args: {
    city: {
      _zod: {
        type: "string",
        description: "City name",
      },
    },
  },
  async execute(args, ctx) {
    const res = await fetch(`https://wttr.in/${args.city}?format=3`)
    const text = await res.text()
    return {
      title: `Weather: ${args.city}`,
      output: text.trim(),
    }
  },
}

// === 形式 2: 使用 zod schema（需 code 中 import zod） ===
import { z } from "zod"

export default {
  description: "Calculate fibonacci number",
  args: {
    n: z.number().int().positive().describe("Position in fibonacci sequence"),
  },
  async execute(args, ctx) {
    const fib = (n: number): number => n <= 1 ? n : fib(n - 1) + fib(n - 2)
    return {
      title: `fib(${args.n})`,
      output: `fib(${args.n}) = ${fib(args.n)}`,
    }
  },
}

// === 形式 3: 命名 export（mod.default 为 undefined 时回退到 mod 本身） ===
export const description = "Echo input"
export const args = { message: { _zod: { type: "string" } } }
export async function execute(args, ctx) {
  return { title: "Echo", output: args.message }
}
```
