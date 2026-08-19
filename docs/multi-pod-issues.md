# 多 Pod（多实例）部署改造

本仓库 SaaS 部署为多副本（K8s 多 Pod）共享同一 PG。历史实现中互斥、事件分发、缓存失效都在 Pod 内存里，多 Pod 存在正确性问题。本文记录问题清单、已落地的修复、以及剩余已知限制。

## 问题清单与状态

| # | 问题 | 状态 |
|---|---|---|
| 1 | session 锁是内存 Map，跨 Pod 无互斥 | ✅ 已修复：PG advisory lock |
| 2 | SSE 事件流基于内存 Bus，跨 Pod 收不到 | ✅ 已修复：PG LISTEN/NOTIFY 桥 |
| 3 | Auth/config 变更只 dispose 本 Pod 缓存 | ✅ 已修复：dispose.all 广播 |
| 4 | per-session 沙箱命令队列是内存 Semaphore | ✅ prompt/shell/exec 统一走 cluster session lock |
| 5 | run 状态内存态，跨 Pod 无法取消 | ✅ PG generation + NOTIFY/poll 路由到 owner Pod |
| 6 | idle-reap / zombie 扫描全实例竞争（配置漂移时互相抢先回收） | ❌ 未做（部署层面统一配置缓解） |
| 7 | 迁移并发（多 Pod 同时启动跑 migration） | ✅ 原本就用 `pg_advisory_lock(20191001)` 保护 |

## 已落地修复

### 1. 跨 Pod session 锁（`handlers/session-lock.ts`）

- `withSessionLock` 改用 **PG advisory lock**（`pg_try_advisory_lock`，key = sessionID 的 FNV-1a 64-bit hash），轮询获取（100ms 间隔），超时 `OPENCODE_SESSION_LOCK_TIMEOUT_SEC`（默认 120s，超时 die 带明确错误）。
- advisory lock 绑定连接，因此使用**专用连接池**（默认 max 8，可配置、`idle_timeout/max_lifetime = null`）；每个持锁 session 独占一条 reserved 连接。
- **Pod 崩溃 → 连接断开 → PG 自动释放锁**，无需 TTL/心跳。
- `Effect.acquireUseRelease` 保证 HTTP 断连/Fiber 中断也执行 unlock；reserve 等待包含在整体超时内。
- 专用连接每秒探活；断线会中断业务。unlock/连接异常时通过独立管理连接 `pg_terminate_backend`，避免带锁连接回池或永久吃掉池槽。
- 同 Pod 独立请求也必须竞争 PG 锁，不再使用会把并发误判为“嵌套”的全局 `held` Map。当前调用链不允许同 Fiber 嵌套获取同 session 锁。
- session remove/update/init/summarize/shell/revert、消息/part 修改、同步/异步 exec、exec repair 都纳入同一锁边界。
- 原「HTTP 层 waitForSessionLock 无超时」问题随之一并解决。
- 单测：`test/server/session-lock.test.ts`（连本地 `opencode_test` 库；含跨连接互斥、超时用例）。

### 2. PG LISTEN/NOTIFY 总线桥（`bus/pg-notify.ts` + `bus/bus-bridge.ts`）

`PgNotify`（频道 `opencode_event`）+ `BusBridge`：

- **事件跨 Pod 分发**：本 Pod GlobalBus 事件 → NOTIFY 广播；其他 Pod 收到后注入本地 GlobalBus（信封带 `origin` podId，自己发的跳过；注入的事件打 `__fromPgBridge` marker，本地 hook 对带 marker 的事件不再转发——双重回环抑制）。
- **auth/config 热加载广播**：auth trigger 和 PG config row 维护持久 revision；NOTIFY 用于低延迟唤醒，5s revision poll 补偿断线窗口。远端回调绑定实际 HTTP Runtime，不再误清另一套 AppRuntime。
- **全局配置 PG 化**：镜像内配置文件作为只读 base，`PATCH /global/config` 写 `cluster_state(config)` overlay，所有 Pod invalidate 后读取同一份数据。
- **跨 Pod abort**：`session_abort` generation 持久化 sessionID + directory，owner Pod 在正确 InstanceState 中取消 runner；NOTIFY 丢失由 poll 补偿。
- **跨 Pod exec kill**：通知 owner Pod 中断目标 fiber；非 owner stream 保持只读，不会误杀命令。
- LISTEN 使用**专用单连接**（不回收）——之前复用 Database 共享池（idle_timeout 30s）导致 LISTEN 被静默回收、桥失联。
- HTTP 端口先绑定，再后台启动 LISTEN 重试；server scope 结束时移除 listener、UNLISTEN 并关闭连接。
- 单测：`test/bus/bus-bridge.test.ts`。

### 3. instance SSE 改监听 GlobalBus（`handlers/event.ts`）

instance 级 `/event` SSE 原来只听内存 EventV2 PubSub（跨 Pod 事件永远收不到）。改为监听 GlobalBus（按 directory/workspace 过滤）：

- 本地事件：EventV2 → EventV2Bridge → GlobalBus（原有路径不变）
- 远程事件：PG NOTIFY → bus-bridge → GlobalBus
- 单一订阅路径覆盖两种来源，无重复投递。
- listener 在发送 `server.connected` 前立即注册；`server.instance.disposed` 不再双路重复。
- 每客户端使用 1024 sliding queue，慢客户端不会无限占内存；内部 `sync` envelope 不暴露给 instance SSE。

## 新环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENCODE_SESSION_LOCK_TIMEOUT_SEC` | `120` | 等待跨 Pod session 锁的超时；超时请求 500（错误信息指明"another pod is likely still processing"） |
| `OPENCODE_SESSION_LOCK_POOL_SIZE` | `8` | 每 Pod 可同时持有的 session cluster lock 数；应与 Pod 最大并发 run 对齐 |

## 已知限制（多 Pod 下仍存在）

1. **PG failover fencing**：锁连接断线后业务最多约 1s 才被探活中断；严格意义上仍存在旧 owner 与新 owner 短暂重叠窗口。要做到零窗口，需把 fencing token 校验下沉到所有 session 写入。
2. **普通小 SSE 事件仍是实时 at-most-once**：LISTEN 短暂断线可能漏实时通知，客户端应重新 GET session/messages；超 8KB 事件已通过 `cluster_bus_event` 引用转发并保留 10 分钟。
3. **跨 Pod exec stream**：实时 stdout queue 仍在 owner Pod 内存；请求落到非 owner Pod 返回 409，客户端可轮询 PG-backed status。kill 已可跨 Pod。
4. **idle-reap / zombie 扫描**：所有 Pod 都扫共享 PG，配置必须全 Pod 一致；已增加 `(state, keep_alive, time_updated)` 索引减少重复扫描成本。
5. **版本兼容**：旧 Pod 不理解 cluster lock/bridge，不能与新版本滚动混跑。首次升级必须使用 Recreate/停流发布；后续协议兼容版本才可滚动。

## 部署要求

- 所有 Pod 连**同一个 PG**（`OPENCODE_DATABASE_URL` 一致）。
- PG 连接预算按默认约 **31/Pod**：Database 20 + lock 8 + lock admin 1 + notify/query 1 + postgres.js LISTEN 专线 1；另留迁移和运维余量。
- 首次部署该改造采用 `strategy: Recreate`（或先缩容旧版本到 0），禁止新旧版本混跑。
- 数据库/沙箱地址、密码、API key 必须通过 K8s Secret/env 注入；Dockerfile 不再内置生产凭证或 insecure sandbox 默认值。
- 需要客户端 SSE 实时性的场景不再依赖 ingress session 亲和（事件经 PG 派发），但**同 session 请求仍建议亲和**（省去锁等待、沙箱 claim 竞争）。

## 测试

- 单测：`test/server/session-lock.test.ts`、`test/bus/bus-bridge.test.ts`（真实本地 PG；覆盖同 Pod 并发、中断、池满超时、UTF-8 大事件引用、漏 NOTIFY revision/abort 补偿、exec kill 路由）：
  ```bash
  OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:5432/opencode_test \
  OPENCODE_SESSION_LOCK_TIMEOUT_SEC=1 \
    bun test test/server/session-lock.test.ts test/bus/bus-bridge.test.ts
  ```
- 集成用例（双实例验证锁互斥/广播/SSE 互通）：`docs/test-cases/multi-pod/`
