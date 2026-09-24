import { afterAll, beforeAll, expect, test } from "bun:test"
import postgres from "postgres"
import { DatabasePg } from "@opencode/core/database/pg"

// The compat functions only exist on PG; run when a test URL is provided.
// Example: PG_TEST_URL=postgresql://local@127.0.0.1:5432/postgres bun test ...
const url = process.env.PG_TEST_URL
const maybe = url ? test : test.skip

const shellRow = JSON.stringify({
  metadata: { background: true },
  time: { created: 1790167486681 },
  shellID: "sh_0ce4c10d7001K156IRYpvDeGJP",
  command: "rm -rf /workspace/test-project",
  status: "running",
})

let client: ReturnType<typeof postgres> | undefined

beforeAll(async () => {
  if (!url) return
  client = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
  await client.unsafe(DatabasePg.COMPAT_DDL)
})

afterAll(async () => {
  await client?.end({ timeout: 5 })
})

async function extract(target: string | null, path: string | null): Promise<string | null> {
  if (!client) throw new Error("PG client not initialized")
  const rows = (await client.unsafe("select json_extract($1, $2) as value", [target, path])) as Array<{
    value: string | null
  }>
  return rows[0]?.value ?? null
}

maybe("extracts a top-level key from persisted row shapes", async () => {
  expect(await extract(shellRow, "$.shellID")).toBe("sh_0ce4c10d7001K156IRYpvDeGJP")
  expect(await extract(shellRow, "$.status")).toBe("running")
  expect(await extract(shellRow, "$.command")).toBe("rm -rf /workspace/test-project")
})

maybe("extracts nested keys and array indices", async () => {
  const doc = JSON.stringify({ a: { b: "deep" }, list: [{ name: "zero" }, { name: "one" }] })
  expect(await extract(doc, "$.a.b")).toBe("deep")
  expect(await extract(doc, "$.list[0].name")).toBe("zero")
  expect(await extract(doc, "$.list[1].name")).toBe("one")
})

maybe("returns the whole document for the bare root path", async () => {
  const doc = JSON.stringify({ k: "v" })
  expect(JSON.parse((await extract(doc, "$")) as string)).toEqual({ k: "v" })
})

maybe("returns null for missing keys, invalid JSON, and null inputs", async () => {
  expect(await extract(shellRow, "$.missing")).toBe(null)
  expect(await extract("not json at all", "$.shellID")).toBe(null)
  expect(await extract(null, "$.shellID")).toBe(null)
  expect(await extract(shellRow, null)).toBe(null)
  expect(await extract(shellRow, "$.")).toBe(null)
})

maybe("round-trips the projector's shell lookup predicate", async () => {
  if (!client) throw new Error("PG client not initialized")
  const other = JSON.stringify({ other: 1 })
  const rows = (await client.unsafe(
    `select json_extract(data, '$.shellID') as "shellID", json_extract(data, '$.status') as status
     from (values ($1::text), ($2::text)) as t(data)`,
    [shellRow, other],
  )) as Array<{ shellID: string | null; status: string | null }>
  expect(rows[0]).toEqual({ shellID: "sh_0ce4c10d7001K156IRYpvDeGJP", status: "running" })
  expect(rows[1]).toEqual({ shellID: null, status: null })
})
