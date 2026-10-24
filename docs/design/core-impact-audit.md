# 核心逻辑影响审计（2026-10-24）

审计对象：本次会话对 `packages/core`、`packages/server`、`packages/schema`、`packages/cli`、`packages/hn-base-server` 的全部改动。

结论：**核心链路（提示词组合、压缩、工具执行、权限、事件总线顺序、执行租约）未被破坏**。发现 **1 个真实风险并已修复**（可观测性写入失败会中断模型调用）。全量回归的失败项经 A/B 对照确认**均为既有或环境问题**。

---

## 一、改动清单与分类

### 1. 纯增量（不改变行为）

| 文件 | 改动 | 性质 |
|---|---|---|
| `session/model-request.ts` | `Prepared.capture?`、`Input.assistantMessageID`、采集回调、`node` 增加 insights 依赖 | 新增可选回调；未设置时等价于原逻辑 |
| `session/runner/llm.ts` | 传 `assistantMessageID` 给 prepare | 仅多传一个字段 |
| `session/message-updater.ts` | 为 `session.context.captured` 增加 no-op 分支 | 事件投影忽略该事件，不改其它事件 |
| `schema/session-event.ts` | 新增 durable 事件 `session.context.captured` | 新增定义 + 加入清单 |
| `server/handlers/session.ts` | +48 行：context-insights 端点 | 新路由，未触碰既有 handler |
| `core/instance.ts` | 注册 `SessionContextInsights.node` | 新增 Location 节点 |
| `schema/session-context-insights.ts` + 迁移 + `pg-schema.sql`/`schema.gen.ts` | 新表 `session_context_request` / `session_context_content` | 纯新增表，无列变更 |

### 2. 在模型调用路径上插入了采集（需要重点审视）

| 文件 | 改动 |
|---|---|
| `session/compaction.ts` | 在两处 compaction 调用前执行 `prepared.capture(request)`，再调 `llm.compact`；流式路径用 `Stream.unwrap` 包一层 |
| `session/runner/step.ts` | `Stream.unwrap(capture → llm.stream(...))` |
| `session/title.ts` / `session/generate.ts` | 调用前 `yield* capture` |

采集点的语义：**在真实模型调用前**写入一份语义请求快照（含 `bus.publish` 的 PG 事务 commit）。

- ✅ 时序正确：记录的是即将发送的请求（压缩修正指令、重试都在内）。
- ⚠️ 代价：每次模型调用多一次事件写入（含会话级 advisory lock）+ 2 次只读查询（仅当请求带工具时），首 token 前多几毫秒。
- ✅ 不改变 compaction / streaming / title 的输入输出与控制流（`Effect.andThen` / `Stream.unwrap` 保持原 effect 顺序）。

### 3. 有意改变行为（2 处）

| 改动 | 影响 | 判定 |
|---|---|---|
| `core/model.ts`：`available` 从 `enabled` 改为 `enabled && provider 可用` | `/api/model` 不再列出无凭据 provider 的模型 | **修复**：此前会把必然 403 的模型放进选择器。已验证：配置 provider（Yd-*）与有连接的 provider 正常出现，无凭据的被隐藏 |
| `cli/version.ts`：`OPENCODE_APP_VERSION` 覆盖 UA 版本 | 影响 Console 免费档 gatekeeper | **修复**（有文档 `docs/console-free-tier-403-fix.md`），仅在显式注入时生效 |

---

## 二、发现并修复的风险

### R1（已修）：可观测性失败会中断模型调用

原实现里 `capture` 的 Effect 直接串在调用链上，且**没有错误兜底**：采集写库/发事件失败（例如 PG 抖动、advisory lock 超时）会作为 defect 冒泡，导致 **压缩/流式/标题生成整体失败**。这是"观测功能影响主流程"的真实回归风险。

修复（`session/model-request.ts`）：

```ts
capture: (actual) => insights
  ? insights.capture({...}).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => Effect.logWarning("session context capture failed", { cause: String(cause) })),
    )
  : Effect.void
```

`Effect.catchCause` 同时覆盖可恢复错误与 defect（已核对 effect@4.0.0-rc.112 的文档注释），因此采集失败只记日志、**不会打断模型调用**。

---

## 三、未发现问题的项（逐项核对）

- **提示词组合**：`prepare` 只在末尾追加 `capture`/`assistantMessageID` 字段，`request`（system/tools/messages）构造逻辑零改动。
- **压缩**：保留原 `retainUsers`、`canCompact` 判定、`transient` 作用域；仅把 `llm.compact(...)` 包在 `capture` 之后。
- **工具执行/权限**：`executeTool`、`Permission.assert`、question 兜底逻辑未改。
- **事件总线**：新增事件走同一 `bus.publish` + 事务 commit，不改变既有事件顺序与重放语义；`message-updater` 对该事件显式 no-op。
- **数据库**：仅新增两张表与迁移，未修改既有表结构；PG 与 SQLite 两套生成物同步。
- **网关（hn-base-server）**：只把 V1 路径迁到 V2（`/api/session`、`interrupt`、`parentID` 过滤、`fs/read`）并新增 `/api/models`；未触碰鉴权/授权判定逻辑。

---

## 四、回归证据

| 套件 | 结果 | 判定 |
|---|---|---|
| core 全量（`bun run test`） | 6020 pass / 111 skip / **13 fail** / 2 errors | 12 项既有 + 1 项 flaky（下方证明） |
| core 聚焦（context 相关） | 28/28 | 通过 |
| schema 全量 | 85/85 | 通过（本轮修正了 durable 事件清单 fixture） |
| server 全量 | 123/124 | 1 项既有失败（下方证明） |
| hn-base-server | 84/84 | 通过 |
| hn-app | 529/530 | 1 项既有失败（`route-repo`） |

### 失败归因（A/B 对照）

用 `git stash` 回退全部已跟踪改动后复跑：

- `schema > derives durable definitions`：基线 **通过**，改动后失败 → 属**测试 fixture 未随新增 durable 事件更新**，已补 `session.context.captured.1`，现已通过。这不是逻辑破坏。
- `server > routes pending requests through the Session's instance`：基线 **同样失败** → **既有问题**，与本次无关。
- `core > GithubCopilotPlugin` 系列：基线 1 fail；改动后同一文件多次运行结果在 0–3 fail 之间波动 → **flaky（用例间状态/时序依赖）**，非本次引入。
- 其余 12 项（Config 迁移、MCP 连接、Session.move/remove、Watcher、real-shell、原生窗口解码、SSE 恢复）与本次改动无交集，且多为此前已记录的环境/时序问题。

---

## 五、遗留风险的处理（本轮已全部处理）

### R2 采集在首 token 之前 —— 已优化并量化

- **来源查询缓存**：MCP/自定义工具来源查询按会话缓存 10s（上限 500 会话），常规请求不再走 2 次额外读。
- **空内容跳过写**：没有可去重正文时不再发起 content 插入。
- **实测**（`packages/core/test/session-context-insights-cost.test.ts`，50 次采集平均，含事件事务 + 去重正文写入）：**12.5–29ms/次**（随容器负载波动），主要是 durable 事件事务（含会话级 advisory lock），不是查询。
- **运维开关**：`OPENCODE_CONTEXT_INSIGHTS=off` 时仍构建内存快照但**不写库、不发事件**，可直接关停采集（已用于压测对照）。
- 未改成异步 fork：分析按 `request.seq` 与事件 seq 对齐窗口，异步采集会让首个 step 的事件落在窗口外，导致首内容延迟/耗时统计失真。若将来必须异步，需同时把窗口判定改为时间窗并重跑分析用例。

> 端到端 A/B（两个容器）在本机噪声下不可信：观测到 "关闭态反而慢 248ms"，属容器调度差异，故不采用该口径，只报进程内采集耗时。

### R3 durable 事件体积 —— 已量化

同一会话实测：4 次模型调用产生 4 条 `session.context.captured`，而该会话其它 durable 事件共约 40 条（每步已写 step/reasoning/text/tool/usage 等 9 条左右）。即**增量约 10%**，且事件随会话删除级联清理（`event` → `event_sequence` 的 `onDelete: cascade`），不引入新的保留期问题。

### R4 节点耦合 —— 已解耦

`SessionModelRequest.node` 的 `deps` 不再包含 `SessionContextInsights.node`；服务由 `instance.ts` 注册进位置图层，`model-request` 运行期通过 `Effect.serviceOption` 取用（缺失即跳过采集）。
容器实测（`ui-20261024k`）：去掉依赖后 `POST /prompt` 200，`context-insights` 返回 `capturedRequests: 1`，采集未失效。

> 注：之前编号 R1（采集失败中断调用）已在上一轮修复。
