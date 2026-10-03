import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Logger } from "effect"
import { TestClock } from "effect/testing"
import { measureSnapshotStage } from "../src/sandbox/snapshot-latency"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const fixture = () => {
  const logs: unknown[] = []
  const logger = Logger.make((options) => { logs.push(options.message) })
  return { logs, layer: Logger.layer([logger], { mergeWithExisting: false }) }
}

describe("快照阶段计时", () => {
  it.effect("记录相关标识和耗时，不修改成功值", () => Effect.gen(function* () {
    const f = fixture()
    const work = measureSnapshotStage({ sessionID: "session", sandboxID: "sandbox", operationID: "operation" }, "manifest", Effect.sleep("250 millis").pipe(Effect.as("value")))
    const fiber = yield* work.pipe(Effect.provide(f.layer), Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust("250 millis")
    expect(yield* Fiber.join(fiber)).toBe("value")
    expect(f.logs).toEqual([["snapshot stage", { sessionID: "session", sandboxID: "sandbox", operationID: "operation", stage: "manifest", ms: 250, outcome: "success" }]])
  }))

  it.effect("记录失败且保留原 typed error，不转为成功", () => Effect.gen(function* () {
    const f = fixture()
    const error = new Error("original")
    const result = yield* measureSnapshotStage({ snapshotID: "snapshot" }, "create_request", Effect.fail(error)).pipe(Effect.provide(f.layer), Effect.result)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure).toBe(error)
    expect(f.logs).toEqual([["snapshot stage", { snapshotID: "snapshot", stage: "create_request", ms: 0, outcome: "failure" }]])
  }))

  it.effect("中断仍记录已等待时间，不恢复执行", () => Effect.gen(function* () {
    const f = fixture()
    let continued = false
    const fiber = yield* measureSnapshotStage({}, "settle", Effect.never.pipe(Effect.andThen(Effect.sync(() => { continued = true })))).pipe(Effect.provide(f.layer), Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust("1 second")
    yield* Fiber.interrupt(fiber)
    expect(continued).toBe(false)
    expect(f.logs).toEqual([["snapshot stage", { stage: "settle", ms: 1000, outcome: "failure" }]])
  }))

  it.effect("计时 effect 重用时不累计之前的开始时间", () => Effect.gen(function* () {
    const f = fixture()
    const work = measureSnapshotStage({}, "connect", Effect.succeed("ok")).pipe(Effect.provide(f.layer))
    yield* work
    yield* TestClock.adjust("5 seconds")
    yield* work
    expect(f.logs).toHaveLength(2)
    expect(f.logs[1]).toEqual(["snapshot stage", { stage: "connect", ms: 0, outcome: "success" }])
  }))
})
