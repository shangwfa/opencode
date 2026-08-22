import { describe, expect, test } from "bun:test"
import { init } from "../../src/storage/db.pg"
import { Flag } from "../../src/flag/flag"

describe("db.pg connection GUC injection", () => {
  test("injects statement_timeout into connection startup params", () => {
    const { client } = init("postgres://user:pass@localhost:5432/db")
    expect(client.options.connection.statement_timeout).toBe(Flag.OPENCODE_PG_STATEMENT_TIMEOUT_MS)
  })

  test("injects lock_timeout into connection startup params", () => {
    const { client } = init("postgres://user:pass@localhost:5432/db")
    expect(client.options.connection.lock_timeout).toBe(Flag.OPENCODE_PG_STATEMENT_TIMEOUT_MS)
  })

  test("preserves existing pool tuning options", () => {
    const { client } = init("postgres://user:pass@localhost:5432/db")
    expect(client.options.max).toBe(20)
    expect(client.options.connect_timeout).toBe(10)
    expect(client.options.idle_timeout).toBe(30)
    expect(client.options.max_lifetime).toBe(600)
  })
})
