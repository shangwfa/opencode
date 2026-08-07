import { describe, expect, test } from "bun:test"
import { ToolExecution } from "../../src/session/tool-execution"

describe("ToolExecution", () => {
  test("interrupt aborts the registered execution", () => {
    const controller = new AbortController()
    const unregister = ToolExecution.register("ses_test", "call_test", controller)

    expect(ToolExecution.has("ses_test", "call_test")).toBe(true)
    expect(ToolExecution.callIDs()).toContain("call_test")
    expect(ToolExecution.interrupt("ses_test", "call_test")).toBe(true)
    expect(controller.signal.aborted).toBe(true)

    unregister()
    expect(ToolExecution.has("ses_test", "call_test")).toBe(false)
    expect(ToolExecution.interrupt("ses_test", "call_test")).toBe(false)
  })

  test("stale cleanup does not unregister a replacement", () => {
    const first = new AbortController()
    const second = new AbortController()
    const unregisterFirst = ToolExecution.register("ses_test", "call_replace", first)
    const unregisterSecond = ToolExecution.register("ses_test", "call_replace", second)

    unregisterFirst()
    expect(ToolExecution.interrupt("ses_test", "call_replace")).toBe(true)
    expect(first.signal.aborted).toBe(false)
    expect(second.signal.aborted).toBe(true)

    unregisterSecond()
  })

  test("same call ID is isolated by session", () => {
    const first = new AbortController()
    const second = new AbortController()
    const unregisterFirst = ToolExecution.register("ses_first", "call_shared", first)
    const unregisterSecond = ToolExecution.register("ses_second", "call_shared", second)

    expect(ToolExecution.interrupt("ses_first", "call_shared")).toBe(true)
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)

    unregisterFirst()
    unregisterSecond()
  })
})
