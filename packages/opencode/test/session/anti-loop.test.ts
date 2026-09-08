import { describe, expect, test } from "bun:test"
import { AntiLoop } from "../../src/session/anti-loop"

describe("AntiLoop.LoopAbortedError", () => {
  test("message is the raw reason (no permission boilerplate prefix)", () => {
    const error = new AntiLoop.LoopAbortedError({ reason: "loop killed" })
    expect(error.message).toBe("loop killed")
    expect(error._tag).toBe("AntiLoopAbortedError")
    expect(error.reason).toBe("loop killed")
  })
})

const make = (overrides: { repeats?: number; fails?: number; window?: number } = {}) =>
  AntiLoop.make(overrides)

describe("AntiLoop.stableStringify", () => {
  test("key order does not matter", () => {
    expect(AntiLoop.stableStringify({ a: 1, b: 2 })).toBe(AntiLoop.stableStringify({ b: 2, a: 1 }))
  })

  test("nested objects and arrays", () => {
    expect(AntiLoop.stableStringify({ x: [{ b: 1, a: 2 }] })).toBe(AntiLoop.stableStringify({ x: [{ a: 2, b: 1 }] }))
    expect(AntiLoop.stableStringify([1, 2])).not.toBe(AntiLoop.stableStringify([2, 1]))
  })

  test("primitives round-trip distinctly", () => {
    expect(AntiLoop.stableStringify(1)).toBe("1")
    expect(AntiLoop.stableStringify("1")).toBe('"1"')
    expect(AntiLoop.stableStringify(true)).toBe("true")
    expect(AntiLoop.stableStringify(null)).toBe("null")
    expect(AntiLoop.stableStringify({ a: undefined })).toBe(AntiLoop.stableStringify({ a: null }))
  })
})

describe("AntiLoop repeat detection", () => {
  test("third identical call is blocked, first two run", () => {
    const loop = make()
    expect(loop.check("read", { path: "/a" }).action).toBe("allow")
    loop.record("read", { path: "/a" }, true)
    expect(loop.check("read", { path: "/a" }).action).toBe("allow")
    loop.record("read", { path: "/a" }, true)
    const verdict = loop.check("read", { path: "/a" })
    expect(verdict.action).toBe("block")
    if (verdict.action === "block") {
      expect(verdict.signal).toBe("repeat")
      expect(verdict.fatal).toBe(false)
      expect(verdict.reason).toContain("read")
    }
  })

  test("different key order in args still counts as identical", () => {
    const loop = make()
    loop.record("read", { path: "/a", offset: 0 }, true)
    loop.record("read", { offset: 0, path: "/a" }, true)
    expect(loop.check("read", { path: "/a", offset: 0 }).action).toBe("block")
  })

  test("different args or tool do not count", () => {
    const loop = make()
    loop.record("read", { path: "/a" }, true)
    loop.record("read", { path: "/b" }, true)
    loop.record("grep", { path: "/a" }, true)
    expect(loop.check("read", { path: "/a" }).action).toBe("allow")
  })

  test("interleaved other calls still count (sliding window, not consecutive)", () => {
    const loop = make()
    loop.record("read", { path: "/a" }, true)
    loop.record("bash", { command: "ls" }, true)
    loop.record("read", { path: "/a" }, true)
    expect(loop.check("read", { path: "/a" }).action).toBe("block")
  })

  test("old entries fall out of the window", () => {
    const loop = make({ window: 3 })
    loop.record("read", { path: "/a" }, true)
    loop.record("bash", { command: "ls" }, true)
    loop.record("bash", { command: "pwd" }, true)
    loop.record("bash", { command: "date" }, true)
    expect(loop.check("read", { path: "/a" }).action).toBe("allow")
  })
})

describe("AntiLoop consecutive-failure detection", () => {
  test("tool failing N times in a row is blocked regardless of args", () => {
    const loop = make()
    loop.record("bash", { command: "one" }, false)
    loop.record("bash", { command: "two" }, false)
    loop.record("bash", { command: "three" }, false)
    const verdict = loop.check("bash", { command: "four" })
    expect(verdict.action).toBe("block")
    if (verdict.action === "block") expect(verdict.signal).toBe("fail")
  })

  test("success resets the failure counter", () => {
    const loop = make()
    loop.record("bash", { command: "one" }, false)
    loop.record("bash", { command: "two" }, false)
    loop.record("bash", { command: "ok" }, true)
    loop.record("bash", { command: "x" }, false)
    expect(loop.check("bash", { command: "y" }).action).toBe("allow")
  })

  test("failure counter is per tool", () => {
    const loop = make()
    loop.record("bash", { command: "one" }, false)
    loop.record("bash", { command: "two" }, false)
    loop.record("bash", { command: "three" }, false)
    expect(loop.check("read", { path: "/a" }).action).toBe("allow")
  })

  test("fail block resets the counter, changed-args retries can recover", () => {
    const loop = make()
    loop.record("bash", { command: "one" }, false)
    loop.record("bash", { command: "two" }, false)
    loop.record("bash", { command: "three" }, false)
    expect(loop.check("bash", { command: "four" }).action).toBe("block")
    // counter was reset by the block: the model fixed the root cause and retries
    expect(loop.check("bash", { command: "fixed" }).action).toBe("allow")
    // it may fail a full threshold worth of times again before the next block
    loop.record("bash", { command: "fixed" }, false)
    loop.record("bash", { command: "fixed2" }, false)
    expect(loop.check("bash", { command: "fixed3" }).action).toBe("allow")
    loop.record("bash", { command: "fixed3" }, false)
    const verdict = loop.check("bash", { command: "fixed4" })
    expect(verdict.action).toBe("block")
    if (verdict.action === "block") expect(verdict.signal).toBe("fail")
  })

  test("re-issuing the exact fail-blocked args is fatal", () => {
    const loop = make()
    loop.record("bash", { command: "one" }, false)
    loop.record("bash", { command: "two" }, false)
    loop.record("bash", { command: "three" }, false)
    expect(loop.check("bash", { command: "four" }).action).toBe("block")
    const verdict = loop.check("bash", { command: "four" })
    expect(verdict.action).toBe("block")
    if (verdict.action === "block") {
      expect(verdict.fatal).toBe(true)
      expect(verdict.signal).toBe("reblocked")
    }
  })

  test("identical failing calls hit the repeat signal before the fail signal", () => {
    const loop = make()
    loop.record("bash", { command: "boom" }, false)
    loop.record("bash", { command: "boom" }, false)
    const verdict = loop.check("bash", { command: "boom" })
    expect(verdict.action).toBe("block")
    if (verdict.action === "block") expect(verdict.signal).toBe("repeat")
  })
})

describe("AntiLoop escalation", () => {
  test("re-issuing a blocked call is fatal", () => {
    const loop = make()
    loop.record("read", { path: "/a" }, true)
    loop.record("read", { path: "/a" }, true)
    expect(loop.check("read", { path: "/a" }).action).toBe("block")
    const verdict = loop.check("read", { path: "/a" })
    expect(verdict.action).toBe("block")
    if (verdict.action === "block") {
      expect(verdict.fatal).toBe(true)
      expect(verdict.signal).toBe("reblocked")
    }
  })

  test("changing args after a block is not fatal", () => {
    const loop = make()
    loop.record("read", { path: "/a" }, true)
    loop.record("read", { path: "/a" }, true)
    expect(loop.check("read", { path: "/a" }).action).toBe("block")
    expect(loop.check("read", { path: "/b" }).action).toBe("allow")
  })

  test("blocked calls are not recorded into the window", () => {
    const loop = make({ repeats: 4 })
    loop.record("read", { path: "/a" }, true)
    loop.record("read", { path: "/a" }, true)
    expect(loop.check("read", { path: "/a" }).action).toBe("allow")
    loop.record("read", { path: "/a" }, true)
    const verdict = loop.check("read", { path: "/a" })
    expect(verdict.action).toBe("block")
    if (verdict.action === "block") expect(verdict.count).toBe(4)
  })
})

describe("AntiLoop config", () => {
  test("defaults block on the third identical call", () => {
    const loop = AntiLoop.make()
    loop.record("read", { path: "/a" }, true)
    loop.record("read", { path: "/a" }, true)
    expect(loop.check("read", { path: "/a" }).action).toBe("block")
  })

  test("thresholds clamp to a minimum of 2", () => {
    const loop = make({ repeats: 1, fails: 0 })
    expect(loop.check("read", { path: "/a" }).action).toBe("allow")
    loop.record("read", { path: "/a" }, true)
    expect(loop.check("read", { path: "/a" }).action).toBe("block")
  })

  test("repeats=2 blocks on the second identical call", () => {
    const loop = make({ repeats: 2 })
    loop.record("read", { path: "/a" }, true)
    expect(loop.check("read", { path: "/a" }).action).toBe("block")
  })

  test("window clamps up to the repeat threshold (window cannot undercut detection)", () => {
    // window=2 with default repeats=3 must clamp windowSize to 3: after two
    // identical calls plus one other, both identical records are still in the
    // window and the third call blocks. With an unclamped size of 2 the first
    // identical record would have been evicted and the call would be allowed.
    const loop = make({ window: 2 })
    loop.record("read", { path: "/a" }, true)
    loop.record("read", { path: "/a" }, true)
    loop.record("grep", { q: "x" }, true)
    const verdict = loop.check("read", { path: "/a" })
    expect(verdict.action).toBe("block")
    if (verdict.action === "block") expect(verdict.signal).toBe("repeat")
  })

  test("consecutive failure count survives window eviction", () => {
    // The fail counter is independent of the sliding window: a tool that failed
    // 3 times in a row stays blocked on its next call even when other calls
    // pushed the failing entries out of the window.
    const loop = make({ window: 3 })
    loop.record("bash", { command: "one" }, false)
    loop.record("bash", { command: "two" }, false)
    loop.record("bash", { command: "three" }, false)
    loop.record("read", { path: "/a" }, true)
    loop.record("read", { path: "/b" }, true)
    loop.record("read", { path: "/c" }, true)
    const verdict = loop.check("bash", { command: "four" })
    expect(verdict.action).toBe("block")
    if (verdict.action === "block") expect(verdict.signal).toBe("fail")
  })

  test("repeat block reason mentions the tool and guidance", () => {
    const loop = make()
    loop.record("read", { path: "/a" }, true)
    loop.record("read", { path: "/a" }, true)
    const verdict = loop.check("read", { path: "/a" })
    if (verdict.action !== "block") throw new Error("expected block")
    expect(verdict.reason).toContain('"read"')
    expect(verdict.reason).toContain("Change your approach")
    expect(verdict.reason).toContain("2 times")
  })
})
