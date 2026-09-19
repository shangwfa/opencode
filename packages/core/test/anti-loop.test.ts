import { describe, expect, test } from "bun:test"
import { AntiLoop } from "@opencode/core/session/anti-loop"

const args = (path: string) => ({ path })

describe("anti-loop detector", () => {
  test("stableStringify is key-order independent", () => {
    expect(AntiLoop.stableStringify({ a: 1, b: 2 })).toBe(AntiLoop.stableStringify({ b: 2, a: 1 }))
    expect(AntiLoop.stableStringify({ x: { b: 1, a: [2, { d: 1, c: 2 }] } })).toBe(
      AntiLoop.stableStringify({ x: { a: [2, { c: 2, d: 1 }], b: 1 } }),
    )
    expect(AntiLoop.stableStringify(undefined)).toBe("null")
  })

  test("third identical call is blocked as repeat, then re-issue is fatal", () => {
    const loop = AntiLoop.make()
    expect(loop.check("read", args("/tmp/a"))).toEqual({ action: "allow" })
    loop.record("read", args("/tmp/a"), false)
    expect(loop.check("read", args("/tmp/a"))).toEqual({ action: "allow" })
    loop.record("read", args("/tmp/a"), false)
    const blocked = loop.check("read", args("/tmp/a"))
    expect(blocked).toMatchObject({ action: "block", signal: "repeat", count: 3, fatal: false })
    const fatal = loop.check("read", args("/tmp/a")) as Extract<AntiLoop.Verdict, { action: "block" }>
    expect(fatal).toMatchObject({ action: "block", signal: "reblocked", fatal: true })
    expect(fatal.reason).toContain("session run is aborted")
  })

  test("different key order counts as the same call", () => {
    const loop = AntiLoop.make()
    loop.record("read", { path: "/x", offset: 1 }, true)
    loop.record("read", { offset: 1, path: "/x" }, true)
    const verdict = loop.check("read", { offset: 1, path: "/x" })
    expect(verdict).toMatchObject({ action: "block", signal: "repeat" })
  })

  test("non-consecutive repeats still count within the window", () => {
    const loop = AntiLoop.make()
    loop.record("read", args("/a"), true)
    loop.record("glob", { pattern: "*" }, true)
    loop.record("read", args("/a"), true)
    expect(loop.check("read", args("/a"))).toMatchObject({ action: "block", signal: "repeat" })
  })

  test("old entries fall out of the window", () => {
    const loop = AntiLoop.make({ repeats: 3, window: 3 })
    loop.record("read", args("/a"), true)
    loop.record("glob", { pattern: "1" }, true)
    loop.record("glob", { pattern: "2" }, true)
    // window of 3 slid past the first read entry
    expect(loop.check("read", args("/a"))).toEqual({ action: "allow" })
  })

  test("consecutive failures block with signal fail and reset for recovery", () => {
    const loop = AntiLoop.make()
    loop.record("read", args("/f1"), false)
    loop.record("read", args("/f2"), false)
    loop.record("read", args("/f3"), false)
    const blocked = loop.check("read", args("/f4"))
    expect(blocked).toMatchObject({ action: "block", signal: "fail", count: 3 })
    // fail-block resets the counter: changed args retry is allowed
    expect(loop.check("read", args("/f5"))).toEqual({ action: "allow" })
    // but re-issuing the exact blocked args is fatal
    expect(loop.check("read", args("/f4"))).toMatchObject({ action: "block", fatal: true })
  })

  test("a success resets the consecutive failure count", () => {
    const loop = AntiLoop.make()
    loop.record("read", args("/f1"), false)
    loop.record("read", args("/f2"), false)
    loop.record("read", args("/ok"), true)
    loop.record("read", args("/f3"), false)
    loop.record("read", args("/f4"), false)
    expect(loop.check("read", args("/f5"))).toEqual({ action: "allow" })
  })

  test("identical failures hit repeat before the fail threshold", () => {
    const loop = AntiLoop.make()
    loop.record("read", args("/same"), false)
    loop.record("read", args("/same"), false)
    expect(loop.check("read", args("/same"))).toMatchObject({ signal: "repeat" })
  })

  test("changed args after a block are allowed (self-recovery)", () => {
    const loop = AntiLoop.make()
    loop.record("read", args("/a"), true)
    loop.record("read", args("/a"), true)
    expect(loop.check("read", args("/a"))).toMatchObject({ action: "block" })
    expect(loop.check("read", args("/b"))).toEqual({ action: "allow" })
  })

  test("thresholds clamp to at least 2", () => {
    const loop = AntiLoop.make({ repeats: 1, fails: 0 })
    loop.record("read", args("/a"), true)
    // repeats clamps to 2: the second identical call is already blockable
    expect(loop.check("read", args("/a"))).toMatchObject({ action: "block", signal: "repeat", count: 2 })
  })

  test("blocked calls never enter the window", () => {
    const loop = AntiLoop.make({ repeats: 2, window: 4 })
    loop.record("read", args("/a"), true)
    expect(loop.check("read", args("/a"))).toMatchObject({ action: "block", signal: "repeat" })
    // the blocked call itself was not recorded; window holds only the real call
    loop.record("glob", { pattern: "x" }, true)
    expect(loop.check("read", args("/a"))).toMatchObject({ fatal: true })
  })
})
