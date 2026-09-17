import { describe, expect, test, afterEach } from "bun:test"
import { Effect, Exit } from "effect"
import { withSessionLock, waitForSessionLock, _getLockCount, _clearLocks } from "../../src/server/routes/instance/httpapi/handlers/session-lock"
import { SessionID } from "../../src/session/schema"

const sid = "sess_001" as SessionID
const sid2 = "sess_002" as SessionID

async function pollUntil(pred: () => boolean, ms: number) {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) await Bun.sleep(5)
}

afterEach(() => {
  _clearLocks()
})

describe("withSessionLock", () => {
  test("acquires and releases lock on success", async () => {
    await Effect.runPromise(withSessionLock(sid, Effect.succeed("ok")))
    expect(_getLockCount(sid)).toBe(0)
  })

  test("acquires and releases lock on failure", async () => {
    const exit = await Effect.runPromiseExit(withSessionLock(sid, Effect.fail("err")))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(_getLockCount(sid)).toBe(0)
  })

  test("acquires and releases lock on defect", async () => {
    const exit = await Effect.runPromiseExit(
      withSessionLock(sid, Effect.die(new Error("boom"))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(_getLockCount(sid)).toBe(0)
  })

  test("lock is held during execution", async () => {
    let countDuringExecution = -1
    await Effect.runPromise(
      withSessionLock(
        sid,
        Effect.sync(() => {
          countDuringExecution = _getLockCount(sid)
        }),
      ),
    )
    expect(countDuringExecution).toBe(1)
    expect(_getLockCount(sid)).toBe(0)
  })

  test("supports nested locks on same session", async () => {
    await Effect.runPromise(
      withSessionLock(sid, withSessionLock(sid, Effect.succeed("nested"))),
    )
    expect(_getLockCount(sid)).toBe(0)
  })

  test("different sessions have independent locks", async () => {
    let sid2CountDuringSid1Lock = -1
    await Effect.runPromise(
      withSessionLock(
        sid,
        Effect.sync(() => {
          sid2CountDuringSid1Lock = _getLockCount(sid2)
        }),
      ),
    )
    expect(sid2CountDuringSid1Lock).toBe(0)
  })

  test("returns the effect result", async () => {
    const result = await Effect.runPromise(withSessionLock(sid, Effect.succeed(42)))
    expect(result).toBe(42)
  })
})

describe("waitForSessionLock", () => {
  test("returns immediately when no lock", async () => {
    await Effect.runPromise(waitForSessionLock(sid))
  })

  test("does not wait for different session lock", async () => {
    let waited = false
    await Effect.runPromise(
      withSessionLock(
        sid,
        Effect.gen(function* () {
          yield* waitForSessionLock(sid2)
          waited = true
        }),
      ),
    )
    expect(waited).toBe(true)
  })

  test("fails with ServiceUnavailable when lock is held past timeout", async () => {
    Effect.runFork(withSessionLock(sid, Effect.sleep("300 millis")))
    await pollUntil(() => _getLockCount(sid) === 1, 1000)
    expect(_getLockCount(sid)).toBe(1)

    const exit = await Effect.runPromiseExit(waitForSessionLock(sid, 0.05))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("ServiceUnavailable")

    await pollUntil(() => _getLockCount(sid) === 0, 2000)
    expect(_getLockCount(sid)).toBe(0)
  })

  test("succeeds within timeout after lock release", async () => {
    Effect.runFork(withSessionLock(sid, Effect.sleep("100 millis")))
    await pollUntil(() => _getLockCount(sid) === 0, 2000)
    const exit = await Effect.runPromiseExit(waitForSessionLock(sid, 5))
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

describe("withSessionLock + waitForSessionLock integration", () => {
  test("waiter sees unlocked state after lock release", async () => {
    await Effect.runPromise(withSessionLock(sid, Effect.succeed("done")))
    expect(_getLockCount(sid)).toBe(0)
    await Effect.runPromise(waitForSessionLock(sid))
  })

  test("sequential lock/wait pattern", async () => {
    let step1 = false
    let step2 = false

    await Effect.runPromise(
      withSessionLock(
        sid,
        Effect.gen(function* () {
          step1 = true
          expect(_getLockCount(sid)).toBe(1)
        }),
      ),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* waitForSessionLock(sid)
        step2 = true
      }),
    )

    expect(step1).toBe(true)
    expect(step2).toBe(true)
  })
})
