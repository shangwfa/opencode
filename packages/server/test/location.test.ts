import { describe, expect, test } from "bun:test"
import type { HttpServerRequest } from "effect/unstable/http"
import { normalizeUserID, requestUserID, requestUserName } from "../src/location"

const request = (headers: Record<string, string | undefined>) =>
  ({ headers }) as unknown as HttpServerRequest.HttpServerRequest

describe("session user identity headers", () => {
  test("normalizeUserID trims, caps at 128, and blanks to the public bucket", () => {
    expect(normalizeUserID("  user-a  ")).toBe("user-a")
    expect(normalizeUserID("   ")).toBe("")
    expect(normalizeUserID(undefined)).toBe("")
    expect(normalizeUserID(42)).toBe("")
    expect(normalizeUserID("x".repeat(200))).toHaveLength(128)
  })

  test("requestUserID reads x-user-id and normalizes it", () => {
    expect(requestUserID(request({ "x-user-id": " user-a " }))).toBe("user-a")
    expect(requestUserID(request({}))).toBe("")
  })

  test("requestUserName reads x-user-name so v1 userName lands on the user message", () => {
    expect(requestUserName(request({ "x-user-name": " alice " }))).toBe("alice")
    expect(requestUserName(request({ "x-user-name": "   " }))).toBe("")
    expect(requestUserName(request({}))).toBe("")
    expect(requestUserName(request({ "x-user-name": "n".repeat(200) }))).toHaveLength(128)
  })
})
