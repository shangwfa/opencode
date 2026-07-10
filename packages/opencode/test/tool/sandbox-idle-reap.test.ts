/**
 * sandbox idle reap 单元测试
 *
 * 验证 pgLayer 的空闲沙箱定期回收逻辑：
 * - 超时记录（time_updated > idleReapMs）被标记为 destroyed
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
import { Database } from "../../src/storage/db"
import { SandboxTable } from "../../src/tool/sandbox.pg"
import { SandboxProvider, SandboxConfig } from "../../src/tool/sandbox-provider"
import type { SessionID } from "../../src/session/schema"

const DB_URL = process.env.OPENCODE_DATABASE_URL

if (!DB_URL) {
  console.log("跳过 sandbox-idle-reap 测试，需要设置 OPENCODE_DATABASE_URL")
  process.exit(0)
}

const db = Database.Client()

// domain 设为不可达地址，使 reconnect/bestEffortKill 快速失败
// idleReapMs=5s（超时阈值），idleReapIntervalMs=500ms（扫描间隔）
// idleKillMs=1h（避免 zombie cleanup 干扰）
const configLayer = Layer.succeed(
  SandboxConfig.Service,
  SandboxConfig.Service.of({
    domain: "127.0.0.1:1",
    protocol: "http",
    apiKey: "",
    useServerProxy: false,
    image: "fake",
    timeoutSeconds: 300,
    resourceLimits: { cpu: "1", memory: "2Gi" },
    volumeType: "none" as const,
    pvcClaimName: "",
    idleKillMs: 3_600_000,
    idleReapMs: 5_000,
    idleReapIntervalMs: 500,
    maxTtlSeconds: 3600,
    packageCacheMount: "/cache",
    cleanupOnScopeExit: false,
  }),
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
  const rows = await db.select({ state: SandboxTable.state, keep_alive: SandboxTable.keep_alive })
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

async function waitForDestroyed(sessionID: string, timeoutMs = 30_000) {
  for (let i = 0; i < timeoutMs / 300; i++) {
    if ((await getSandboxState(sessionID))?.state === "destroyed") return true
    await Bun.sleep(300)
  }
  return false
}

describe("pgLayer - idle reap: 空闲沙箱定期回收", () => {
  beforeAll(async () => {
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
  })

  // T1: 超时记录被回收（keep_alive=false）
  test("超时记录（time_updated > idleReapMs）被标记为 destroyed", async () => {
    const SID = sid("ses_reap_basic")
    await insertSandbox(SID, { ageMs: 6_000 })

    const reaped = await waitForDestroyed(SID)
    expect(reaped).toBe(true)

    await dbCleanup(SID)
  }, 40_000)

  // T2: keep_alive=true 的超时记录也被回收
  test("keep_alive=true 的超时记录也被回收", async () => {
    const SID = sid("ses_reap_keepalive")
    await insertSandbox(SID, { keepAlive: true, ageMs: 6_000 })

    const reaped = await waitForDestroyed(SID)
    expect(reaped).toBe(true)
    expect((await getSandboxState(SID))?.keep_alive).toBe(true)

    await dbCleanup(SID)
  }, 40_000)

  // 额外预检：全新记录不应被误回收
  test("未超时记录（time_updated < idleReapMs）不被回收", async () => {
    const SID = sid("ses_reap_fresh")
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

    const oldReaped = await waitForDestroyed(SID_OLD)
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
    const reaped = await waitForDestroyed(SID, 15_000)
    expect(reaped).toBe(true)

    await dbCleanup(SID)
  }, 20_000)

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
      waitForDestroyed(SID, 30_000),
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
