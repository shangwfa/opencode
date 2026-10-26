import { describe, expect, test } from "bun:test"
import { ConnectionConfig } from "@alibaba-group/opensandbox"
import { Clock, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { SandboxSnapshot } from "../src/sandbox/opensandbox/snapshot/index"
import type { State } from "../src/sandbox/opensandbox/snapshot/tables.sql"
import { it } from "./lib/effect"

type RemoteStatus = { state: "Creating" | "Ready" | "Failed"; reason?: string; message?: string }

const fixture = (query: (elapsed: number, calls: number) => RemoteStatus | Error | Promise<RemoteStatus>, opts?: {
  waitMs?: number
  persist?: boolean
  storedState?: State
  persistenceFailure?: boolean
}) => Clock.clockWith((clock) => Effect.sync(() => {
  const start = clock.currentTimeMillisUnsafe()
  const calls: number[] = []
  const updates: Array<{ state: State; reason: string | null }> = []
  const row: { state: State; reason: string | null } = { state: opts?.storedState ?? "creating", reason: null }
  const db = {
    update: () => ({
      set: (values: { state: State; reason: string | null }) => ({
        where: () => ({
          returning: () => ({ all: () => Effect.suspend(() => {
            if (opts?.persistenceFailure) return Effect.fail(new Error("PG unavailable"))
            if (opts?.persist === false) return Effect.succeed([])
            updates.push(values)
            Object.assign(row, values)
            return Effect.succeed([{ id: "snapshot" }])
          }) }),
        }),
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({
      all: () => Effect.succeed([]), // 无历史 failed 快照需要清理
      limit: () => ({ all: () => Effect.sync(() => [row]) }),
    }) }) }),
  }
  const service = SandboxSnapshot.create({
    db, ttlMs: 60_000, waitMs: opts?.waitMs ?? 120_000, deleteEnabled: true,
    connectionConfig: new ConnectionConfig({ domain: "127.0.0.1:1", protocol: "http" }),
    manager: {
      createSnapshot: async () => { throw new Error("等待状态不得重新创建快照") },
      deleteSnapshot: async () => { throw new Error("等待状态不得删除恢复点") },
      getSnapshot: async () => {
        const elapsed = clock.currentTimeMillisUnsafe() - start
        calls.push(elapsed)
        const status = await query(elapsed, calls.length)
        if (status instanceof Error) throw status
        return { id: "snapshot", sandboxId: "sandbox", createdAt: new Date(start), status }
      },
    },
  })
  return { service, row, calls, updates }
}))

describe("快照状态轮询", () => {
  test("正常窗口 1 秒，长任务回到 5 秒", () => {
    expect(SandboxSnapshot.snapshotPollIntervalMs(0)).toBe(1000)
    expect(SandboxSnapshot.snapshotPollIntervalMs(59_999)).toBe(1000)
    expect(SandboxSnapshot.snapshotPollIntervalMs(60_000)).toBe(5000)
    expect(SandboxSnapshot.snapshotPollIntervalMs(900_000)).toBe(5000)
  })

  test("接口错误退避 2/4/5 秒且有上限", () => {
    expect([1, 2, 3, 1000].map((errors) => SandboxSnapshot.snapshotPollIntervalMs(0, errors))).toEqual([2000, 4000, 5000, 5000])
  })

  it.effect("立即查询 Ready，无需初始 sleep", () => Effect.gen(function* () {
    const f = yield* fixture(() => ({ state: "Ready" }))
    expect(yield* f.service.awaitSnapshot("session", "snapshot")).toBe("ready")
    expect(f.calls).toEqual([0])
    expect(f.row.state).toBe("ready")
  }))

  it.effect("1 秒内完成的快照在第 1 秒被发现，而不是等待 5 秒", () => Effect.gen(function* () {
    const f = yield* fixture((elapsed) => ({ state: elapsed >= 200 ? "Ready" : "Creating" }))
    const fiber = yield* f.service.awaitSnapshot("session", "snapshot").pipe(Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust("1 second")
    expect(yield* Fiber.join(fiber)).toBe("ready")
    expect(f.calls).toEqual([0, 1000])
  }))

  it.effect("60 秒后稀疏轮询，不对长任务持续每秒请求", () => Effect.gen(function* () {
    const f = yield* fixture((elapsed) => ({ state: elapsed >= 65_000 ? "Ready" : "Creating" }))
    const fiber = yield* f.service.awaitSnapshot("session", "snapshot").pipe(Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust("65 seconds")
    expect(yield* Fiber.join(fiber)).toBe("ready")
    expect(f.calls.slice(-3)).toEqual([59_000, 60_000, 65_000])
    expect(f.calls).toHaveLength(62)
  }))

  it.effect("接口失败退避，成功 Creating 后恢复正常频率", () => Effect.gen(function* () {
    const f = yield* fixture((_elapsed, calls) => calls <= 2 ? new Error("transport") : { state: calls >= 4 ? "Ready" : "Creating" })
    const fiber = yield* f.service.awaitSnapshot("session", "snapshot").pipe(Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust("7 seconds")
    expect(yield* Fiber.join(fiber)).toBe("ready")
    expect(f.calls).toEqual([0, 2000, 6000, 7000])
    expect(f.row.state).toBe("ready")
  }))

  it.effect("持续接口失败最多每 5 秒请求，超时不伪造 Failed", () => Effect.gen(function* () {
    const f = yield* fixture(() => new Error("transport"), { waitMs: 16_000 })
    const fiber = yield* f.service.awaitSnapshot("session", "snapshot").pipe(Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust("16 seconds")
    expect(yield* Fiber.join(fiber)).toBe("timeout")
    expect(f.calls).toEqual([0, 2000, 6000, 11_000])
    expect(f.row.state).toBe("creating")
  }))

  it.effect("短等待精确截止，不额外 sleep 到 1 或 5 秒", () => Effect.gen(function* () {
    const f = yield* fixture(() => ({ state: "Creating", reason: "busy" }), { waitMs: 250 })
    const fiber = yield* f.service.awaitSnapshot("session", "snapshot").pipe(Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust("250 millis")
    expect(yield* Fiber.join(fiber)).toBe("timeout")
    expect(f.calls).toEqual([0])
    expect(f.row).toMatchObject({ state: "creating", reason: "wait timeout: busy" })
  }))

  it.effect("零等待不发查询，仍保留 Creating 恢复状态", () => Effect.gen(function* () {
    const f = yield* fixture(() => ({ state: "Ready" }), { waitMs: 0 })
    expect(yield* f.service.awaitSnapshot("session", "snapshot")).toBe("timeout")
    expect(f.calls).toEqual([])
    expect(f.row.state).toBe("creating")
  }))

  it.effect("单次等待覆盖配置预算，截止前不多发一次查询", () => Effect.gen(function* () {
    const f = yield* fixture(() => ({ state: "Creating" }), { waitMs: 120_000 })
    const fiber = yield* f.service.awaitSnapshot("session", "snapshot", 1500).pipe(Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust("1500 millis")
    expect(yield* Fiber.join(fiber)).toBe("timeout")
    expect(f.calls).toEqual([0, 1000])
  }))

  it.effect("查询越过截止时间，不再额外睡眠", () => Effect.gen(function* () {
    let release = () => {}
    const pending = new Promise<RemoteStatus>((resolve) => { release = () => resolve({ state: "Creating" }) })
    const f = yield* fixture(() => pending, { waitMs: 500 })
    const fiber = yield* f.service.awaitSnapshot("session", "snapshot").pipe(Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust("1 second")
    release()
    expect(yield* Fiber.join(fiber)).toBe("timeout")
    expect(f.calls).toEqual([0])
  }))

  it.effect("远端 Failed 立即落库并保留错误详情", () => Effect.gen(function* () {
    const f = yield* fixture(() => ({ state: "Failed", reason: "commit", message: "disk full" }))
    expect(yield* f.service.awaitSnapshot("session", "snapshot")).toBe("failed")
    expect(f.calls).toEqual([0])
    expect(f.row).toMatchObject({ state: "failed", reason: "server Failed: commit: disk full" })
  }))

  it.effect("远端 Ready 但 PG 未确认，不返回 ready", () => Effect.gen(function* () {
    const f = yield* fixture(() => ({ state: "Ready" }), { persist: false })
    expect(yield* f.service.awaitSnapshot("session", "snapshot")).toBe("failed")
    expect(f.row.state).toBe("creating")
  }))

  it.effect("另一观察者已持久化 Ready，条件更新丢失后仍可收敛", () => Effect.gen(function* () {
    const f = yield* fixture(() => ({ state: "Ready" }), { persist: false, storedState: "ready" })
    expect(yield* f.service.awaitSnapshot("session", "snapshot")).toBe("ready")
    expect(f.updates).toEqual([])
  }))

  it.effect("PG 更新异常不伪造 ready", () => Effect.gen(function* () {
    const f = yield* fixture(() => ({ state: "Ready" }), { persistenceFailure: true })
    expect(yield* f.service.awaitSnapshot("session", "snapshot")).toBe("failed")
    expect(f.row.state).toBe("creating")
  }))

  it.effect("中断轮询不会发布 Ready 或改为 Failed", () => Effect.gen(function* () {
    const f = yield* fixture(() => ({ state: "Creating" }))
    const fiber = yield* f.service.awaitSnapshot("session", "snapshot").pipe(Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust("1 second")
    yield* Fiber.interrupt(fiber)
    const calls = f.calls.length
    yield* TestClock.adjust("10 seconds")
    expect(f.calls).toHaveLength(calls)
    expect(f.row.state).toBe("creating")
    expect(f.updates).toEqual([])
  }))
})
