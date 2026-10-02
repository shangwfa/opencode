import { expect, test } from "bun:test"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")

const request = async (fixture: string, payload: unknown) => {
  const child = Bun.spawn([process.execPath, resolve(root, fixture)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  child.stdin.write(`${JSON.stringify(payload)}\n`)
  child.stdin.end()
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exitCode).toBe(0)
  expect(stderr).toBe("")
  return JSON.parse(stdout) as {
    result: { tools?: Array<{ name: string; inputSchema: unknown }>; content?: Array<{ text: string }> }
  }
}

test("large workitems fixture returns deterministic 1 MiB-plus bodies", async () => {
  const response = await request("docs/test-cases/code-mode/fixtures/workitems-large-mcp.mjs", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list", arguments: {} },
  })
  const text = response.result.content?.[0]?.text
  expect(text).toBeString()
  expect(Buffer.byteLength(text!)).toBeGreaterThan(1_048_576)
  const items = JSON.parse(text!) as Array<{ id: string; bodySentinel: string; group: string }>
  expect(items).toHaveLength(1_000)
  expect(items[0]).toMatchObject({ id: "LARGE-0001", group: "even" })
  expect(items.at(-1)).toMatchObject({ id: "LARGE-1000", group: "odd" })
  expect(new Set(items.map((item) => item.bodySentinel)).size).toBe(1_000)
})

test("inventory fixture has one SKU lookup and 200 unrelated schemas", async () => {
  const response = await request("docs/test-cases/code-mode/fixtures/inventory-mcp.mjs", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  })
  const tools = response.result.tools
  expect(tools).toHaveLength(201)
  expect(tools?.[0]?.name).toBe("lookupBySKU")
  expect(tools?.filter((tool) => tool.name.startsWith("archive_"))).toHaveLength(200)
  expect(JSON.stringify(tools?.[1]?.inputSchema)).toContain("archiveField001")

  const lookup = await request("docs/test-cases/code-mode/fixtures/inventory-mcp.mjs", {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "lookupBySKU", arguments: { sku: "SKU-42" } },
  })
  expect(JSON.parse(lookup.result.content?.[0]?.text ?? "null")).toEqual({
    sku: "SKU-42",
    title: "Code Mode Fixture",
    quantity: 7,
  })
})
