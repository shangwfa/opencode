/**
 * sandbox idle reap 单元测试
 *
 * 验证 pgLayer 的空闲沙箱定期回收逻辑：
 * - 超时记录（time_updated > idleReapMs）被 claim 后标记为 destroyed
 * - keep_alive=true 的超时记录也被回收
 * - 未超时记录不被误杀
 * - CAS 保护：扫描期间 time_updated 被更新则跳过
 *
 * 运行方式：
 *   OPENCODE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/opencode_test \
 *   bun test test/tool/sandbox-idle-reap.test.ts
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { eq, like } from "drizzle-orm"
import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"
import { Database } from "../../src/storage/db"
import { SandboxTable } from "../../src/tool/sandbox.pg"
import { SandboxProvider, SandboxConfig } from "../../src/tool/sandbox-provider"
import type { SessionID } from "../../src/session/schema"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()

const db = Database.Client()
const lifecycleRequests: Array<{ method: string; path: string }> = []
const failedDeletes = new Set<string>()
const failedConnects = new Set<string>()
let deleteSucceeds = false
let nextSandboxID: string | undefined
let activeCommand: ReadableStreamDefaultController<Uint8Array> | undefined
let createDelayMs = 0
const lifecycle = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    lifecycleRequests.push({ method: request.method, path })
    if (request.method === "GET" && Array.from(failedConnects).some((id) => path.includes(id))) {
      return Response.json({ code: "CONNECT_FAILED", message: "simulated connect failure" }, { status: 500 })
    }
    if (request.method === "DELETE" && Array.from(failedDeletes).some((id) => path.includes(id))) {
      return Response.json({ code: "DELETE_FAILED", message: "simulated delete failure" }, { status: 500 })
    }
    if (request.method === "DELETE" && deleteSucceeds && nextSandboxID && path.includes(`/v1/sandboxes/${nextSandboxID}`)) {
      return new Response(null, { status: 200 })
    }
    if (request.method === "POST" && path === "/v1/sandboxes" && nextSandboxID) {
      if (createDelayMs > 0) await Bun.sleep(createDelayMs)
      return Response.json({ id: nextSandboxID, createdAt: new Date().toISOString() })
    }
    if (request.method === "GET" && nextSandboxID && path.includes(`/v1/sandboxes/${nextSandboxID}/endpoints/`)) {
      return Response.json({ endpoint: new URL(request.url).host, headers: {} })
    }
    if (request.method === "GET" && path === "/ping") return new Response("ok")
    if (request.method === "POST" && path === "/session") {
      return Response.json({ session_id: "cmd_test" })
    }
    if (request.method === "POST" && path === "/session/cmd_test/run") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          activeCommand = controller
        },
      }), { headers: { "content-type": "text/event-stream" } })
    }
    if (request.method === "POST" && path === "/command") {
      return new Response("", { headers: { "content-type": "text/event-stream" } })
    }
    return Response.json({ code: "NOT_FOUND", message: "sandbox not found" }, { status: 404 })
  },
})

// 本地 lifecycle server：GET 返回 404，DELETE 可按 sandbox ID 注入 404/500。
// idleReapMs=5s（超时阈值），idleReapIntervalMs=500ms（扫描间隔）
// idleKillMs=1h（避免 zombie cleanup 干扰）
const config = SandboxConfig.Service.of({
  domain: lifecycle.url.host,
  protocol: "http",
  apiKey: "",
  useServerProxy: false,
  image: "fake",
  timeoutSeconds: 300,
  resourceLimits: { cpu: "1", memory: "2Gi" },
  volumeType: "none" as const,
  pvcClaimName: "",
  snapshotEnabled: false,
  snapshotTtlMs: 7 * 86400_000,
  snapshotWaitMs: 900_000,
  idleKillMs: 3_600_000,
  idleReapMs: 5_000,
  idleReapIntervalMs: 500,
  maxTtlSeconds: 3600,
  packageCacheMount: "/cache",
  cleanupOnScopeExit: false,
})
const configLayer = Layer.succeed(
  SandboxConfig.Service,
  config,
)

let scope: Scope.Scope | undefined
let context: unknown

const sid = (s: string) => s as SessionID

async function insertSandbox(sessionID: string, opts: { keepAlive?: boolean; ageMs?: number }) {
  const now = Date.now()
  const ts = now - (opts.ageMs ?? 0)
  await db.insert(SandboxTable).values({
    id: `sb_${sessionID}`,
    session_id: sessionID,
    host: "http://127.0.0.1:1",
    state: "running",
    keep_alive: opts.keepAlive ?? false,
    command_session_id: null,
    time_created: ts,
    time_updated: ts,
  }).run()
}

async function getSandboxState(sessionID: string) {
  const rows = await db.select({ id: SandboxTable.id, state: SandboxTable.state, keep_alive: SandboxTable.keep_alive })
    .from(SandboxTable)
    .where(eq(SandboxTable.session_id, sessionID))
    .limit(1)
  return rows[0] ?? null
}

async function dbCleanup(sessionID: string) {
  await db.delete(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).run()
}

async function dbCleanupTests() {
  await db.delete(SandboxTable).where(like(SandboxTable.session_id, "ses_reap_%")).run()
}

async function waitForState(sessionID: string, state: "killed" | "destroyed", timeoutMs = 30_000) {
  for (let i = 0; i < timeoutMs / 300; i++) {
    if ((await getSandboxState(sessionID))?.state === state) return true
    await Bun.sleep(300)
  }
  return false
}

async function waitForDelete(sandboxID: string, timeoutMs = 10_000) {
  for (let i = 0; i < timeoutMs / 50; i++) {
    if (lifecycleRequests.some((request) => request.method === "DELETE" && request.path.includes(sandboxID))) return true
    await Bun.sleep(50)
  }
  return false
}

describe.skipIf(!enabled)("pgLayer - idle reap: 空闲沙箱定期回收", () => {
  beforeAll(async () => {
    await Database.initialize()
    await Effect.runPromise(Effect.gen(function* () {
      scope = yield* Scope.make()
      context = yield* Layer.buildWithScope(SandboxProvider.pgLayer.pipe(Layer.provide(configLayer)), scope)
    }))
    await dbCleanupTests()
  }, 30_000)

  afterAll(async () => {
    if (context) void context
    context = undefined
    await dbCleanupTests()
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.catchCause(() => Effect.void)))
    }
    lifecycle.stop(true)
  })

  // T1: 超时记录被回收（keep_alive=false）
  test("远端资源已不存在时超时记录被幂等标记为 destroyed", async () => {
    const SID = sid("ses_reap_basic")
    await insertSandbox(SID, { ageMs: 6_000 })

    const reaped = await waitForState(SID, "destroyed")
    expect(reaped).toBe(true)

    await dbCleanup(SID)
  }, 40_000)

  // T2: keep_alive=true 的超时记录也被回收
  test("keep_alive=true 的超时记录也进入回收", async () => {
    const SID = sid("ses_reap_keepalive")
    await insertSandbox(SID, { keepAlive: true, ageMs: 6_000 })

    const reaped = await waitForState(SID, "destroyed")
    expect(reaped).toBe(true)
    expect((await getSandboxState(SID))?.keep_alive).toBe(true)

    await dbCleanup(SID)
  }, 40_000)

  test("生命周期 API 删除失败时保持 killed，等待下一轮重试", async () => {
    const SID = sid("ses_reap_delete_failure")
    const sandboxID = `sb_${SID}`
    failedDeletes.add(sandboxID)
    await insertSandbox(SID, { ageMs: 6_000 })

    expect(await waitForDelete(sandboxID)).toBe(true)
    expect((await getSandboxState(SID))?.state).toBe("killed")

    failedDeletes.delete(sandboxID)
    await db.update(SandboxTable)
      .set({ time_updated: Date.now() - 31_000 })
      .where(eq(SandboxTable.session_id, SID))
      .run()

    expect(await waitForState(SID, "destroyed")).toBe(true)
    await dbCleanup(SID)
  }, 30_000)

  test("idle 回收 reconnect 返回 500 时保持 killed 且不发送 DELETE", async () => {
    const SID = sid("ses_reap_connect_failure")
    const sandboxID = `sb_${SID}`
    failedConnects.add(sandboxID)
    await insertSandbox(SID, { ageMs: 6_000 })

    expect(await waitForState(SID, "killed")).toBe(true)
    await Bun.sleep(1_000)
    expect((await getSandboxState(SID))?.state).toBe("killed")
    expect(lifecycleRequests.some((request) => request.method === "DELETE" && request.path.includes(sandboxID))).toBe(false)

    failedConnects.delete(sandboxID)
    await dbCleanup(SID)
  }, 20_000)

  test("reconnect 返回 404 时自动重建并替换 lifecycle 记录", async () => {
    const SID = sid("ses_reap_reconnect_404")
    const oldID = `sb_${SID}`
    nextSandboxID = `sb_rebuilt_${SID}`
    await insertSandbox(SID, { ageMs: 0 })

    const sb = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SandboxProvider.Service
        return yield* svc.getOrCreate(SID, { pvcMode: "session" })
      }).pipe(Effect.provide(context as Context.Context<SandboxProvider.Service>)),
    )

    expect(sb.id).toBe(nextSandboxID)
    expect(await getSandboxState(SID)).toMatchObject({ id: nextSandboxID, state: "running" })
    expect(lifecycleRequests.some((request) => request.method === "GET" && request.path.includes(oldID))).toBe(true)
    expect(lifecycleRequests.filter((request) => request.method === "POST" && request.path === "/v1/sandboxes")).toHaveLength(1)
    nextSandboxID = undefined
    await dbCleanup(SID)
  }, 20_000)

  test("reconnect 返回 500 时保留 running 且不创建重复 sandbox", async () => {
    const SID = sid("ses_reap_reconnect_500")
    const sandboxID = `sb_${SID}`
    const createsBefore = lifecycleRequests.filter((request) => request.method === "POST" && request.path === "/v1/sandboxes").length
    failedConnects.add(sandboxID)
    await insertSandbox(SID, { ageMs: 0 })

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SandboxProvider.Service
        return yield* Effect.exit(svc.getOrCreate(SID, { pvcMode: "session" }))
      }).pipe(Effect.provide(context as Context.Context<SandboxProvider.Service>)),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(await getSandboxState(SID)).toMatchObject({ id: sandboxID, state: "running" })
    expect(lifecycleRequests.filter((request) => request.method === "POST" && request.path === "/v1/sandboxes")).toHaveLength(createsBefore)
    failedConnects.delete(sandboxID)
    await dbCleanup(SID)
  }, 20_000)

  test("创建期间并发 keepAlive 不会被 upsert 覆盖", async () => {
    const SID = sid("ses_reap_keepalive_race")
    nextSandboxID = `sb_keepalive_race_${SID}`
    createDelayMs = 3_000
    try {
      const creating = Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* SandboxProvider.Service
          return yield* svc.getOrCreate(SID, { pvcMode: "session" })
        }).pipe(Effect.provide(context as Context.Context<SandboxProvider.Service>)),
      )

      // 等 POST /v1/sandboxes 被请求（创建已进入 delay），期间调用 keepAlive
      for (let i = 0; i < 100 && !lifecycleRequests.some((request) => request.method === "POST" && request.path === "/v1/sandboxes"); i++) {
        await Bun.sleep(50)
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* SandboxProvider.Service
          yield* svc.keepAlive(SID)
        }).pipe(Effect.provide(context as Context.Context<SandboxProvider.Service>)),
      )

      const sb = await creating
      expect(sb.id).toBe(nextSandboxID)
      expect(await getSandboxState(SID)).toMatchObject({ id: nextSandboxID, state: "running", keep_alive: true })
    } finally {
      createDelayMs = 0
      nextSandboxID = undefined
      await dbCleanup(SID)
    }
  }, 20_000)

  test("destroy 保留 keepAlive，重建后仍保持 keepAlive", async () => {
    const SID = sid("ses_reap_destroy_keepalive")
    nextSandboxID = `sb_destroy_keep_${SID}`
    await insertSandbox(SID, { keepAlive: true, ageMs: 0 })

    const provide = <A>(effect: Effect.Effect<A, never, SandboxProvider.Service>) =>
      Effect.runPromise(effect.pipe(Effect.provide(context as Context.Context<SandboxProvider.Service>)))

    await provide(Effect.gen(function* () {
      const svc = yield* SandboxProvider.Service
      yield* svc.destroy(SID)
    }))
    expect((await getSandboxState(SID))?.state).toBe("destroyed")
    expect(await provide(Effect.gen(function* () {
      const svc = yield* SandboxProvider.Service
      return yield* svc.isKeepAlive(SID)
    }))).toBe(true)

    const sb = await provide(Effect.gen(function* () {
      const svc = yield* SandboxProvider.Service
      return yield* svc.getOrCreate(SID, { pvcMode: "session" })
    }))
    expect(sb.id).toBe(nextSandboxID)
    expect(await getSandboxState(SID)).toMatchObject({ id: nextSandboxID, state: "running", keep_alive: true })

    nextSandboxID = undefined
    await dbCleanup(SID)
  }, 20_000)

  test("单个候选删除失败不会阻断同批其他候选", async () => {
    const FAILED = sid("ses_reap_batch_failure")
    const SUCCESS = sid("ses_reap_batch_success")
    const failedID = `sb_${FAILED}`
    failedDeletes.add(failedID)
    await insertSandbox(FAILED, { ageMs: 6_000 })
    await insertSandbox(SUCCESS, { ageMs: 6_000 })

    expect(await waitForDelete(failedID)).toBe(true)
    expect(await waitForState(SUCCESS, "destroyed")).toBe(true)
    expect((await getSandboxState(FAILED))?.state).toBe("killed")

    failedDeletes.delete(failedID)
    await dbCleanup(FAILED)
    await dbCleanup(SUCCESS)
  }, 20_000)

  test("多个 pgLayer 同时扫描只会 claim 和删除一次", async () => {
    const SID = sid("ses_reap_multi_layer")
    const sandboxID = `sb_${SID}`
    const deletesBefore = lifecycleRequests.filter((request) => request.method === "DELETE" && request.path.includes(sandboxID)).length
    const firstScope = await Effect.runPromise(Scope.make())
    const secondScope = await Effect.runPromise(Scope.make())
    await Promise.all([
      Effect.runPromise(Layer.buildWithScope(SandboxProvider.pgLayer.pipe(Layer.provide(configLayer)), firstScope)),
      Effect.runPromise(Layer.buildWithScope(SandboxProvider.pgLayer.pipe(Layer.provide(configLayer)), secondScope)),
    ])
    await insertSandbox(SID, { ageMs: 6_000 })

    expect(await waitForState(SID, "destroyed")).toBe(true)
    expect(lifecycleRequests.filter((request) => request.method === "DELETE" && request.path.includes(sandboxID))).toHaveLength(deletesBefore + 1)

    await Promise.all([
      Effect.runPromise(Scope.close(firstScope, Exit.void)),
      Effect.runPromise(Scope.close(secondScope, Exit.void)),
    ])
    await dbCleanup(SID)
  }, 30_000)

  test("长命令跨越 idle 阈值时 heartbeat 防止误回收", async () => {
    const SID = sid("ses_reap_command_heartbeat")
    nextSandboxID = `sb_heartbeat_${SID}`
    const sandbox = await Sandbox.create({
      connectionConfig: new ConnectionConfig({
        domain: lifecycle.url.host,
        protocol: "http",
      }),
      image: "fake",
      timeoutSeconds: 300,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SandboxProvider.Service
        yield* svc.register(SID, sandbox)
      }).pipe(Effect.provide(context as Context.Context<SandboxProvider.Service>)),
    )
    const running = Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SandboxProvider.Service
        return yield* svc.runInSession(SID, "sleep 10")
      }).pipe(Effect.provide(context as Context.Context<SandboxProvider.Service>)),
    )

    for (let i = 0; i < 100 && !activeCommand; i++) await Bun.sleep(50)
    expect(activeCommand).toBeDefined()
    const before = (await db.select({ time_updated: SandboxTable.time_updated })
      .from(SandboxTable)
      .where(eq(SandboxTable.session_id, SID))
      .limit(1))[0]?.time_updated
    await Bun.sleep(6_000)
    const after = (await db.select({ time_updated: SandboxTable.time_updated })
      .from(SandboxTable)
      .where(eq(SandboxTable.session_id, SID))
      .limit(1))[0]?.time_updated

    expect((await getSandboxState(SID))?.state).toBe("running")
    expect(after).toBeGreaterThan(before ?? 0)
    activeCommand?.close()
    activeCommand = undefined
    await running
    await sandbox.close()
    nextSandboxID = undefined
    await dbCleanup(SID)
  }, 20_000)

  // detached/async 长命令不维持心跳：跨越 idle 阈值后沙箱仍会被 idle-reap 回收
  test("detached 长命令不阻止 idle-reap 回收", async () => {
    const SID = sid("ses_reap_detached_heartbeat")
    nextSandboxID = `sb_detached_${SID}`
    deleteSucceeds = true
    const sandbox = await Sandbox.create({
      connectionConfig: new ConnectionConfig({
        domain: lifecycle.url.host,
        protocol: "http",
      }),
      image: "fake",
      timeoutSeconds: 300,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SandboxProvider.Service
        yield* svc.register(SID, sandbox)
      }).pipe(Effect.provide(context as Context.Context<SandboxProvider.Service>)),
    )
    const running = Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SandboxProvider.Service
        return yield* svc.runDetached(SID, "sleep 10")
      }).pipe(Effect.provide(context as Context.Context<SandboxProvider.Service>)),
    ).catch(() => undefined)

    for (let i = 0; i < 100 && !activeCommand; i++) await Bun.sleep(50)
    expect(activeCommand).toBeDefined()
    const before = (await db.select({ time_updated: SandboxTable.time_updated })
      .from(SandboxTable)
      .where(eq(SandboxTable.session_id, SID))
      .limit(1))[0]?.time_updated
    // 无心跳：阈值内（idleReapMs=5s）time_updated 不被刷新
    await Bun.sleep(3_500)
    const after = (await db.select({ time_updated: SandboxTable.time_updated })
      .from(SandboxTable)
      .where(eq(SandboxTable.session_id, SID))
      .limit(1))[0]?.time_updated
    expect(after).toBe(before ?? 0)
    // 跨过 idleReapMs=5s 后沙箱被 idle-reap 回收（detached 命令不阻止回收）
    expect(await waitForState(SID, "destroyed")).toBe(true)

    activeCommand?.close()
    activeCommand = undefined
    await running
    await sandbox.close()
    nextSandboxID = undefined
    deleteSucceeds = false
    await dbCleanup(SID)
  }, 20_000)

  // 额外预检：全新记录不应被误回收
  test("未超时记录（time_updated < idleReapMs）不被回收", async () => {    const SID = sid("ses_reap_fresh")
    await insertSandbox(SID, { ageMs: 0 })

    await Bun.sleep(3_000)

    expect((await getSandboxState(SID))?.state).toBe("running")

    await dbCleanup(SID)
  }, 10_000)

  // T3: CAS 保护 — 持续活跃的沙箱不被误杀
  test("持续更新 time_updated 的沙箱不被误杀（CAS 保护）", async () => {
    const SID = sid("ses_reap_cas")
    await insertSandbox(SID, { ageMs: 6_000 })

    await db.update(SandboxTable)
      .set({ time_updated: Date.now() })
      .where(eq(SandboxTable.session_id, SID))
      .run()

    // 持续刷新 time_updated，模拟沙箱正在被活跃使用
    let stop = false
    const refresh = (async () => {
      while (!stop) {
        await db.update(SandboxTable)
          .set({ time_updated: Date.now() })
          .where(eq(SandboxTable.session_id, SID))
          .run()
        await Bun.sleep(300)
      }
    })()

    await Bun.sleep(4_000)
    stop = true
    await refresh

    expect((await getSandboxState(SID))?.state).toBe("running")

    await dbCleanup(SID)
  }, 15_000)

  // T4: 阈值边界 — 刚好低于阈值的记录不被回收，超过阈值被回收
  test("阈值边界：低于 idleReapMs 的记录不被回收，超过的被回收", async () => {
    const SID_FRESH = sid("ses_reap_boundary_fresh")
    const SID_OLD = sid("ses_reap_boundary_old")

    // 4s < 5s 阈值，不应被回收
    await insertSandbox(SID_FRESH, { ageMs: 4_000 })
    // 6s > 5s 阈值，应被回收
    await insertSandbox(SID_OLD, { ageMs: 6_000 })

    const oldReaped = await waitForState(SID_OLD, "destroyed")
    expect(oldReaped).toBe(true)

    // 确认边界内的记录仍然存活
    expect((await getSandboxState(SID_FRESH))?.state).toBe("running")

    await dbCleanup(SID_FRESH)
    await dbCleanup(SID_OLD)
  }, 40_000)

  // T5: 配置注入 — 自定义 SandboxConfig 的 idleReapMs 生效
  test("自定义 SandboxConfig.idleReapMs 会生效", async () => {
    const SID = sid("ses_reap_config")
    await insertSandbox(SID, { ageMs: 6_000 })

    // 若使用默认 30min，测试时间内不可能被回收；
    // 本测试层配置了 5s，应在 15s 内被回收。
    const reaped = await waitForState(SID, "destroyed", 15_000)
    expect(reaped).toBe(true)

    await dbCleanup(SID)
  }, 20_000)

  test("PG layer scope 关闭不会全局销毁 running sandbox", async () => {
    const SID = sid("ses_reap_scope_exit")
    const sandboxID = `sb_${SID}`
    await insertSandbox(SID, { ageMs: 0 })
    const deletesBefore = lifecycleRequests.filter((request) => request.method === "DELETE" && request.path.includes(sandboxID)).length
    const localScope = await Effect.runPromise(Scope.make())
    await Effect.runPromise(
      Layer.buildWithScope(
        SandboxProvider.pgLayer.pipe(
          Layer.provide(Layer.succeed(SandboxConfig.Service, SandboxConfig.Service.of({ ...config, cleanupOnScopeExit: true }))),
        ),
        localScope,
      ),
    )

    await Effect.runPromise(Scope.close(localScope, Exit.void))

    expect((await getSandboxState(SID))?.state).toBe("running")
    expect(lifecycleRequests.filter((request) => request.method === "DELETE" && request.path.includes(sandboxID))).toHaveLength(deletesBefore)
    await dbCleanup(SID)
  })

  // T6: 并发安全 — getOrCreate 与 idle reap 并发不互相干扰
  test("getOrCreate 与 idle reap 并发不互相干扰", async () => {
    const SID = sid("ses_reap_concurrent")
    await insertSandbox(SID, { ageMs: 6_000 })

    const getOrCreatePromise = Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SandboxProvider.Service
        return yield* svc.getOrCreate(SID)
      }).pipe(
        Effect.provide(context as Context.Context<SandboxProvider.Service>),
      ),
    ).catch(() => null)

    const [sb, reaped] = await Promise.all([
      getOrCreatePromise,
      waitForState(SID, "destroyed", 30_000),
    ])

    const state = await getSandboxState(SID)
    if (sb) {
      // getOrCreate 抢到锁并成功复用/重建，记录仍 running
      expect(state?.id).toBe(sb.id)
      expect(state?.state).toBe("running")
    } else {
      // getOrCreate 失败（本测试用 fake domain），scanner 应能正常回收
      expect(reaped || state?.state === "destroyed").toBe(true)
    }

    await dbCleanup(SID)
  }, 60_000)
})
