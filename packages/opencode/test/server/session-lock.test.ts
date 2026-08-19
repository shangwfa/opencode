/**
 * session-lock PG advisory lock 单元测试
 *
 * 验证跨实例互斥的核心行为：
 * - withSessionLock 成功/失败/缺陷路径均释放 advisory lock
 * - 持锁期间外部连接（模拟其他 pod）pg_try_advisory_lock 被挡
 * - 嵌套 withSessionLock 同一 session 复用已持锁（不自死锁）
 * - 不同 session 可并行持锁
 * - 外部持锁时 withSessionLock 按 OPENCODE_SESSION_LOCK_TIMEOUT_SEC 超时
 *
 * 运行方式（需本地 PG opencode_test 库）：
 *   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:5432/opencode_test \
   OPENCODE_SESSION_LOCK_TIMEOUT_SEC=1 \
 *   bun test test/server/session-lock.test.ts
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { withSessionLock, waitForSessionLock, advisoryKey } from "../../src/server/routes/instance/httpapi/handlers/session-lock"
import { SessionID } from "../../src/session/schema"
import postgres from "postgres"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()

// 模拟「另一个 pod」的独立连接：advisory lock 与连接绑定，
// 必须用单独客户端验证互斥
let otherPod: postgres.Sql<any> | undefined
const sid = "sess_lock_001" as SessionID
const sid2 = "sess_lock_002" as SessionID

beforeAll(() => {
  if (enabled) otherPod = postgres(DB_URL!, { max: 1 }) as any
})

afterAll(async () => {
  if (otherPod) await otherPod.end()
})

describe("advisoryKey", () => {
  test("stable and distinct", () => {
    expect(advisoryKey(sid)).toBe(advisoryKey(sid))
    expect(advisoryKey(sid)).not.toBe(advisoryKey(sid2))
    // signed bigint text
    expect(advisoryKey(sid)).toMatch(/^-?\d+$/)
  })
})

describe.skipIf(!enabled)("withSessionLock (PG)", () => {
  test("acquires and releases lock on success", async () => {
    await Effect.runPromise(withSessionLock(sid, Effect.succeed("ok")))
    const rows = await otherPod!`select pg_try_advisory_lock(${advisoryKey(sid)}::bigint) as ok`
    expect(rows[0].ok).toBe(true)
    await otherPod!`select pg_advisory_unlock(${advisoryKey(sid)}::bigint)`
  })

  test("releases lock on failure", async () => {
    const exit = await Effect.runPromiseExit(withSessionLock(sid, Effect.fail("err")))
    expect(Exit.isFailure(exit)).toBe(true)
    const rows = await otherPod!`select pg_try_advisory_lock(${advisoryKey(sid)}::bigint) as ok`
    expect(rows[0].ok).toBe(true)
    await otherPod!`select pg_advisory_unlock(${advisoryKey(sid)}::bigint)`
  })

  test("releases lock on defect", async () => {
    const exit = await Effect.runPromiseExit(withSessionLock(sid, Effect.die(new Error("boom"))))
    expect(Exit.isFailure(exit)).toBe(true)
    const rows = await otherPod!`select pg_try_advisory_lock(${advisoryKey(sid)}::bigint) as ok`
    expect(rows[0].ok).toBe(true)
    await otherPod!`select pg_advisory_unlock(${advisoryKey(sid)}::bigint)`
  })

  test("blocks other pods while held", async () => {
    let blocked = false
    await Effect.runPromise(
      withSessionLock(sid, Effect.promise(async () => {
        const rows = await otherPod!`select pg_try_advisory_lock(${advisoryKey(sid)}::bigint) as ok`
        blocked = rows[0].ok !== true
      })),
    )
    expect(blocked).toBe(true)
  })

  test("serializes independent requests on the same pod", async () => {
    let enterA!: () => void
    let releaseA!: () => void
    let enteredB = false
    const entered = new Promise<void>((resolve) => { enterA = resolve })
    const release = new Promise<void>((resolve) => { releaseA = resolve })
    const a = Effect.runPromise(withSessionLock(sid, Effect.promise(async () => {
      enterA()
      await release
    })))
    await entered
    const b = Effect.runPromise(withSessionLock(sid, Effect.sync(() => { enteredB = true })))
    await Bun.sleep(250)
    expect(enteredB).toBe(false)
    releaseA()
    await Promise.all([a, b])
    expect(enteredB).toBe(true)
  })

  test("releases the lock when the holder fiber is interrupted", async () => {
    let entered!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const fiber = Effect.runFork(withSessionLock(sid, Effect.sync(entered).pipe(Effect.andThen(Effect.never))))
    await ready
    const blocked = await otherPod!`select pg_try_advisory_lock(${advisoryKey(sid)}::bigint) as ok`
    expect(blocked[0].ok).toBe(false)
    await Effect.runPromise(Fiber.interrupt(fiber))
    const acquired = await otherPod!`select pg_try_advisory_lock(${advisoryKey(sid)}::bigint) as ok`
    expect(acquired[0].ok).toBe(true)
    await otherPod!`select pg_advisory_unlock(${advisoryKey(sid)}::bigint)`
  })

  test("different sessions hold locks concurrently", async () => {
    let bothHeld = false
    await Effect.runPromise(
      withSessionLock(
        sid,
        Effect.promise(async () => {
          const rows = await otherPod!`select pg_try_advisory_lock(${advisoryKey(sid2)}::bigint) as ok`
          bothHeld = rows[0].ok === true
          if (bothHeld) await otherPod!`select pg_advisory_unlock(${advisoryKey(sid2)}::bigint)`
        }),
      ),
    )
    expect(bothHeld).toBe(true)
  })

  test("returns the effect result", async () => {
    expect(await Effect.runPromise(withSessionLock(sid, Effect.succeed(42)))).toBe(42)
  })

  test("times out when another pod holds the lock", async () => {
    await otherPod!`select pg_advisory_lock(${advisoryKey(sid)}::bigint)`
    const start = Date.now()
    const exit = await Effect.runPromiseExit(withSessionLock(sid, Effect.succeed("never")))
    const elapsed = Date.now() - start
    await otherPod!`select pg_advisory_unlock(${advisoryKey(sid)}::bigint)`
    expect(Exit.isFailure(exit)).toBe(true)
    // OPENCODE_SESSION_LOCK_TIMEOUT_SEC=1（见文件头运行方式），轮询间隔 100ms
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(elapsed).toBeLessThan(5000)
  })

  test("times out while waiting for a saturated lock connection pool", async () => {
    const releases: Array<() => void> = []
    const ready = Array.from({ length: 8 }, () => {
      let enter!: () => void
      const promise = new Promise<void>((resolve) => { enter = resolve })
      return { promise, enter }
    })
    const holders = ready.map((item, index) => {
      let release!: () => void
      const wait = new Promise<void>((resolve) => { release = resolve })
      releases.push(release)
      return Effect.runPromise(
        withSessionLock(SessionID.make(`sess_pool_${index}`), Effect.promise(async () => {
          item.enter()
          await wait
        })),
      )
    })
    await Promise.all(ready.map((item) => item.promise))
    const start = Date.now()
    const exit = await Effect.runPromiseExit(
      withSessionLock(SessionID.make("sess_pool_waiter"), Effect.void),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Date.now() - start).toBeLessThan(5000)
    releases.forEach((release) => release())
    await Promise.all(holders)
  }, 10_000)
})

describe("waitForSessionLock", () => {
  test("is a no-op in PG mode", async () => {
    await Effect.runPromise(waitForSessionLock(sid))
  })
})
