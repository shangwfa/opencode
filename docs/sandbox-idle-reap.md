# 空闲沙箱定期回收方案

## 一、背景

会话执行任务时可能创建沙箱。现有沙箱销毁机制有三层，但对 `keep_alive=true` 的沙箱存在回收缺口：

| 机制 | 触发时机 | 阈值 | 覆盖 keep_alive? | 位置 |
|------|---------|------|-----------------|------|
| `onIdle` 即时销毁 | Runner 转入 idle | 即时 | ❌ 跳过 | `session/run-state.ts:66-95` |
| 僵尸清理 | 后台周期扫描 | 120 min (`idleKillMs*2`) | ❌ 只扫 `keep_alive=false` | `tool/sandbox-provider.ts:1297-1350` |
| Session 删除 | 显式调用 | 即时 | ✅ | `session/session.ts:660` |

**缺口**：`keep_alive=true` 的沙箱（keep-alive API 或 PTY 活跃触发；历史上 `background=true` 的 bash 命令也曾触发，该自动保活已于 2026-08-25 移除），在会话 idle 后不会被即时销毁，也不会被僵尸清理扫描。需要新增一轮 **60 分钟无活跃即销毁** 的后台扫描，覆盖所有存活沙箱。

## 二、总体架构

```
会话 idle
  │
  ├─ keep_alive=false → onIdle 即时销毁（现有）
  │
  └─ keep_alive=true  → 沙箱保留
        │
        ▼
  Idle Reap 扫描器（新增，每 5 分钟）
        │
        ├─ 查询 SandboxTable: state='running' AND time_updated < now - idleReapMs
        │    （不限 keep_alive，覆盖所有存活沙箱）
        │
        ├─ per-session lock + CAS 二次校验
        │    └─ 防止扫描后沙箱又被活跃使用却被误杀
        │
        ├─ reconnect → destroySandbox（kill + close + dbMarkDestroyed）
        │    └─ reconnect 失败时 bestEffortKill + dbMarkDestroyed
```

## 三、设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 活跃判定依据 | `SandboxTable.time_updated` | 沙箱使用入口主动 touch 该字段，反映最后使用沙箱的时间；只需扫一张表，查询高效 |
| keepAlive 处理 | 全部纳入清理 | 60 分钟无沙箱活动说明用户已不在，应释放资源；与 onIdle/僵尸清理形成互补 |
| 实现位置 | 扩展 `sandbox-provider.ts` pgLayer | 沙箱表查询天然属于 sandbox-provider；复用现有 `lock`/`reconnect`/`destroySandbox`/`dbMarkDestroyed` 基础设施 |
| 适用范围 | 仅 PG 模式 | SQLite 模式用内存 Map 管理，onIdle 即时销毁已覆盖本地场景 |
| 阈值 | 默认 60 分钟，可配置 | 通过 `OPENCODE_SANDBOX_IDLE_REAP_SEC` 环境变量控制 |

## 四、配置变更

### 4.1 新增 Flag

**文件**：`packages/opencode/src/flag/flag.ts`（行 100-101 附近）

```
export const OPENCODE_SANDBOX_IDLE_REAP_SEC = number("OPENCODE_SANDBOX_IDLE_REAP_SEC") ?? 3600
```

### 4.2 SandboxConfig 新增字段

**文件**：`packages/opencode/src/tool/sandbox-provider.ts`

`Interface`（行 14-27）新增：

```
readonly idleReapMs: number
```

`defaultConfig`（行 31-44）新增：

```
idleReapMs: Flag.OPENCODE_SANDBOX_IDLE_REAP_SEC * 1000,
```

## 五、实现变更

**文件**：`packages/opencode/src/tool/sandbox-provider.ts`

新增 `dbTouchSandbox(sessionID, sandboxID)`，在沙箱实际使用入口刷新 `time_updated`，覆盖缓存命中、健康重连、`get`、`runInSession`、`runDetached` 等路径。

在现有僵尸清理之后、scope finalizer 之前，新增一轮 idle reap 扫描。

### 5.1 核心逻辑（伪代码）

```
const idleReapMs = config.idleReapMs

Effect.gen:
  Effect.repeat:
    threshold = Date.now() - idleReapMs

    -- 查询：state=running 且 time_updated 超过阈值（不限 keep_alive）
    rows = SELECT * FROM sandbox
           WHERE state = 'running' AND time_updated < threshold
    if rows.length == 0: return

    log.info("idle sandbox reap scan", { count, thresholdMs: idleReapMs })

    for each row:
      lock(row.session_id):
        -- CAS 二次校验
        current = dbGet(row.session_id)
        if !current || current.id != row.id || current.state != "running": skip
        if current.time_updated > threshold: skip   -- 刚刚活跃了

        -- 直接销毁（lock 内手动执行，不调用 destroy() 以避免信号量重入）
        sb = reconnect(row)
        if sb:
          destroySandbox(sb, row.session_id)    -- kill + close + dbMarkDestroyed
        else:
          bestEffortKill(row.id, row.session_id)
          dbMarkDestroyed(row.session_id, row.id)

  schedule: Schedule.spaced(Duration.seconds(60))
  forkScoped + interruptible
```

### 5.2 关键代码结构

```ts
// 周期性回收空闲 sandbox（含 keep_alive=true，idleReapMs 阈值）
const idleReapMs = config.idleReapMs
yield* Effect.gen(function* () {
  yield* Effect.repeat(
    Effect.gen(function* () {
      const threshold = Date.now() - idleReapMs
      const rows = yield* Effect.tryPromise({
        try: () => pgDb
          .select()
          .from(SandboxTable)
          .where(and(
            eq(SandboxTable.state, "running"),
            lt(SandboxTable.time_updated, threshold),
          ))
          .all() as Promise<Row[]>,
        catch: () => [] as Row[],
      }).pipe(Effect.orElseSucceed(() => [] as Row[]))

      if (rows.length === 0) return
      log.info("idle sandbox reap scan", { count: rows.length })
      for (const row of rows) {
        yield* lock(row.session_id, Effect.gen(function* () {
          const current = yield* dbGet(row.session_id).pipe(Effect.orElseSucceed(() => null))
          if (!current || current.id !== row.id || current.state !== "running") return
          if (current.time_updated > threshold) return
          const sb = yield* reconnect(row).pipe(Effect.orElseSucceed(() => null))
          if (sb) {
            yield* destroySandbox(sb, row.session_id).pipe(Effect.catchCause(() => Effect.void))
          } else {
            yield* bestEffortKill(row.id, row.session_id)
            yield* dbMarkDestroyed(row.session_id, row.id).pipe(Effect.catchCause(() => Effect.void))
          }
        }))
      }
    }),
    { schedule: Schedule.spaced(Duration.seconds(60)) },
  ).pipe(
    Effect.forkScoped,
    Effect.interruptible,
  )
})
```

## 六、与现有僵尸清理的关系

| 维度 | 现有僵尸清理 (行 1297-1350) | 新增 idle reap |
|------|---------------------------|---------------|
| **语义** | 崩溃恢复（pod crash 后遗留的孤儿记录） | 资源回收（空闲沙箱主动释放） |
| **阈值** | `idleKillMs * 2`（默认 120 min） | `idleReapMs`（默认 30 min，可配置） |
| **查询条件** | `state=running AND keep_alive=false` | `state=running`（不限 keep_alive） |
| **扫描间隔** | `Schedule.spaced(idleKillMs)`（默认 60 min） | `Schedule.spaced(idleReapIntervalMs)`（默认 5 min，`idleReapIntervalMs=300_000`） |
| **getInfo reconcile** | ✅ 有（验证沙箱实际状态，已终止的跳过 kill） | ❌ 不需要（主动清理存活沙箱） |
| **dbSetKeepAlive(false)** | ❌ 不需要（本就 keep_alive=false） | ❌ 不需要（直接销毁，不修改会话状态） |

两者**共存不冲突**：idle reap 更快地回收空闲沙箱；僵尸清理作为长时间最后保障，处理进程崩溃后的孤儿记录。

## 七、关键技术约束

### 7.1 锁重入规避

`destroy(sessionID)`（行 1073-1095）内部已调用 `lock(sessionID, ...)`。扫描代码**不能在 lock 内调用 `destroy()`**，否则 per-session `Semaphore(1)`（行 800-808）会重入死锁。必须在 lock 内手动执行 `reconnect → destroySandbox → dbMarkDestroyed` 序列，与现有僵尸清理（行 1320-1342）一致。

### 7.2 CAS 保护

扫描查询和实际销毁之间有时间差。lock 内必须重新读取 `current` 并校验三者仍满足条件：

- `current.id === row.id` — 沙箱未被重建（不同 ID）
- `current.state === "running"` — 状态未被其他路径改变
- `current.time_updated <= threshold` — 扫描后又被活跃使用

三者同时匹配才执行销毁，防止误杀正在使用的沙箱。

### 7.3 信号量串行化

`lock(sessionID, ...)`（行 800-808）使用 per-session `Semaphore(1)`，确保同一 session 的销毁不会与 `getOrCreate`/`runInSession` 并发执行。

### 7.4 错误容忍

每一步都 `catchCause(() => Effect.void)`，单条记录失败不中断整个扫描循环。

## 八、测试方案

### T1 基本回收

插入 `state=running, time_updated=now-31min` 的沙箱记录，等待一次扫描（≤70s），验证 `state` 变为 `destroyed`。

### T2 keepAlive 回收

同 T1 但 `keep_alive=true`，验证也被回收（证明不限 keep_alive）。

### T3 CAS 保护

插入记录后，在扫描前 UPDATE `time_updated=now`（模拟活跃），验证不被误杀。

### T4 阈值边界

`time_updated=now-29min` 的记录不被回收，`now-31min` 的被回收。

### T5 配置注入

通过自定义 `SandboxConfig.layer` 注入 `idleReapMs=5_000`（5 秒），验证短周期扫描生效（加速测试）。

### T6 并发安全

扫描执行期间同时发起 `getOrCreate`，验证不互相干扰（lock 串行化 + CAS 校验）。

## 九、风险分析

| 风险 | 影响 | 缓解 |
|------|------|------|
| 长时间 AI 推理（无工具调用）期间沙箱被误杀 | 沙箱重建有 5-10s 延迟 | 可接受：`time_updated` 不更新说明无沙箱操作；重建走 `getOrCreate` 自动恢复 |
| 后台 bash 任务还在跑但沙箱被杀 | 后台任务中断 | 可接受：60 分钟无活动说明用户已不在；不修改 keep_alive 标志，用户重启会话时可重建沙箱继续 |
| 多实例并发扫描同一沙箱 | 重复 destroy | 已由 per-session `Semaphore(1)` + CAS 校验覆盖；跨进程由 PG row 状态校验兜底 |
| 5 分钟扫描间隔的 DB 查询开销 | 轻微 DB 负载 | 查询走 `state + time_updated`，数据量小；可按需调间隔 |

## 十、改动文件清单

```
packages/opencode/src/flag/flag.ts              # 新增 OPENCODE_SANDBOX_IDLE_REAP_SEC
packages/opencode/src/tool/sandbox-provider.ts  # SandboxConfig 新增 idleReapMs + dbTouchSandbox + pgLayer 新增 idle reap 扫描循环
```

## 十一、防御链路示意

```
会话 idle
  │
  ├─ keep_alive=false → onIdle 即时销毁（现有，L0）
  │
  └─ keep_alive=true  → 沙箱保留
        │
        ▼
  Idle Reap 扫描（每 5 分钟，L1）
        │
        ├─ 查 SandboxTable: state=running AND time_updated < now - 60min
        │
        ├─ lock + CAS 校验（防止误杀活跃沙箱）
        │
        └─ reconnect → destroySandbox（kill + close + mark destroyed）
              └─ reconnect 失败 → bestEffortKill + mark destroyed
        │
        ▼
  僵尸清理（每 60min，L2，现有）
        │
        └─ 处理进程崩溃后遗留的孤儿记录（idle reap 错过的窗口）
```
