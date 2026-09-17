import { describe, expect, test } from "bun:test"
import { stripNullBytes, withRetry, isTransientConnectionError } from "../../src/session/projectors"

describe("projectors.stripNullBytes", () => {
  test("strips null bytes from strings", () => {
    expect(stripNullBytes("hello\x00world")).toBe("helloworld")
    expect(stripNullBytes("\x00\x00")).toBe("")
    expect(stripNullBytes("clean")).toBe("clean")
  })

  test("strips null bytes from nested objects", () => {
    const input = { a: "hello\x00", b: { c: "x\x00y\x00" }, d: 42 }
    const result = stripNullBytes(input) as any
    expect(result.a).toBe("hello")
    expect(result.b.c).toBe("xy")
    expect(result.d).toBe(42)
  })

  test("strips null bytes from arrays", () => {
    const input = ["a\x00b", "c\x00d", 123]
    const result = stripNullBytes(input) as any[]
    expect(result[0]).toBe("ab")
    expect(result[1]).toBe("cd")
    expect(result[2]).toBe(123)
  })

  test("handles null and undefined", () => {
    expect(stripNullBytes(null)).toBeNull()
    expect(stripNullBytes(undefined)).toBeUndefined()
  })

  test("handles deep nesting", () => {
    const input = { outer: { inner: { deep: "a\x00b\x00c" } } }
    const result = stripNullBytes(input) as any
    expect(result.outer.inner.deep).toBe("abc")
  })

  test("does not mutate original object", () => {
    const input = { a: "hello\x00world" }
    stripNullBytes(input)
    expect(input.a).toBe("hello\x00world")
  })
})

describe("projectors.isTransientConnectionError", () => {
  test("detects CONNECTION_CLOSED", () => {
    expect(isTransientConnectionError(new Error("write CONNECTION_CLOSED host:5432"))).toBeTrue()
  })

  test("detects CONNECTION_TIMEOUT", () => {
    expect(isTransientConnectionError(new Error("write CONNECT_TIMEOUT 172.18.32.14:5432"))).toBeTrue()
  })

  test("detects ECONNRESET", () => {
    expect(isTransientConnectionError(new Error("ECONNRESET socket hang up"))).toBeTrue()
  })

  test("rejects non-transient errors", () => {
    expect(isTransientConnectionError(new Error("invalid input syntax for type json"))).toBeFalse()
    expect(isTransientConnectionError(new Error("permission denied"))).toBeFalse()
    expect(isTransientConnectionError("not an error")).toBeFalse()
    expect(isTransientConnectionError(null)).toBeFalse()
    expect(isTransientConnectionError(undefined)).toBeFalse()
  })

  test("is case-insensitive", () => {
    expect(isTransientConnectionError(new Error("connection_closed"))).toBeTrue()
    expect(isTransientConnectionError(new Error("connect_timeout"))).toBeTrue()
    expect(isTransientConnectionError(new Error("ECONNRESET"))).toBeTrue()
  })
})

describe("projectors.withRetry", () => {
  test("returns result on first success", async () => {
    let calls = 0
    const result = await withRetry(async () => {
      calls++
      return "ok"
    })
    expect(result).toBe("ok")
    expect(calls).toBe(1)
  })

  test("retries on transient error then succeeds", async () => {
    let calls = 0
    const result = await withRetry(async () => {
      calls++
      if (calls < 3) throw new Error("write CONNECTION_CLOSED host:5432")
      return "ok"
    })
    expect(result).toBe("ok")
    expect(calls).toBe(3)
  })

  test("throws after exhausting retries", async () => {
    let calls = 0
    await expect(
      withRetry(async () => {
        calls++
        throw new Error("write CONNECTION_CLOSED host:5432")
      }, 2),
    ).rejects.toThrow("CONNECTION_CLOSED")
    expect(calls).toBe(3) // 1 initial + 2 retries
  })

  test("does not retry non-transient errors", async () => {
    let calls = 0
    await expect(
      withRetry(async () => {
        calls++
        throw new Error("permission denied")
      }),
    ).rejects.toThrow("permission denied")
    expect(calls).toBe(1)
  })

  test("respects custom retry count", async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error("ECONNRESET")
        },
        5,
      ),
    ).rejects.toThrow("ECONNRESET")
    expect(calls).toBe(6) // 1 initial + 5 retries
  })
})
