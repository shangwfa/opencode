# opencode LCM(Lossless Context Management)无损上下文管理 — 技术实现方案

> 状态:草案 v2,待评审
> 范围:M1~M4 完整移植(参考 Volt/Martian-Engineering)
> 存储:复用现有 **drizzle PG 基础设施**(非 Volt 式自建)
> 默认行为:关闭(`compaction.mode: "default"`),完全不影响现有功能

---

## 1. 背景与目标

### 1.1 现状问题

opencode 现有上下文管理(`compaction.ts` + `message-v2.ts`)是**大小/时间驱动**的:

- 触发:`isOverflow()` 单阈值(token 用量 ≥ usable)
- 裁剪:`select()` 保留最近 `tail_turns`(默认 2)轮,其余整个压成单层摘要
- 投影:`filterCompacted()` 重排为 `[摘要 + tail + 新消息]`,head 原始消息静默消失
- 召回:无工具,压缩后旧内容对模型不可见

三个核心缺陷:
1. **同步阻塞**:压缩时截停 LLM 流(`stream.takeUntil(needsCompaction)`),用户等待
2. **不可召回**:被压缩的内容对模型不可见,无法按需找回细节
3. **单层摘要**:多轮压缩后信息逐层丢失,无归档/指针机制

### 1.2 目标

在 opencode 内实现 Volt LCM 的核心闭环,**独立于现有实现**,通过配置切换:

- 多 lane token 预算 + 滞回(hysteresis)控制
- 异步压缩(轮间后台,不阻塞)
- Summary DAG(sprig → bindle → archive_stub)
- Ghost cue(离线内容的在线提示)
- 检索工具(lcm_describe / lcm_expand / lcm_grep)
- Postgres 持久化(复用现有 drizzle PG 基建)

### 1.3 硬性约束

1. **独立实现**:新模块 `src/session/lcm/`,不修改现有 `compaction.ts` 主路径
2. **配置可选**:`compaction.mode: "default" | "lcm"`,默认 `default`,lcm 模式零启用成本
3. **所有集成点受 mode 门控**:default 模式行为逐字节不变
4. **不重复造轮子**:
   - 消息权威存储 → 现有 opencode SQLite / PG(dialect 按 `OPENCODE_DATABASE_URL` 自动切换)
   - PG 连接 → 复用 `storage/db.pg.ts`(postgres + drizzle postgres-js)
   - 核心 DB 服务 → 复用 `storage/db-core-bridge.ts`(PG → Effect Database.Service)
   - 摘要生成 → 复用 compaction agent

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│                        opencode Session 循环                          │
│  prompt.ts loop → processor → LLM stream → 事件 → 持久化              │
└──────────────┬───────────────────────────────────────────────────────┘
               │ mode 门控 (compaction.mode === "lcm")
        ┌──────▼──────┐      ┌─────────────────────────────────────────┐
        │ mode=default│      │ mode=lcm: SessionLCM 引擎                │
        │ (现有路径)   │      │                                         │
        └─────────────┘      │ ① token-budget  多 lane 阈值 + 滞回       │
                             │ ② context        活跃上下文组装(替代     │
                             │                   filterCompacted)        │
                             │ ③ condense       异步压缩(DAG 写入)      │
                             │ ④ ghost-cue      归档时生成在线提示       │
                             │ ⑤ store          PG 数据访问(drizzle)    │
                             │ ⑥ tools          lcm_describe/expand/grep│
                             └───────────────┬─────────────────────────┘
                                             │
                          ┌──────────────────▼─────────────────────────┐
                          │ 现有 drizzle PG 基建(复用)                  │
                          │  postgres 包 + drizzle postgres-js         │
                          │  db-core-bridge → Effect Database.Service  │
                          │  + 新增 lcm_* 表(pg-core)                   │
                          └────────────────────────────────────────────┘
```

### 2.1 职责划分

| 层 | 归属 | 说明 |
|---|---|---|
| 消息权威存储 | 现有 opencode 存储(dialect 自动切) | 原始消息永不失真;PG 模式即 SaaS 库 |
| LCM DAG 存储 | 现有 PG 库 + 新增 `lcm_*` 表 | context_items + summaries + lineage,引用消息 ID |
| 活跃上下文组装 | LCM context 模块 | 决定每轮发哪些内容(替代 filterCompacted) |
| 压缩触发 | LCM token-budget | 替代 isOverflow(仅 lcm 模式) |
| 召回 | LCM tools | lcm_describe / lcm_expand / lcm_grep |

> **关键设计决策**:LCM 组织层与现有数据**同库**(新增 `lcm_*` 表),不建独立连接。
> 消息仍由现有存储层持有("无损"依赖它),PG 只存 LCM 的物化视图 + DAG + 指针。
> SQLite 本地模式也可启用 lcm(PG 表定义与 SQLite 无关,仅当 `OPENCODE_DATABASE_URL` 设置时使用),但推荐在 PG(SaaS)环境使用。

---

## 3. 配置设计

### 3.1 配置项(`packages/core/src/v1/config/config.ts`)

```ts
compaction: Schema.optional(
  Schema.Struct({
    // ...现有字段(不变)...
    auto: Schema.Boolean,
    prune: Schema.Boolean,
    tail_turns: NonNegativeInt,
    preserve_recent_tokens: NonNegativeInt,
    reserved: NonNegativeInt,

    // 新增:
    mode: Schema.optional(Schema.Literal("default", "lcm")).annotate({
      description: "Context management mode. 'default' keeps legacy behavior. 'lcm' enables lossless context management (default: default)",
    }),
  }),
)
```

### 3.2 运行环境(LCM 参数,环境变量)

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENCODE_DATABASE_URL` | 无 | **复用现有开关**:设置后 dialect=pg,LCM 表建在此库 |
| `OPENCODE_LCM_MODE` | `upward` | `upward`(仅活跃 DAG)/ `dolt`(支持离线检索) |
| `OPENCODE_LCM_CTX_CUTOFF_THRESHOLD` | 0.75 | 软阈值(窗口比例) |
| `OPENCODE_LCM_TARGET_FREE_PERCENTAGE` | 0.05 | 压缩后保留空闲比例 |
| `OPENCODE_LCM_MIN_PROTECTED_TAIL_LEAVES` | 5 | 受保护新鲜尾部条数 |
| `OPENCODE_LCM_SUMMARY_MAX_OUTPUT_TOKENS` | 1200 | sprig 摘要上限 |
| `OPENCODE_LCM_CONDENSE_MAX_OUTPUT_TOKENS` | 1200 | bindle 摘要上限 |
| `OPENCODE_LCM_PRE_RESPONSE_HOOK_TOP_K` | 3 | ghost cue 检索 top-k |

---

## 4. 数据模型(新增 `lcm_*` 表,复用现有 PG 库)

### 4.1 表定义(风格对齐 `session.pg.ts`,drizzle `pg-core`)

文件:`packages/opencode/src/session/lcm/schema.pg.ts`

```ts
import { pgTable, text, bigint, integer, boolean, unique } from "drizzle-orm/pg-core"
import { Timestamps } from "../../storage/schema.pg"

// LCM 会话元数据,外键到现有 session 表
export const LcmConversationTable = pgTable("lcm_conversation", {
  id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  session_id: text().notNull().unique().references(() => SessionTable.id, { onDelete: "cascade" }),
  parent_session_id: text(),
  title: text(),
  model_name: text(),
  model_ctx_max_tokens: integer(),
  ctx_cutoff_threshold: doublePrecision(),
  ...Timestamps,
})

// 消息引用(不存正文,引用现有 message id)
export const LcmMessageTable = pgTable("lcm_message", {
  message_id: text().primaryKey().references(() => SessionMessageTable.id, { onDelete: "cascade" }),
  conversation_id: bigint({ mode: "number" }).notNull().references(() => LcmConversationTable.id, { onDelete: "cascade" }),
  seq: integer().notNull(),
  role: text().notNull(),                        // system|user|assistant|tool
  token_count: integer().notNull(),
  lane: text().notNull().default("leaves"),      // leaves|sprigs|bindles
}, (t) => [unique().on(t.conversation_id, t.seq)])

// 活跃上下文物化视图(每轮组装来源)
export const LcmContextItemTable = pgTable("lcm_context_item", {
  id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  conversation_id: bigint({ mode: "number" }).notNull().references(() => LcmConversationTable.id, { onDelete: "cascade" }),
  position: integer().notNull(),
  item_type: text().notNull(),                   // message|summary|ghost_cue
  message_id: text(),
  summary_id: text(),
  off_context: boolean().notNull().default(false),
}, (t) => [unique().on(t.conversation_id, t.position)])

// 摘要 DAG 节点
export const LcmSummaryTable = pgTable("lcm_summary", {
  summary_id: text().primaryKey(),               // 'sum_' + sha256[:16]
  conversation_id: bigint({ mode: "number" }).notNull().references(() => LcmConversationTable.id, { onDelete: "cascade" }),
  kind: text().notNull(),                        // sprig|bindle
  summary_level: text().notNull(),               // d1/d2/dN
  condensation_order: integer().notNull(),
  summary_type: text().notNull(),                // sprig|bindle|archive_stub
  content: text().notNull(),
  token_count: integer().notNull(),
  is_off_context: boolean().notNull().default(false),
  ...Timestamps,
})

// sprig: 覆盖的消息
export const LcmSummaryMessageTable = pgTable("lcm_summary_message", {
  summary_id: text().notNull().references(() => LcmSummaryTable.summary_id, { onDelete: "cascade" }),
  message_id: text().primaryKey().references(() => SessionMessageTable.id, { onDelete: "cascade" }),
})

// bindle: 聚合的子摘要
export const LcmSummaryParentTable = pgTable("lcm_summary_parent", {
  summary_id: text().notNull().references(() => LcmSummaryTable.summary_id, { onDelete: "cascade" }),
  parent_summary_id: text().notNull().references(() => LcmSummaryTable.summary_id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.summary_id, t.parent_summary_id] })])

// lineage 指针(归档遍历)
export const LcmSummaryLineagePointerTable = pgTable("lcm_summary_lineage_pointer", {
  summary_id: text().notNull().references(() => LcmSummaryTable.summary_id, { onDelete: "cascade" }),
  points_to_summary_id: text().notNull().references(() => LcmSummaryTable.summary_id, { onDelete: "cascade" }),
  pointer_kind: text().notNull(),                // archive_stub|archive_full|lineage_parent
  ord: integer().notNull(),
}, (t) => [primaryKey({ columns: [t.summary_id, t.points_to_summary_id, t.pointer_kind] })])

// 大文件(超阈值不进上下文)
export const LcmLargeFileTable = pgTable("lcm_large_file", {
  file_id: text().primaryKey(),                  // 内容寻址
  conversation_id: bigint({ mode: "number" }).references(() => LcmConversationTable.id, { onDelete: "cascade" }),
  path: text().notNull(),
  token_count: integer().notNull(),
  exploration_summary: text(),
})
```

### 4.2 迁移与访问

- **迁移**:新增 `src/session/lcm/schema.pg.ts` 后,由现有迁移机制(`data-migration.pg.ts` / drizzle migrate)注册建表。PG 模式启动时自动应用。
- **数据访问**:LCM store 通过现有 **`Database.Service`**(core,经 `db-core-bridge` 指向 PG)或 `SaasDb` 执行查询。业务代码写法与现有 `.pg.ts` 一致(drizzle query + `.get()/.all()`)。

---

## 5. 核心模块设计

目录:`packages/opencode/src/session/lcm/`

### 5.1 token-budget.ts — 多 lane 阈值 + 滞回

替代 `overflow.ts` 的单阈值判定(参考 Volt `token-budget.ts`):

```ts
export type LaneName = "leaves" | "sprigs" | "bindles"

export interface LaneThreshold {
  soft: number; delta: number; target: number; minFanout: number
}

export interface Budget {
  overhead: number        // systemPrompt + tools token
  reserve: number         // 输出预留(默认 20K,cap 0.25×context)
  hardLimit: number       // context - overhead - reserve
  softThreshold: number   // min(ctx×cutoff, hardLimit)
  lanePolicy: { leaves: LaneThreshold & { cap: number }; sprigs: LaneThreshold; bindles: LaneThreshold }
}

// 单 lane 判定(滞回 + hard-limit bypass)
export function shouldCompact(input: {
  laneTokens: number; threshold: LaneThreshold
  currentlyCompacting: boolean; hardLimitRisk: boolean
}): boolean {
  const upperBound = input.threshold.soft + input.threshold.delta
  const overUpperBound = input.laneTokens > upperBound
  const overTarget = input.laneTokens > input.threshold.target
  const continuing = input.currentlyCompacting && overTarget && !overUpperBound
  const bypassed = input.hardLimitRisk && overTarget && !overUpperBound
  return overTarget && (overUpperBound || continuing || bypassed)
}
```

**System prompt / tools token 估算**:缓存(按 sessionID + toolSetHash)。

### 5.2 store.ts — PG 数据访问

`namespace LcmStore`,基于 `Database.Service`。接口:

```ts
export namespace LcmStore {
  getOrCreateConversation(sessionID): Promise<number>
  upsertMessage(m: { messageID; conversationID; seq; role; tokenCount; lane }): Promise<void>
  getContextItems(conversationID): Promise<ContextItem[]>
  replaceContextItems(conversationID, items: ContextItem[]): Promise<void>  // 事务原子替换
  createSprig(input): Promise<Summary>      // summaries + summary_messages
  createBindle(input): Promise<Summary>     // summaries + summary_parents
  createArchiveStub(input): Promise<Summary>
  getSummaryById(id, conversationID?): Promise<Summary | null>
  expandSummaryToMessages(id): Promise<MessageRef[]>   // DAG 遍历 → 原始消息
  searchSummariesInLineage(conversationID, query, limit): Promise<Match[]>
  getOrCreateLargeFile(...): Promise<LargeFile>
}
```

### 5.3 context.ts — 活跃上下文组装(替代 filterCompacted)

```
输入: sessionID + model
流程:
1. 读取 lcm_context_items(物化活跃视图)
2. 每条 item:
   - message    → 经现有消息存储加载原始消息(投影规则复用 message-v2)
   - summary    → formatForContext([Summary ID] + content + parents)
   - ghost_cue  → 注入归档 bindle 叙事
3. 按 position 排序 → 返回模型消息数组
4. 统计各 lane token → 交给 token-budget 判定
```

与 `filterCompacted` 的本质区别:活跃视图由压缩过程维护,context 只做物化读取,**不做实时重排**——这是异步压缩可行性的来源。

### 5.4 condense.ts — 异步压缩

```
触发: token-budget 判定 leaves 超阈值 → scheduleThresholdCompaction
执行(后台):
1. 读 context_items,取 leaves 中"非新鲜尾部"(保护最近 N 条)
2. 分批选 leaves → LLM 生成 sprig(summarize,复用 compaction agent)
3. 写 summaries + summary_messages;context_items 中 message → summary
4. sprigs 超阈值 → 选多个 sprig 生成 bindle(summary_parents)
5. bindles 超阈值 → evictOverflowBindles:归档为 archive_stub + 生成 ghost cue
6. 事务原子替换 context_items
```

**异步机制**:
- `scheduleThresholdCompaction()`:软阈值 → `Effect.forkIn(scope)` 后台执行,不截停 LLM 流
- 互斥:会话级 `currentlyCompacting` 标志,同一会话同一时间仅一个压缩任务
- 硬限兜底:总量逼近 hardLimit → 下轮开始前同步 `compactUntilUnderHardLimit`

**三级收敛协议**(参考 Volt `compaction-escalation.ts`):
1. `normal` → 2. `aggressive`(压缩指令)→ 3. `fallback`(**确定性截断**,无 LLM)

### 5.5 ghost-cue.ts

bindle 归档时生成 ≤220 token 叙事,带 frontmatter,注入 `lcm_context_items`(item_type=ghost_cue)。首版用**关键词/全文检索**(Postgres),后续可选向量。

### 5.6 strategy.ts — 调度

```ts
export interface LcmStrategy {
  compactOnThreshold(input): Promise<void>   // 异步(后台 fork)
  compactManual(input): Promise<void>        // /compact
}
```
- `upward`:仅活跃 DAG 凝聚
- `dolt`:归档 + 离线检索(ghost cue + lcm_expand 到归档)

### 5.7 tools/ — 召回工具(仅 lcm 模式注册)

| 工具 | 输入 | 行为 | 调用限制 |
|---|---|---|---|
| `lcm_describe` | summary_id | 摘要元数据(kind/level/off-context/lineage) | 无 |
| `lcm_expand` | summary_id | 展开 → 原始消息(DAG 遍历) | **仅 sub-agent** |
| `lcm_grep` | query | lineage 内关键词检索摘要 | 无 |

`lcm_expand` sub-agent 限制:主会话调用返回指引("请用 Task 派生 sub-agent"),防主上下文无界膨胀。

---

## 6. 与 opencode 的集成点(全部受 mode 门控)

| 文件 | 改动 | 门控 |
|---|---|---|
| `packages/core/src/v1/config/config.ts` | compaction 加 `mode` 字段 | - |
| `packages/opencode/src/session/prompt.ts` | 130:获取 `SessionLCM`;1261:task 分发按 mode 选择;1395:组装按 mode 切换 | `compaction.mode === "lcm"` |
| `packages/opencode/src/session/processor.ts` | 483-488:溢出检测改调 `SessionLCM.shouldCompact`;lcm 模式不同步截停 | 同上 |
| `packages/opencode/src/tool/registry.ts` | lcm 模式注册 lcm_* 工具 | 同上 |
| `packages/opencode/src/project/bootstrap.ts` | lcm 模式启动 LCM 迁移 + 初始化(复用现有 PG 初始化) | 同上 |
| `packages/opencode/src/session/lcm/**` | 全部新增 | - |

**零侵入原则**:default 模式下所有门控走原路径,不连 LCM、不建表、不注册工具。

---

## 7. 控制循环(单轮完整流程)

```
用户消息 → prompt.ts loop
  ├─ mode=lcm?
  │    ├─ 是 → SessionLCM.beginTurn(sessionID)
  │    │       ① token-budget 判定积压压缩 → 先换入已完成结果
  │    │       ② context.assemble() → modelMsgs
  │    │       ③ processor.process(modelMsgs, tools+lcm_tools)
  │    │       ④ 轮次结束 → upsert 消息引用(lcm_message)
  │    │       ⑤ token-budget → 超软阈值 → fork 后台 condense(不阻塞)
  │    └─ 否 → 现有 filterCompacted 路径(不变)
```

---

## 8. 里程碑与验收

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M1 骨架** | 配置 mode + `schema.pg.ts` + 迁移 + token-budget 纯函数 + store 读写 | PG 建表;消息引用写入;`default` 零变化 |
| **M2 异步压缩** | condense 单层 sprig + 异步调度 + context.assemble + 三级收敛 | 长会话 leaves 超阈值后台压缩;用户无等待;无竞态 |
| **M3 DAG+归档** | bindle 上卷 + evict + archive_stub + ghost cue | 多层压缩后原文可展开;归档项以 cue 呈现 |
| **M4 工具** | lcm_describe / lcm_expand(sub-agent 限定)/ lcm_grep | 模型查摘要、sub-agent 展开原文、grep 跨 lineage |

**回归**:`mode:default` 现有测试全绿;`mode:lcm` 长会话无上下文丢失。

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| PG 表与现有库耦合 | SaaS 库迁移 | 复用现有迁移机制;`lcm_*` 前缀独立命名空间 |
| 双库一致性 | 投影错位 | 消息以现有存储为权威;lcm_message 仅引用;seq 单调 |
| 异步压缩竞态 | 上下文错乱 | 会话级互斥锁;硬限转同步 |
| 双投影路径 | 测试面翻倍 | 公共 util 抽取;default 路径不改一行 |
| 摘要 token 开销 | 成本 | 复用 compaction agent;三级收敛兜底 |
| SQLite 本地无 PG | lcm 不可用 | 文档明确:lcm 推荐 PG 环境;SQLite 下自动降级 default |

---

## 10. 依赖

- **零新增运行时依赖**:`postgres` + `drizzle-orm/postgres-js` 已存在(`storage/db.pg.ts`)
- 复用:`db-core-bridge.ts`(Effect 桥)、迁移机制、`SessionTable`/`SessionMessageTable`
- 无嵌入式二进制、无独立连接池

---

## 11. 已确认决策(2026-08-02)

| # | 决策 | 内容 |
|---|---|---|
| 1 | lcm_message 粒度 | 引用 + seq + `token_count`(lane 判定必需)|
| 2 | 摘要模型 | **跟随会话模型**(不用固定 compaction agent)|
| 3 | ghost cue 检索 | 首版关键词检索(Postgres),接口预留向量升级 |
| 4 | `/compact` | lcm 模式走 `compactManual`,default 走旧路径 |
| 5 | leaves lane 粒度 | 消息级(`lcm_message` 行带 lane 字段)|

### 待办(后续确认)

- ghost cue 关键词检索若召回不足 → 升级 pgvector
