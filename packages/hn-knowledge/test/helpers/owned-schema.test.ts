import { describe, expect, mock, test } from "bun:test"
import { createOwnedTestSchema } from "./owned-schema.js"

describe("E2E schema ownership", () => {
  test("uses a unique schema instead of inherited business configuration", () => {
    const first = createOwnedTestSchema("database")
    const second = createOwnedTestSchema("database")
    expect(first.name).toMatch(/^knowledge_test_database_[a-f0-9]{32}$/)
    expect(first.name).not.toBe(second.name)
    expect(first.name.length).toBeLessThanOrEqual(63)
  })

  test("rejects invalid suite names", () => {
    expect(() => createOwnedTestSchema('business"; DROP SCHEMA knowledge')).toThrow()
    expect(() => createOwnedTestSchema("a".repeat(30))).toThrow()
  })

  test("refuses a cached database module configured for another schema", async () => {
    const schema = createOwnedTestSchema("database")
    const query = mock(async (_sql: string) => undefined)
    await expect(schema.prepare({ query }, "knowledge")).rejects.toThrow("schema mismatch")
    await schema.cleanup({ query })
    expect(query).not.toHaveBeenCalled()
  })

  test("failed creation does not authorize cleanup of an existing schema", async () => {
    const schema = createOwnedTestSchema("database")
    const query = mock(async (_sql: string) => { throw new Error("schema already exists") })
    await expect(schema.prepare({ query }, schema.name)).rejects.toThrow("already exists")
    await schema.cleanup({ query })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]![0]).toBe(`CREATE SCHEMA "${schema.name}"`)
  })

  test("cleanup only drops the successfully created immutable schema, once", async () => {
    const schema = createOwnedTestSchema("database")
    const query = mock(async (_sql: string) => undefined)
    await schema.prepare({ query }, schema.name)
    await schema.cleanup({ query })
    await schema.cleanup({ query })
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      `CREATE SCHEMA "${schema.name}"`,
      `DROP SCHEMA IF EXISTS "${schema.name}" CASCADE`,
    ])
  })

  test("cleanup failure remains visible and permits retry", async () => {
    const schema = createOwnedTestSchema("database")
    const query = mock(async (_sql: string) => undefined)
    await schema.prepare({ query }, schema.name)
    query.mockRejectedValueOnce(new Error("connection lost"))
    await expect(schema.cleanup({ query })).rejects.toThrow("connection lost")
    await schema.cleanup({ query })
    expect(query).toHaveBeenCalledTimes(3)
  })
})
