# Session-Plugins 技术方案

> 会话级动态 Plugin 注册：允许在特定 session 中动态注册自定义 Plugin 代码，运行时通过 `importPluginCode` 加载并注入 hooks 到 `Plugin.trigger` 链。

---

## 一、背景与目标

### 1.1 现状

opencode 已有的会话级动态功能：

| 功能 | 分支 | 数据形态 | 运行时作用域 |
|------|------|---------|-------------|
| Session Commands | feat/session-commands | 模板文本（template + hints） | 命令执行时的模板替换 |
| Session Tools | feat/session-tools | 工具代码（ToolDefinition） | 工具注册表（registry）动态合并 |
| Session Goal | feat/session-goal | 停止条件文本 | prompt 循环 goalGate |

以上三种功能的共同模式：PG 持久化 + Service 双层（noop/SQLite/PG） + HTTP API CRUD + 运行时 overlay 合并。

### 1.2 目标

实现 **Session Plugins**：每个 session 可以注册自己的 Plugin 代码（TS/JS 模块），返回 `Hooks` 对象，在 prompt 循环 / tool 执行 / 事件总线中被触发。

### 1.3 与现有功能的区别

| 维度 | Session Commands / Tools | Session Plugins |
|------|--------------------------|-----------------|
| 存储内容 | 模板文本 / 工具定义代码 | 完整 Plugin 函数代码（返回多个 hooks） |
| 加载方式 | 命令查找 / importToolCode | importPluginCode（同模式） |
| 运行时影响 | 单个命令/工具 | **多个生命周期 hook**（tool/chat/shell/event 等） |
| 注入位置 | command/index.ts overlay / registry.ts 合并 | **plugin/index.ts trigger 扩展** |
| 隔离性 | session 间天然隔离 | session 间天然隔离（hooks 按 sessionID 分组） |

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    HTTP API Layer                        │
│  GET/POST/DELETE /session/:id/plugins[/...]             │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│              SessionPlugin.Service                       │
│  list / get / upsert / remove / removeAll               │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  noopLayer  │  │ sqliteLayer  │  │   pgLayer     │  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│              importPluginCode(code)                      │
│  写临时 .ts → import() → 执行 Plugin(input) → Hooks     │
│  cache by code hash                                      │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│           Plugin.trigger 扩展 (plugin/index.ts)          │
│  1. 遍历实例级 hooks（现有逻辑不变）                      │
│  2. 遍历 session 级 hooks（新增）                         │
│     → sessionPluginSvc.list(sessionID)                   │
│     → importPluginCode(row.code)                         │
│     → plugin(input) → Hooks                              │
│     → hooks[name](input, output)                         │
└─────────────────────────────────────────────────────────┘
```

---

## 三、文件清单

### 3.1 新增文件

| 文件 | 说明 |
|------|------|
| `packages/opencode/src/plugin/session-plugin.ts` | Service 定义：Schema + CRUD + importPluginCode + 三层 Layer |
| `packages/opencode/src/plugin/session-plugin.pg.ts` | Drizzle PG 表定义 |
| `packages/opencode/migration-pg/20260715120000_session_plugins/migration.sql` | 建表 SQL |
| `docs/session-plugins.md` | 用户使用文档 |
| `docs/test-cases/35-session-plugins.md` | 测试用例 |
| `packages/opencode/test/plugin/session-plugin.test.ts` | 单元测试 |

### 3.2 修改文件

| 文件 | 改动 |
|------|------|
| `packages/opencode/src/plugin/index.ts` | trigger 扩展：合并 session 级 hooks；PluginInput 构建提取为公共函数 |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` | 添加 4 个 API 端点 + Path 常量 |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | 添加 4 个 handler |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | 注册 handler |
| `docs/test-cases/00-INDEX.md` | 添加索引条目 |

---

## 四、数据层设计

### 4.1 Schema 定义

```ts
// session-plugin.ts

export const Row = z.object({
  id: z.string(),                  // spl_ 前缀
  session_id: z.string(),
  name: z.string(),                // 同 session 内唯一
  description: z.string(),
  code: z.string(),                // Plugin 函数源码
  enabled: z.boolean().default(true),
  time_created: z.number(),
  time_updated: z.number(),
})

export type Input = {
  name: string
  description: string
  code: string
  enabled?: boolean                // 默认 true
}
```

### 4.2 PG 表定义

```ts
// session-plugin.pg.ts

export const SessionPluginTable = pgTable("session_plugins", {
  id: text().primaryKey(),
  session_id: text().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
  name: text().notNull(),
  description: text(),
  code: text().notNull(),
  enabled: boolean().notNull().default(true),
  time_created: Timestamps.time_created,
  time_updated: Timestamps.time_updated,
}, (table) => [
  index("session_plugins_session_idx").on(table.session_id),
  uniqueIndex("session_plugins_session_name_idx").on(table.session_id, table.name),
])
```

### 4.3 Migration SQL

```sql
-- migration-pg/20260715120000_session_plugins/migration.sql

CREATE TABLE IF NOT EXISTS "session_plugins" (
  "id" text PRIMARY KEY,
  "session_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "code" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_plugins_session_id_session_id_fk') THEN
    ALTER TABLE "session_plugins" ADD CONSTRAINT "session_plugins_session_id_session_id_fk"
    FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_plugins_session_idx" ON "session_plugins" ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_plugins_session_name_idx" ON "session_plugins" ("session_id", "name");
```

---

## 五、Service 层设计

### 5.1 接口定义

```ts
export interface Interface {
  readonly list: (sessionID: SessionID) => Effect.Effect<Row[]>
  readonly get: (sessionID: SessionID, name: string) => Effect.Effect<Row | undefined>
  readonly upsert: (sessionID: SessionID, input: Input) => Effect.Effect<Row>
  readonly remove: (sessionID: SessionID, name: string) => Effect.Effect<void>
  readonly removeAll: (sessionID: SessionID) => Effect.Effect<void>
}
```

接口签名与 session-commands / session-tools 完全一致，保证实现模式统一。

### 5.2 三层 Layer

| Layer | 使用场景 | 实现 |
|-------|---------|------|
| `noopLayer` | 非 SaaS 模式（无 DATABASE_URL） | 所有方法返回空值/空数组 |
| `layer` | SQLite 模式 | Drizzle ORM + `@opencode-ai/effect-drizzle-sqlite` |
| `pgLayer` | SaaS 模式（有 DATABASE_URL） | 原生 `pg` SQL，手动映射 Row |

Layer 选择逻辑（与 session-commands 一致）：

```ts
const sessionPluginNode = LayerNode.make({
  service: SessionPlugin.Service,
  layer: Flag.OPENCODE_DATABASE_URL ? SessionPlugin.pgLayer : SessionPlugin.noopLayer,
  deps: [],
})
```

### 5.3 ID 生成

```ts
import { randomBytes } from "crypto"

function generateId(): string {
  return "spl_" + randomBytes(12).toString("base64url")
}
```

---

## 六、动态加载

### 6.1 importPluginCode

复用 session-tools 的 `importToolCode` 临时文件模式：

```ts
const pluginCodeCache = new Map<string, Promise<Plugin>>()

export async function importPluginCode(code: string): Promise<Plugin> {
  const cached = pluginCodeCache.get(code)
  if (cached) return cached

  const promise = (async () => {
    const fs = await import("fs/promises")
    const file = path.join(
      import.meta.dir,
      `.opencode-spl-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
    )
    await fs.writeFile(file, code)
    try {
      const mod = await import(pathToFileURL(file).href)
      // 支持两种导出格式：default export 或 module 本身即函数
      return (mod.default ?? mod) as Plugin
    } finally {
      await fs.unlink(file).catch(() => {})
    }
  })()

  pluginCodeCache.set(code, promise)
  return promise
}
```

**设计要点**：
- **cache key 为 code 字符串内容**，相同代码只编译一次
- 临时文件名 `.opencode-spl-{timestamp}-{random}.ts`，finally 中删除
- 无沙箱——在主进程上下文执行（与 session-tools 相同策略）
- 支持 `export default` 和直接导出函数两种格式

### 6.2 Plugin 代码格式

用户通过 API 提交的 Plugin 代码遵循 opencode 标准 Plugin 接口：

```ts
// 示例：session 级 plugin 代码
export default async (input) => {
  return {
    "tool.execute.before": async (toolInput, output) => {
      console.log(`Tool ${toolInput.tool} called in session`)
      // 修改 output.args...
    },
    "chat.message": async (chatInput, output) => {
      // 修改 output.message...
    },
  }
}
```

### 6.3 允许的 Hooks 子集

出于安全考虑，session 级 plugin 只允许注册以下 hooks：

| Hook | 允许 | 说明 |
|------|------|------|
| `tool.execute.before` | ✅ | 工具调用前拦截 |
| `tool.execute.after` | ✅ | 工具调用后处理 |
| `tool.definition` | ✅ | 工具定义修改 |
| `chat.message` | ✅ | 消息处理 |
| `chat.params` | ✅ | 请求参数修改 |
| `chat.headers` | ✅ | 请求头修改 |
| `command.execute.before` | ✅ | 命令预处理 |
| `shell.env` | ✅ | 环境变量注入 |
| `permission.ask` | ✅ | 权限决策 |
| `experimental.chat.messages.transform` | ✅ | 消息变换 |
| `experimental.chat.system.transform` | ✅ | 系统提示变换 |
| `experimental.session.compacting` | ✅ | 压缩控制 |
| `experimental.text.complete` | ✅ | 文本补全 |
| `event` | ✅ | 事件监听 |
| `config` | ❌ | 实例级配置，session 不应修改 |
| `dispose` | ❌ | 生命周期管理，session 不应控制 |
| `auth` | ❌ | 认证级别过高 |
| `provider` | ❌ | Provider 配置级别过高 |
| `experimental.provider.small_model` | ❌ | Provider 级配置 |
| `experimental.compaction.autocontinue` | ❌ | 实例级行为控制 |
| `tool` (对象语法) | ❌ | 工具注册走 Session Tools 机制 |

---

## 七、核心实现：Trigger 扩展

### 7.1 现状

`Plugin.trigger`（`plugin/index.ts:277-290`）遍历 `InstanceState` 初始化时收集的静态 hooks：

```ts
const trigger = Effect.fn("Plugin.trigger")(function* (name, input, output) {
  const s = yield* InstanceState.get(state)
  for (const hook of s.hooks) {
    const fn = hook[name]
    if (fn) yield* Effect.promise(() => fn(input, output))
  }
  return output
})
```

不感知 sessionID，无法按 session 隔离 hooks。

### 7.2 扩展方案

在 trigger 末尾追加 session 级 hooks 遍历：

```ts
const trigger = Effect.fn("Plugin.trigger")(function* (name, input, output) {
  const s = yield* InstanceState.get(state)

  // 1. 实例级 hooks（现有逻辑不变）
  for (const hook of s.hooks) {
    const fn = hook[name]
    if (!fn) continue
    yield* Effect.promise(() => fn(input, output).catch(() => {}))
  }

  // 2. session 级 hooks（新增）
  const sessionID = extractSessionID(input)
  if (sessionID && sessionPluginSvc && Flag.OPENCODE_DATABASE_URL) {
    const hooks = yield* getSessionHooks(sessionID, name).pipe(
      Effect.catch(() => Effect.succeed([])),
    )
    for (const fn of hooks) {
      yield* Effect.promise(() => fn(input, output).catch(() => {}))
    }
  }

  return output
})
```

### 7.3 Session Hooks 缓存

避免每次 trigger 都重新 import + 执行 Plugin 函数，按 `sessionID` 缓存解析后的 Hooks 对象：

```ts
// hooks 缓存：sessionID → { code_hash → Hooks }
const sessionHooksCache = new Map<string, Map<string, Hooks>>()

const getSessionHooks = Effect.fn("Plugin.getSessionHooks")(function* (sessionID, hookName) {
  // 检查缓存是否有效（与 DB 行对比）
  const rows = yield* sessionPluginSvc.list(sessionID)
  const enabledRows = rows.filter((r) => r.enabled)

  let cached = sessionHooksCache.get(sessionID)
  const currentHashes = new Set(enabledRows.map((r) => hash(r.code)))

  // 缓存失效：行数变化或 code 变化
  if (cached) {
    const cachedHashes = new Set(cached.keys())
    if (cachedHashes.size === currentHashes.size && [...currentHashes].every((h) => cachedHashes.has(h))) {
      return [...cached.values()]
        .map((h) => h[hookName])
        .filter(Boolean)
    }
  }

  // 重新加载
  cached = new Map()
  const pluginInput = yield* buildPluginInput(ctx)
  for (const row of enabledRows) {
    const plugin = yield* Effect.tryPromise({
      try: () => importPluginCode(row.code),
      catch: () => null as any,
    }).pipe(Effect.catch(() => Effect.succeed(null)))
    if (!plugin) continue
    const hooks = await plugin(pluginInput).catch(() => null)
    if (!hooks) continue
    // 过滤：只保留允许的 hooks
    const filtered = filterHooks(hooks)
    cached.set(hash(row.code), filtered)
  }
  sessionHooksCache.set(sessionID, cached)

  return [...cached.values()]
    .map((h) => h[hookName])
    .filter(Boolean)
})
```

### 7.4 缓存失效

CRUD 操作时清除对应 session 的缓存：

```ts
// upsert / remove / removeAll 成功后
sessionHooksCache.delete(sessionID)
```

### 7.5 sessionID 提取

trigger 的 `input` 参数形状因 hook 类型不同，需要统一提取 sessionID：

```ts
function extractSessionID(input: any): string | undefined {
  return input?.sessionID
    ?? input?.callID   // tool hooks 用 callID 关联 session（需额外映射）
    ?? undefined
}
```

> **注意**：部分 hook 的 input 不直接包含 sessionID（如 `chat.headers` 的 input 是 `{}`）。对于这些 hook，session 级 hook 在当前 prompt 循环上下文中通过外部传入的 sessionID 触发。需要在 trigger 调用点补充 sessionID（prompt.ts 中的 trigger 调用大多已有 sessionID 在作用域内）。

### 7.6 Hook 过滤

```ts
const ALLOWED_HOOKS = new Set([
  "tool.execute.before", "tool.execute.after", "tool.definition",
  "chat.message", "chat.params", "chat.headers",
  "command.execute.before", "shell.env", "permission.ask",
  "experimental.chat.messages.transform", "experimental.chat.system.transform",
  "experimental.session.compacting", "experimental.text.complete",
  "event",
])

function filterHooks(hooks: Hooks): Hooks {
  const result: Hooks = {}
  for (const key of Object.keys(hooks)) {
    if (ALLOWED_HOOKS.has(key)) {
      result[key] = hooks[key]
    }
  }
  return result
}
```

---

## 八、PluginInput 构建

session-plugin 执行时需要 `PluginInput`（与实例级 plugin 共享）。提取为公共构建函数：

```ts
// plugin/index.ts

function buildPluginInput(ctx: InstanceContext): PluginInput {
  return {
    client: createOpencodeClient({ serverUrl: ctx.serverUrl }),
    project: ctx.project,
    directory: ctx.directory,
    worktree: ctx.worktree,
    experimental_workspace: ctx.experimentalWorkspace,
    serverUrl: ctx.serverUrl,
    $: Bun.$,
  }
}
```

实例级 plugin 和 session 级 plugin 使用同一个 `pluginInput`，保证上下文一致性。

---

## 九、HTTP API

### 9.1 端点定义

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/session/:sessionID/plugins` | 列出 session 级 plugins |
| POST | `/session/:sessionID/plugins/create` | 创建/更新 plugin（upsert） |
| DELETE | `/session/:sessionID/plugins/:name` | 删除单个 plugin |
| DELETE | `/session/:sessionID/plugins` | 清空所有 session 级 plugins |

### 9.2 路径常量

```ts
// groups/session.ts
plugins: `${root}/:sessionID/plugins`,
pluginsCreate: `${root}/:sessionID/plugins/create`,
pluginsDelete: `${root}/:sessionID/plugins/:name`,
```

### 9.3 Payload Schema

```ts
const PluginCreatePayload = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  code: Schema.String,
  enabled: Schema.Boolean.optional,
})
```

### 9.4 Handler

```ts
const listPlugins = Effect.fn("SessionHttpApi.plugins")(function* (ctx) {
  yield* requireSession(ctx.params.sessionID)
  const rows = yield* sessionPluginSvc.list(ctx.params.sessionID)
    .pipe(Effect.catch(() => Effect.succeed([])))
  return rows.map((r) => ({ ...r, code: r.code.slice(0, 100) + "..." }))  // 列表不返回完整 code
})

const createPlugin = Effect.fn("SessionHttpApi.pluginsCreate")(function* (ctx) {
  const row = yield* sessionPluginSvc.upsert(ctx.params.sessionID, ctx.payload)
  return row
})

const deletePlugin = Effect.fn("SessionHttpApi.pluginsDelete")(function* (ctx) {
  yield* sessionPluginSvc.remove(ctx.params.sessionID, ctx.params.name)
})

const clearPlugins = Effect.fn("SessionHttpApi.pluginsClear")(function* (ctx) {
  yield* sessionPluginSvc.removeAll(ctx.params.sessionID)
})
```

---

## 十、Event Hook 特殊处理

`event` hook 不通过 `trigger` 执行，而是通过 `events.listen` 订阅事件总线（`plugin/index.ts:248-255`）。

session 级 event hook 需要：
1. **加载时注册**：session plugin 被加载时，注册 event 监听器，过滤 `sessionID` 匹配的事件
2. **卸载时取消**：session plugin 被删除/清空时，取消对应的事件监听

实现方式：在 `getSessionHooks` 加载 session hooks 时，如果 hooks 包含 `event`，注册一个 filtered listener：

```ts
// 伪代码
if (hooks.event) {
  const unsubscribe = yield* events.listen((event) => {
    if (event.sessionID !== sessionID) return Effect.void
    return Effect.sync(() => hooks.event({ event }))
  })
  // 存储 unsubscribe，在缓存失效时调用
}
```

---

## 十一、安全考量

### 11.1 代码执行风险

session-plugin 代码在**主进程中执行**（无沙箱），与 session-tools 相同的风险等级。但 plugin 的影响面更大（可修改请求头、拦截工具调用、变换消息等）。

**缓解措施**：
- Hook 子集白名单过滤（见 6.3）
- 每个 hook 执行包裹 try-catch，单个 plugin 出错不阻断主流程
- 文档明确警告安全风险
- 未来可考虑在 Worker 线程中执行 session-plugin（增加隔离性）

### 11.2 权限

- Plugin CRUD 操作需要 session 级写权限
- Plugin 代码内部触发的工具调用仍受 session 权限规则约束
- `permission.ask` hook 可以修改权限决策，但不绕过系统级 deny

---

## 十二、错误隔离

每个 session-plugin hook 执行独立 try-catch：

```ts
yield* Effect.promise(() =>
  fn(input, output).catch((err) => {
    logWarning("session plugin hook failed", { name: hookName, error: String(err) })
  })
)
```

确保：
- 单个 session-plugin hook 出错不影响其他 hooks
- 不影响实例级 plugin 执行
- 不影响 prompt 循环主流程

---

## 十三、性能考量

| 关注点 | 策略 |
|--------|------|
| hooks 重复加载 | 按 `sessionID + code hash` 缓存，CRUD 时失效 |
| trigger 额外开销 | session 无 plugin 时短路（list 返回空数组即跳过） |
| importPluginCode 编译 | 按 code 字符串缓存（与 importToolCode 相同） |
| event hook 订阅 | 仅在有 session event hook 时注册，无则零开销 |

---

## 十四、测试计划

### 14.1 单元测试（`test/plugin/session-plugin.test.ts`）

| 用例 | 覆盖点 |
|------|--------|
| T33.1.1 | `set(session, input)` → `get` 返回正确 Row |
| T33.1.2 | `get` 无 plugin → undefined |
| T33.1.3 | `set` → `remove` → `get` → undefined |
| T33.1.4 | `upsert` 同名覆盖 |
| T33.1.5 | `removeAll` 清空 |
| T33.2.1 | 两个 session 隔离 |

### 14.2 E2E 测试（`docs/test-cases/35-session-plugins.md`）

| 用例 | 覆盖点 |
|------|--------|
| T33.3 | API CRUD：创建/列出/删除/清空 |
| T33.4 | PG 持久化验证 |
| T33.5 | session 隔离 |
| T33.6 | 级联删除（删 session → plugins 消失） |
| T33.7 | hook 生效验证（tool.execute.before 修改 args） |
| T33.8 | hook 生效验证（chat.headers 注入 header） |
| T33.9 | hook 生效验证（experimental.chat.system.transform 修改 system prompt） |
| T33.10 | enabled=false 时 hook 不触发 |
| T33.11 | 代码语法错误 → hook 静默跳过（不影响主流程） |
| T33.12 | hook 白名单过滤（config hook 被忽略） |
| T33.13 | 缓存失效（更新 code 后新 hook 生效） |
| T33.14 | event hook 按(sessionID 过滤 |

---

## 十五、实现步骤

1. **数据层**：创建 `session-plugin.ts`（Schema + Service + 三层 Layer）+ `session-plugin.pg.ts` + migration SQL
2. **动态加载**：实现 `importPluginCode`（复用 importToolCode 模式）
3. **Trigger 扩展**：修改 `plugin/index.ts`，添加 session 级 hooks 遍历 + 缓存 + 白名单过滤
4. **HTTP API**：添加 4 个端点到 groups/handlers/server
5. **单元测试**：状态机 + 多 session 隔离
6. **E2E 测试**：CRUD + hook 生效 + 安全限制
7. **文档**：使用文档 + 测试用例 + 索引更新

---

## 十六、沙箱执行模式（架构演进）

> 当前实现（一至十五章）是 **V1 server 进程模式**——plugin 在 SaaS server 容器中 `import()` 加载执行。
> 本章描述 **V2 沙箱执行模式**——plugin 在每个 session 对应的沙箱里执行，server 只做 HTTP 转发。

### 16.1 V1 现状问题

| 问题 | 严重度 | 根因 |
|------|--------|------|
| **plugin 在 server 进程跑** | 🔴 | `importPluginCode` 和 `importPlugins` 在 server 容器里 `import()`（行 47、63） |
| **依赖必须在 server 容器安装** | 🔴 | server 容器没有 npm，context-mode 只装在沙箱镜像 |
| **trigger 丢弃 hook 返回值** | 🔴 | `trigger` 遍历 hook 但最终返回原始 output（行 170），hooks 无法修改数据流 |
| **加载失败完全静默** | 🟡 | `importPlugins` 失败返回 undefined，被跳过（行 144-156），用户无感知 |
| **moduleCache 全局共享** | 🟡 | `moduleCache`（行 36）按 code 字符串缓存，跨 session 共享实例 |
| **无超时控制** | 🟡 | hook 执行无超时（行 166），卡住会阻塞整个工具调用链路 |

### 16.2 V2 架构设计

```
AI 工具调用
    ↓
SaaS server 接收
    ↓
server hooks 链（tool.execute.before）
    ↓
┌──────────────────────────────────────────────┐
│ SandboxPluginRuntime（server 侧）             │
│  HTTP POST → 沙箱直连 IP:9200/hook/{name}     │
│  同步等待返回（5s 超时，超时则 fail open）     │
└──────────────────────────────────────────────┘
    ↓ (HTTP over sandbox IP)
┌──────────────────────────────────────────────┐
│ 沙箱                                         │
│  plugin-agent（常驻 HTTP 服务 on :9200）       │
│  ├── 加载 session plugins（import 在沙箱里）   │
│  ├── 注册 hooks                               │
│  ├── FTS5 存储（~/...context-mode/）          │
│  └── HTTP endpoints:                         │
│      POST /hook/{hookName}                    │
│      → 执行 hook handler                      │
│      → 返回修改后的 result（含 intercept）     │
│      GET /health                              │
└──────────────────────────────────────────────┘
    ↓ (hook 返回值)
server 根据 agent 返回值决定：拦截 / 修改 output / 放行
    ↓
转发到沙箱执行命令（原有 exec 路径不变）
    ↓
server hooks 链（tool.execute.after）
    ↓ (同上 HTTP 通信)
返回 AI
```

### 16.3 跟 Local MCP 的区别

| 维度 | Local MCP（supergateway） | V2 Session Plugin（plugin-agent） |
|------|---|---|
| **触发方** | AI 主动调用 MCP 工具 | **Server 被动触发** hooks |
| **协议** | MCP JSON-RPC（tools/call） | **自定义 hooks HTTP API** |
| **AI 感知** | AI 知道有 ctx_* 工具 | **AI 不知道 hooks 存在**（透明拦截） |
| **拦截能力** | ❌ 不拦截其他工具 | **✅ 拦截/修改任何工具的输入/输出** |
| **supergateway** | 需要（stdio ↔ HTTP 桥接） | **不需要**（plugin-agent 直接开 HTTP） |
| **生命周期** | 跟沙箱绑定（connectSandboxLocal 管理） | 跟沙箱绑定（SandboxPluginRuntime 管理） |

> supergateway 解决的是 MCP 协议桥接问题（stdio ↔ HTTP），**不适用于 plugin hooks**——hooks 不是 AI 主动调用的工具，而是 server 内部事件的被动处理器。

### 16.4 plugin-agent 脚本

预装到沙箱镜像 `/opt/sandbox-plugin-agent.ts`，通过 exec background 启动：

```typescript
// /opt/sandbox-plugin-agent.ts（预装到沙箱镜像）
// 接收 plugins JSON 通过环境变量传入，加载后在 :9200 开 HTTP 服务

const PORT = parseInt(process.env.PLUGIN_AGENT_PORT || "9200")
const SESSION_ID = process.env.SESSION_ID || ""
const PLUGINS = JSON.parse(process.env.PLUGINS_JSON || "[]")

// 1. 加载所有 plugin
const hookHandlers = new Map<string, Function[]>()

for (const plugin of PLUGINS) {
  try {
    let mod
    if (plugin.source === "npm") {
      mod = await import(plugin.spec)
    } else {
      const tmp = `/tmp/spa-${Date.now()}.ts`
      await Bun.write(tmp, plugin.code)
      mod = await import(tmp)
    }

    // 找到 server plugin function（跟 importPlugins 逻辑一致）
    let fn
    if (typeof mod.default === "function") fn = mod.default
    else if (mod.default?.server) fn = mod.default.server
    else {
      for (const v of Object.values(mod)) {
        if (typeof v === "function") { fn = v; break }
        if (v && typeof v === "object" && typeof v.server === "function") { fn = v.server; break }
      }
    }
    if (!fn) throw new Error(`No server plugin in ${plugin.name}`)

    // 调用 plugin function 获取 hooks
    const context = { sessionID: SESSION_ID, workdir: "/workspace" }
    const hooks = await fn(context)
    for (const [name, handler] of Object.entries(hooks)) {
      if (typeof handler !== "function") continue
      if (!hookHandlers.has(name)) hookHandlers.set(name, [])
      hookHandlers.get(name)!.push(handler)
    }
    console.error(`[plugin-agent] loaded: ${plugin.name}`)
  } catch (e) {
    console.error(`[plugin-agent] load failed: ${plugin.name}: ${e}`)
  }
}

// 2. HTTP server
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    // 健康检查
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", plugins: PLUGINS.length, hooks: [...hookHandlers.keys()] })
    }

    // hooks endpoint: POST /hook/{hookName}
    if (url.pathname.startsWith("/hook/")) {
      const hookName = url.pathname.replace("/hook/", "")
      const handlers = hookHandlers.get(hookName) || []
      const body = await req.json()

      let result = body.output ?? body
      for (const handler of handlers) {
        try {
          const ret = await Promise.race([
            handler(body.input, body.output),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
          ])
          if (ret !== undefined && ret !== null) result = ret  // hook 返回值覆盖 result
        } catch (e) {
          console.error(`[plugin-agent] hook ${hookName} error: ${e}`)
        }
      }
      return Response.json({ result })
    }

    return new Response("Not found", { status: 404 })
  },
})
console.error(`[plugin-agent] listening on :${PORT}`)
```

**关键设计**：
- hook 返回值非 undefined/null 时**覆盖 result**（修复 V1 trigger 返回值丢弃问题）
- 每个 hook 有 **5s 超时**（修复 V1 无超时问题）
- 加载失败只 `console.error`（不崩溃，继续加载其他 plugin）

### 16.5 通信协议

```
Server → Agent（HTTP POST）:
POST http://<sandbox-ip>:9200/hook/tool.execute.before
Content-Type: application/json
{"input":{"tool":"bash","input":{"command":"rg --files | wc -l"}},"output":null}

Agent → Server（HTTP Response）:
{"result":null}                           ← 放行（不拦截）
{"result":{"intercept":true,...}}         ← 拦截（替换输出）

POST http://<sandbox-ip>:9200/hook/tool.execute.after
{"input":{"tool":"bash"},"output":"<56KB raw data>"}

{"result":"已索引到 FTS5，3 条匹配"}        ← 替换原始输出（56KB → 摘要）

POST http://<sandbox-ip>:9200/hook/experimental.chat.system.transform
{"input":null,"output":"<system prompt>"}

{"result":"<system prompt + routing rules>"}  ← 修改后的 system prompt
```

### 16.6 SandboxPluginRuntime（server 侧改造）

替代当前 `session-plugin-runtime.ts` 中的 `importPlugins` + `importPluginCode`：

```typescript
// session-plugin-runtime.ts（V2 新增）

class SandboxPluginRuntime implements Runtime {
  private agentUrl: string | null = null
  private starting: Promise<void> | null = null

  constructor(
    private sessionID: SessionID,
    private sandboxProvider: SandboxProvider,
    private store: SessionPlugin.Service,
  ) {}

  // lazy 启动 plugin-agent（参考 connectSandboxLocal 的模式）
  private async ensureAgent(): Promise<void> {
    if (this.agentUrl) return
    if (this.starting) { await this.starting; return }
    this.starting = this.startAgent()
    await this.starting
  }

  private async startAgent(): Promise<void> {
    // 1. 从 PG 读 plugin 列表
    const rows = await this.store.list(this.sessionID)
    const enabled = rows.filter(r => r.enabled)
    if (!enabled.length) return  // 无 plugin，不启动 agent

    // 2. 构造 plugins JSON
    const pluginsJson = JSON.stringify(enabled.map(r => ({
      name: r.name,
      source: r.source,
      spec: r.spec,
      code: r.code,
    })))

    // 3. 在沙箱里启动 plugin-agent（exec background，跟 supergateway 一致）
    await this.sandboxProvider.runInSession(this.sessionID,
      `pkill -f "bun.*sandbox-plugin-agent" 2>/dev/null; sleep 0.5; ` +
      `SESSION_ID=${this.sessionID} PLUGINS_JSON='${pluginsJson}' ` +
      `nohup bun /opt/sandbox-plugin-agent.ts > /tmp/plugin-agent.log 2>&1 &`
    )

    // 4. 拿沙箱直连 URL（跟 connectSandboxLocal 一致）
    const endpoint = await this.sandboxProvider.getEndpoint(this.sessionID, 9200)
    this.agentUrl = endpoint
  }

  // trigger 实现：HTTP POST 到 agent
  async trigger<Output>(name: string, input: unknown, output: Output): Promise<Output> {
    await this.ensureAgent()
    if (!this.agentUrl) return output  // 无 agent（无 plugin），直接返回

    try {
      const resp = await fetch(`${this.agentUrl}/hook/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, output }),
        signal: AbortSignal.timeout(5000),  // 5s 超时
      })
      if (!resp.ok) return output
      const data = await resp.json()
      // hook 返回值覆盖 output（修复 V1 trigger 返回值丢弃问题）
      return (data.result ?? output) as Output
    } catch {
      return output  // fail open（超时/连接失败 → 放行）
    }
  }

  // 其他方法（event/auth/tools/dispose）同样走 HTTP
  async event(input: unknown): Promise<void> {
    await this.ensureAgent()
    if (!this.agentUrl) return
    try {
      await fetch(`${this.agentUrl}/hook/event`, {
        method: "POST", body: JSON.stringify({ input, output: null }),
        signal: AbortSignal.timeout(3000),
      })
    } catch {}
  }

  async dispose(): Promise<void> {
    // 沙箱销毁时 agent 自然清理；这里可选发 /shutdown
    this.agentUrl = null
  }
}
```

**跟 V1 的关键改进**：
- **trigger 返回值生效**：`return (data.result ?? output) as Output` ← hooks 能修改输出
- **5s 超时**：`AbortSignal.timeout(5000)` ← 不会卡住工具调用链路
- **fail open**：连接失败/超时 → 返回原始 output ← 不阻塞 AI
- **lazy 启动**：第一次 trigger 时才启动 agent ← 无 plugin 时零开销

### 16.7 endpoint 获取（参考 connectSandboxLocal）

plugin-agent 监听 `:9200`，server 通过 `sandboxProvider.getEndpoint` 获取直连 URL：

```typescript
// 跟 mcp/index.ts:735 完全一致的模式
const endpointUrl = yield* sandboxProvider.getEndpoint(sessionID, 9200)
// 返回类似：http://10.12.11.x:9200（沙箱 Pod IP）
```

> endpoint API 已有实现（`/session/:id/endpoint/:port`），复用即可。

### 16.8 生命周期

| 事件 | 动作 | 跟 V1 的区别 |
|------|------|-------------|
| **plugins/create** | 写 PG（已有） | 不变 |
| **第一次 trigger** | lazy 启动 plugin-agent | V1 直接 import；V2 exec background 启动 agent |
| **后续 trigger** | HTTP POST 到 agent | V1 函数调用；V2 HTTP 调用 |
| **plugins 更新** | 清缓存（已有），下次 trigger 重启 agent | V1 清 moduleCache；V2 重启 agent |
| **沙箱 idle 回收** | agent 跟着销毁 | V1 server 进程的 hooks 仍在；V2 agent 自然消失 |
| **沙箱重建** | 下次 trigger lazy 重启 agent | V1 不受影响；V2 自动恢复 |
| **session 结束** | 清理 PG + dispose | 不变 |

### 16.9 Dockerfile 改动

```dockerfile
# packages/opencode/docker/Dockerfile

# ── 8d. Pre-install sandbox-plugin-agent ──
COPY docker/opt/sandbox-plugin-agent.ts /opt/sandbox-plugin-agent.ts
```

> plugin-agent 只是一个 .ts 脚本（用 Bun 跑），不需要额外依赖。plugin 依赖（如 context-mode）在 8c 步骤已预装。

### 16.10 全局 plugin 不变

全局 plugin（通过 `PluginLoader` 在 server 启动时加载）**不受影响**，继续在 server 进程里跑。只有 **session plugin** 走沙箱执行模式。

```typescript
// session-plugin-runtime.ts

// 判断是否走沙箱模式
const isSandboxMode = Flag.OPENCODE_DATABASE_URL && sandboxProvider

if (isSandboxMode) {
  // V2：SandboxPluginRuntime（沙箱里跑）
  runtime = new SandboxPluginRuntime(sessionID, sandboxProvider, store)
} else {
  // V1：当前逻辑（server 进程跑，fallback）
  runtime = yield* load(sessionID, context)
}
```

### 16.11 实现计划

| 阶段 | 任务 | 文件 |
|------|------|------|
| **Phase 1** | 写 plugin-agent 脚本 | `docker/opt/sandbox-plugin-agent.ts` |
| **Phase 2** | Dockerfile 预装 | `docker/Dockerfile`（COPY agent + 已有 context-mode 预装） |
| **Phase 3** | 改 session-plugin-runtime.ts | 新增 `SandboxPluginRuntime` + endpoint 获取 + trigger 返回值修复 |
| **Phase 4** | 构建镜像 + 测试 | `opencode-opensandbox:local` 重建 + context-mode plugin 测试 |
| **Phase 5** | 修复 V1 遗留问题 | trigger 返回值（全局也修）+ moduleCache 按 sessionID 隔离 + 加载失败非静默 |

### 16.12 兼容性

| 场景 | V1（server 进程） | V2（沙箱执行） |
|------|---|---|
| **非 SaaS 模式**（无 DATABASE_URL） | 继续用 V1（importPluginCode） | 不走 V2（无沙箱） |
| **SaaS + 无沙箱** | 继续用 V1 | 不走 V2 |
| **SaaS + 有沙箱** | 可选 V1（fallback）或 V2 | **推荐 V2** |
| **全局 plugin** | 不受影响 | 不受影响 |
