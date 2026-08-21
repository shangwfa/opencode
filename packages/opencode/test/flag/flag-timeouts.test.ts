import { describe, expect, test } from "bun:test"
import { Flag } from "../../src/flag/flag"

describe("timeout flags added for lock/pg hang protection", () => {
  test("OPENCODE_SESSION_LOCK_TIMEOUT_SEC defaults to 60", () => {
    if (process.env["OPENCODE_SESSION_LOCK_TIMEOUT_SEC"] === undefined) {
      expect(Flag.OPENCODE_SESSION_LOCK_TIMEOUT_SEC).toBe(60)
    }
  })

  test("OPENCODE_PG_STATEMENT_TIMEOUT_MS defaults to 30000", () => {
    if (process.env["OPENCODE_PG_STATEMENT_TIMEOUT_MS"] === undefined) {
      expect(Flag.OPENCODE_PG_STATEMENT_TIMEOUT_MS).toBe(30000)
    }
  })
})
