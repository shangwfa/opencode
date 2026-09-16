import { describe, expect, test } from "bun:test"
import { getRequestUserId, normalizeUserId, PUBLIC_USER_ID, USER_ID_HEADER } from "../../src/auth/request-user"

describe("normalizeUserId", () => {
  test("returns public id for non-string input", () => {
    expect(normalizeUserId(undefined)).toBe(PUBLIC_USER_ID)
    expect(normalizeUserId(null)).toBe(PUBLIC_USER_ID)
    expect(normalizeUserId(42)).toBe(PUBLIC_USER_ID)
    expect(normalizeUserId({})).toBe(PUBLIC_USER_ID)
  })

  test("returns public id for empty or whitespace-only input", () => {
    expect(normalizeUserId("")).toBe(PUBLIC_USER_ID)
    expect(normalizeUserId("   ")).toBe(PUBLIC_USER_ID)
    expect(normalizeUserId("\t\n")).toBe(PUBLIC_USER_ID)
  })

  test("trims surrounding whitespace", () => {
    expect(normalizeUserId("  user-1  ")).toBe("user-1")
  })

  test("truncates to 128 characters", () => {
    const long = "a".repeat(200)
    expect(normalizeUserId(long)).toHaveLength(128)
    expect(normalizeUserId(long)).toBe("a".repeat(128))
  })

  test("keeps ids at or under the limit unchanged", () => {
    expect(normalizeUserId("a".repeat(128))).toBe("a".repeat(128))
  })
})

describe("getRequestUserId", () => {
  test("reads the x-user-id header", () => {
    expect(getRequestUserId({ [USER_ID_HEADER]: "user-1" })).toBe("user-1")
  })

  test("returns public id when the header is missing", () => {
    expect(getRequestUserId({})).toBe(PUBLIC_USER_ID)
    expect(getRequestUserId({ other: "user-1" })).toBe(PUBLIC_USER_ID)
  })

  test("takes the first value when the header repeats", () => {
    expect(getRequestUserId({ [USER_ID_HEADER]: ["user-1", "user-2"] })).toBe("user-1")
  })

  test("normalizes empty and whitespace headers to public id", () => {
    expect(getRequestUserId({ [USER_ID_HEADER]: "" })).toBe(PUBLIC_USER_ID)
    expect(getRequestUserId({ [USER_ID_HEADER]: "   " })).toBe(PUBLIC_USER_ID)
  })

  test("truncates and trims header values", () => {
    expect(getRequestUserId({ [USER_ID_HEADER]: " user-1 " })).toBe("user-1")
    expect(getRequestUserId({ [USER_ID_HEADER]: "a".repeat(200) })).toBe("a".repeat(128))
  })
})
