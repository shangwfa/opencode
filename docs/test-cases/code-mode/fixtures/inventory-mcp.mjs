#!/usr/bin/env node
// Large deterministic catalog fixture: one relevant lookup tool and 200
// unrelated schemas, used to verify Code Mode's on-demand discovery path.
import readline from "node:readline"

const irrelevant = Array.from({ length: 200 }, (_, index) => {
  const suffix = String(index + 1).padStart(3, "0")
  return {
    name: `archive_${suffix}`,
    description: `Irrelevant archive operation ${suffix}.`,
    inputSchema: {
      type: "object",
      properties: { [`archiveField${suffix}`]: { type: "string", description: `Irrelevant schema ${suffix}` } },
      required: [`archiveField${suffix}`],
      additionalProperties: false,
    },
  }
})
const tools = [
  {
    name: "lookupBySKU",
    description: "Look up an inventory item by SKU.",
    inputSchema: {
      type: "object",
      properties: { sku: { type: "string", const: "SKU-42" } },
      required: ["sku"],
      additionalProperties: false,
    },
  },
  ...irrelevant,
]

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`)

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    fail(null, -32700, "Parse error")
    return
  }
  const { id, method, params } = request
  if (method === "notifications/initialized" || method === "notifications/cancelled") return
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "inventory-fixture", version: "1.0.0" },
    })
    return
  }
  if (method === "ping") return reply(id, {})
  if (method === "tools/list") return reply(id, { tools })
  if (method === "tools/call") {
    if (params?.name === "lookupBySKU" && params?.arguments?.sku === "SKU-42")
      return reply(id, {
        content: [{ type: "text", text: JSON.stringify({ sku: "SKU-42", title: "Code Mode Fixture", quantity: 7 }) }],
      })
    return reply(id, {
      content: [{ type: "text", text: `Unknown tool or invalid input: ${params?.name}` }],
      isError: true,
    })
  }
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`)
})
