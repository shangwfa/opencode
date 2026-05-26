# PVC 沙箱方案实现设计

> **⚠️ 此文档为历史设计参考，与当前实现不完全一致**。
> 实际实现采用**二态（running/killed）状态机**，删除了 `renew()` 调用和 paused 状态。
> 当前实现的准确描述见 `saas-architecture.md` 第七章及 `tool/sandbox-provider.ts` 源码。

## 一、总体架构

```
用户发消息
    │
    ▼
ensureRunning(sessionID)          ← run-state.ts
    │
    ├─ busy? → throw BusyError
    │
    ├─ status → "busy"
    │
    ├─ 工具调用 → sandboxProvider.getOrCreate(sessionID)   ← sandbox-provider.ts
    │               │
    │               ├─ entry 存在且 running + healthy → 复用
    │               ├─ entry 存在但 unhealthy → destroy → 重建
    │               ├─ entry 是 killed → 重建（PVC 挂回，文件还在）
    │               └─ entry 不存在 → 新建 Sandbox.create()
    │
    ├─ bash background:true → keepAlive(sessionID)
    │                           leases.add(sessionID)
    │
    ▼
AI 回复完成 → Runner.onIdle()
    │
    ├─ status → "idle"
    │
    ├─ isKeepAlive(sessionID)?
    │     ├─ Yes → 跳过销毁，sandbox 保留
    │     └─ No  → destroy(sessionID)
    │               ├─ leases.delete(sessionID)
    │               ├─ entries.delete(sessionID)
    │               ├─ kill sandbox Pod (sb.kill + sb.close)
    │               └─ PVC 数据保留不动
    │
    ▼
手动销毁入口：
    ├─ POST /session/:sessionID/kill-sandbox → destroy(sessionID)
    └─ POST /instance/dispose → destroyAll() + Instance.dispose()

核心存储（全部内存，per-instance）：
  - entries: Map<sessionID, Entry>    — running | killed 状态
  - sandboxes: Map<sessionID, Sandbox> — 远端沙箱引用
  - leases: Set<sessionID>            — keepAlive 标记
```

## 二、状态机

```
                    create + PVC
    [None] ─────────────────────────► [Running] ◄──── resume() + renew()
                                        │  ▲                   ▲
                          idle 15min    │  │                   │
                                        ▼  │                   │
                                    [Paused] ──────────────────┘
                                        │           user returns
                          idle 60min    │
                                        ▼
                                    [Killed] ──── recreate + PVC ───► [Running]
                                        │
                            session end  │
                                        ▼
                                    [Destroyed] → delete PVC
```

In-memory 状态用 `Ref<Map<SessionID, Entry>>` 管理：

```typescript
type Entry =
  | { state: "running"; sb: Sandbox; sandboxID: string; lastActive: number }
  | { state: "paused";  sandboxID: string; lastActive: number }
  | { state: "killed";  sandboxID: string; lastActive: number }
```

## 三、配置项（新增环境变量）

```typescript
// flag.ts 新增
OPENCODE_SANDBOX_VOLUME_TYPE    // "none" | "pvc" | "host"    默认 "none"
OPENCODE_SANDBOX_VOLUME_SIZE    // "10Gi" | "20Gi" | ...      默认 "10Gi"
OPENCODE_SANDBOX_STORAGE_CLASS  // K8s StorageClass 名称      默认 ""
OPENCODE_SANDBOX_IDLE_PAUSE_SEC // 空闲多久 pause             默认 900 (15min)
OPENCODE_SANDBOX_IDLE_KILL_SEC  // 空闲多久 kill              默认 3600 (60min)
```

## 四、改动文件清单

| 文件 | 改动 | 行数估计 |
|------|------|---------|
| `src/flag/flag.ts` | 新增 5 个环境变量 | +10 |
| `src/tool/sandbox-provider.ts` | 核心重构：PVC volume、pause/resume/kill 状态机、idle timer | ~+200 (325→525) |
| `src/tool/sandbox-path.ts` | 无改动 | 0 |
| `src/session/prompt.ts` | 无改动（lazy getSandbox 已适配） | 0 |
| `src/session/index.ts` | destroy 改为异步删 PVC | +5 |

## 五、`sandbox-provider.ts` 核心实现

### 5.1 SandboxConfig 扩展

```typescript
export namespace SandboxConfig {
  export interface Interface {
    readonly domain: string
    readonly protocol: "http" | "https"
    readonly image: string
    readonly timeoutSeconds: number | null
    readonly resourceLimits: Record<string, string>
    // 新增
    readonly volumeType: "none" | "pvc" | "host"
    readonly volumeSize: string
    readonly storageClass: string
    readonly idlePauseMs: number
    readonly idleKillMs: number
  }
  // ... defaultConfig 从环境变量读取
}
```

### 5.2 createSandbox 改造

```typescript
function createSandbox(sessionID: SessionID) {
  return Effect.gen(function* () {
    log.info("creating sandbox", { sessionID })

    const opts: SandboxCreateOptions = {
      connectionConfig,
      image: config.image,
      timeoutSeconds: null,  // 手动管理，不自动过期
      resource: config.resourceLimits,
    }

    // 按类型添加 volume
    if (config.volumeType === "pvc") {
      opts.volumes = [{
        name: `sess-${sessionID.slice(0, 20)}`,  // DNS label, max 63
        pvc: { claimName: `opencode-${sessionID.slice(0, 20)}` },
        mountPath: "/workspace",
      }]
    } else if (config.volumeType === "host") {
      opts.volumes = [{
        name: `sess-${sessionID.slice(0, 20)}`,
        host: { path: `/var/opencode/sessions/${sessionID}` },
        mountPath: "/workspace",
      }]
    }

    const sb = yield* Effect.tryPromise(() => Sandbox.create(opts))

    // PVC/host 模式不需要 mkdir（volume 目录已存在）
    if (config.volumeType === "none") {
      yield* Effect.tryPromise(() => sb.commands.run("mkdir -p /workspace")).pipe(
        Effect.catchCause(() => Effect.void),
      )
    }

    log.info("sandbox created", { sessionID, sandboxID: sb.id })
    return sb
  })
}
```

### 5.3 状态机核心：getOrCreate

```typescript
const getOrCreate: Interface["getOrCreate"] = (sessionID) =>
  Effect.gen(function* () {
    const myToken = yield* Deferred.make<Sandbox, Error>()
    const winner = yield* claim(createRef, sessionID, myToken)
    if (winner !== myToken) {
      return yield* Deferred.await(winner).pipe(Effect.orDie)
    }

    const entry = yield* Ref.modify(entriesRef, (m) => {
      const e = m.get(sessionID)
      m.delete(sessionID)
      return [e, m] as const
    })

    const work = Effect.gen(function* () {
      if (!entry) {
        return yield* createSandbox(sessionID)
      }

      if (entry.state === "running") {
        yield* Effect.tryPromise(() => entry.sb.renew(30 * 60)).pipe(
          Effect.catchCause(() => Effect.void),
        )
        yield* touchLastActive(sessionID)
        return entry.sb
      }

      if (entry.state === "paused") {
        log.info("resuming paused sandbox", { sessionID, sandboxID: entry.sandboxID })
        const sb = yield* Effect.tryPromise(() =>
          Sandbox.resume({
            connectionConfig,
            sandboxId: entry.sandboxID,
          })
        )
        yield* Effect.tryPromise(() => sb.renew(30 * 60))
        yield* touchLastActive(sessionID)
        log.info("sandbox resumed", { sessionID })
        return sb
      }

      if (entry.state === "killed") {
        log.info("recreating killed sandbox", { sessionID })
        return yield* createSandbox(sessionID)
      }

      return yield* createSandbox(sessionID)
    })

    return yield* work.pipe(
      Effect.tap((sb) => {
        setEntry(sessionID, { state: "running", sb, sandboxID: sb.id, lastActive: Date.now() })
      }),
      // onExit 处理 createRef（同现有逻辑）
    )
  })
```

### 5.4 Idle Timer

```typescript
// 在 layer 初始化时 fork 一个后台 fiber
yield* Effect.gen(function* () {
  while (true) {
    yield* Effect.sleep("30 seconds")
    const now = Date.now()
    const entries = yield* Ref.get(entriesRef)
    for (const [sessionID, entry] of entries) {
      const idle = now - entry.lastActive
      if (entry.state === "running" && idle > config.idleKillMs) {
        yield* killSandbox(sessionID, entry).pipe(Effect.catchCause(() => Effect.void))
      } else if (entry.state === "running" && idle > config.idlePauseMs) {
        yield* pauseSandbox(sessionID, entry).pipe(Effect.catchCause(() => Effect.void))
      } else if (entry.state === "paused" && idle > config.idleKillMs) {
        yield* killSandbox(sessionID, entry).pipe(Effect.catchCause(() => Effect.void))
      }
    }
  }
}).pipe(Effect.forkScoped)
```

### 5.5 pause / kill 内部方法

```typescript
function pauseSandbox(sessionID: string, entry: RunningEntry) {
  return Effect.gen(function* () {
    log.info("pausing idle sandbox", { sessionID })
    yield* Effect.tryPromise(() => entry.sb.pause())
    setEntry(sessionID, {
      state: "paused",
      sandboxID: entry.sandboxID,
      lastActive: entry.lastActive,
    })
    commandSessions.delete(sessionID)
    log.info("sandbox paused", { sessionID })
  })
}

function killSandbox(sessionID: string, entry: Entry) {
  return Effect.gen(function* () {
    log.info("killing idle sandbox", { sessionID })
    if (entry.state === "running") {
      yield* Effect.tryPromise(() => entry.sb.kill()).pipe(Effect.catchCause(() => Effect.void))
      yield* Effect.tryPromise(() => entry.sb.close()).pipe(Effect.catchCause(() => Effect.void))
    }
    if (entry.state === "paused") {
      const manager = SandboxManager.create({ connectionConfig })
      yield* Effect.tryPromise(() => manager.killSandbox(entry.sandboxID)).pipe(
        Effect.catchCause(() => Effect.void),
      )
    }
    setEntry(sessionID, {
      state: "killed",
      sandboxID: entry.sandboxID,
      lastActive: entry.lastActive,
    })
    commandSessions.delete(sessionID)
    commandSemaphores.delete(sessionID)
    log.info("sandbox killed", { sessionID })
  })
}
```

### 5.6 destroy 改造（session 结束时）

```typescript
const destroy: Interface["destroy"] = (sessionID) =>
  Effect.gen(function* () {
    const entry = yield* Ref.modify(entriesRef, (m) => {
      const e = m.get(sessionID)
      m.delete(sessionID)
      return [e, m] as const
    })
    commandSessions.delete(sessionID)
    commandSemaphores.delete(sessionID)

    // ... inFlight 处理（同现有逻辑）

    if (!entry) return

    if (entry.state === "running") {
      yield* destroySandbox(entry.sb, sessionID)
    } else if (entry.state === "paused") {
      const manager = SandboxManager.create({ connectionConfig })
      yield* Effect.tryPromise(() => manager.killSandbox(entry.sandboxID))
    }

    // PVC 清理
    if (config.volumeType === "host") {
      // host 模式：由外部 CronJob 清理 /var/opencode/sessions/${sessionID}
    }
    // PVC 模式：由 K8s CronJob 或 destroy 时调 K8s API 删 PVC
  })
```

### 5.7 runInSession 改造

```typescript
const runInSession: Interface["runInSession"] = (sessionID, command, options, handlers, signal) =>
  Effect.gen(function* () {
    // 每次 runInSession 都 touch lastActive
    yield* touchLastActive(sessionID)

    const sb = yield* Ref.modify(entriesRef, (m) => {
      const entry = m.get(sessionID)
      return [entry?.state === "running" ? entry.sb : null, m] as const
    })
    if (!sb) {
      return yield* Effect.fail(new Error(`Sandbox not running for session ${sessionID}`))
    }

    // ... 后续同现有逻辑（command session 复用 + Semaphore）
  })
```

## 六、PVC 生命周期管理

### 方式 A：OpenSandbox 自动管理（推荐）

- OpenSandbox 底层跑在 K8s 上，创建 sandbox 时传 `pvc: { claimName }`
- OpenSandbox 服务端自动创建 PVC（如果不存在）+ 挂载到 Pod
- 销毁 sandbox 时 PVC 自动保留
- opencode 只负责在 session 结束时通知删 PVC

### 方式 B：opencode 自己管理

- 通过 `@kubernetes/client-node` 直接调 K8s API
- createSandbox 前先 `createPVC`
- destroy 时 `deletePVC`
- 更灵活但依赖 K8s client

建议先用方式 A，如果 OpenSandbox 不支持自动创建 PVC，再回退到方式 B。

## 七、PVC 垃圾回收 CronJob

防止 session 异常退出导致 PVC 残留：

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: opencode-pvc-cleaner
spec:
  schedule: "*/30 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: pvc-cleaner
          containers:
          - name: cleaner
            image: bitnami/kubectl
            command:
            - /bin/sh
            - -c
            - |
              # 删除超过 24 小时且没有关联 Pod 的 PVC
              kubectl get pvc -l app=opencode-session \
                --no-headers | awk '{print $1}' | while read pvc; do
                age=$(kubectl get pvc "$pvc" -o jsonpath='{.metadata.creationTimestamp}')
                # ... 检查年龄和是否有关联 Pod
                kubectl delete pvc "$pvc"
              done
          restartPolicy: OnFailure
```

## 八、测试计划

| 测试 | 类型 | 验证点 |
|------|------|--------|
| `sandbox-pvc-state-machine.test.ts` | 单元 | 4 状态转换、并发 getOrCreate、claim 竞争 |
| `sandbox-pvc-idle-timer.test.ts` | 单元 | pause/kill 时序、touchLastActive |
| `sandbox-pvc-volume-config.test.ts` | 单元 | pvc/host/none 三种 volume 配置生成 |
| `sandbox-pvc-resume.test.ts` | 集成 | pause→resume→命令执行→数据保留 |
| `sandbox-pvc-recreate.test.ts` | 集成 | kill→recreate→PVC 数据仍在 |
| `saas-integration-test.ts` 扩展 | 集成 | 全流程 PVC + PG + 并发 |

## 九、实施顺序

```
Step 1: 配置扩展（flag.ts + SandboxConfig）           ~30min
Step 2: createSandbox 增加 volumes 参数                ~1h
Step 3: 状态机改造（Ref<Map> + Entry 类型）            ~2h
Step 4: idle timer 后台 fiber                          ~1h
Step 5: pause/kill 内部方法                            ~1h
Step 6: destroy 改造                                   ~30min
Step 7: 单元测试                                       ~2h
Step 8: 集成测试                                       ~2h
                                     总计: ~10h
```

## 十、风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| PVC attach/detach 竞态 | recreate 时加退避重试，等 detach 完成再 attach |
| PVC 大小预估不准 | 使用支持 `allowVolumeExpansion` 的 StorageClass |
| PVC 垃圾残留 | CronJob 每 30 分钟扫描清理孤儿 PVC |
| 跨 AZ 不可用 | 接受单 AZ 故障域，或后续切换为 NAS StorageClass |
| PVC 数量上限 | 规模增长后引入 PVC 预分配池 |
| resume 失败 | 回退到 kill + recreate |
| 状态机复杂度 | 严格单元测试覆盖所有状态转换路径 |

---

## 已知问题

### glob/grep 工具在沙箱内不可用

**状态**：待修复，依赖沙箱基础镜像更新

- **glob**：沙箱镜像未预装 `rg`（ripgrep），`rg --files` 命令执行失败返回空结果
- **grep**：除 `rg` 缺失外，还有两个代码 bug：
  - `grep.ts:61` — `ctx.sandbox` 误用 `Effect.tryPromise` 包装（sandbox 不是 Promise）
  - `grep.ts:67` — sandbox 分支引用了未定义的 `file` 变量（该变量在 local mode 的 155 行才定义）
- **临时规避**：用 bash 工具执行 `find`/`grep` 命令等效替代
- **修复计划**：等基础沙箱镜像默认安装 `rg` 后，同时修复 grep.ts 的代码 bug

### /instance/dispose 职责过重

**状态**：待重构

- 当前 `/instance/dispose` 既销毁所有沙箱又销毁实例（`Instance.dispose()`）
- 接入方常见场景是"只释放沙箱资源"，但连带销毁了实例，下次请求需重新 boot
- `destroyAll()` 被调用两次（路由 handler 显式调一次，Scope 退出 finalizer 又调一次）
- **修复计划**：拆分为"只销毁沙箱"和"销毁实例"两个独立 API
