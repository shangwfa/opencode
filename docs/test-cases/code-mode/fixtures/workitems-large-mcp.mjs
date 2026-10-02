#!/usr/bin/env node
// Deterministic large-result MCP fixture. It deliberately returns more than
// 1 MiB so Code Mode tests can prove that aggregation happens before output.
import readline from "node:readline"

const count = 1_000
const padding = "x".repeat(1_100)
const items = Array.from({ length: count }, (_, index) => {
  const id = String(index + 1).padStart(4, "0")
  return {
    id: `LARGE-${id}`,
    title: `Work item ${id}`,
    group: index % 2 === 0 ? "even" : "odd",
    bodySentinel: `BODY-SENTINEL-${id}-${padding}`,
  }
})

const tools = [
  {
    name: "list",
    description: "List deterministic large work items including their bodies.",
    inputSchema: { type: "object", additionalProperties: false },
  },
  {
    name: "get",
    description: "Get one deterministic large work item including its body.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", enum: items.map((item) => item.id) } },
      required: ["id"],
      additionalProperties: false,
    },
  },
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
      serverInfo: { name: "workitems-large-fixture", version: "1.0.0" },
    })
    return
  }
  if (method === "ping") return reply(id, {})
  if (method === "tools/list") return reply(id, { tools })
  if (method === "tools/call") {
    const args = params?.arguments ?? {}
    if (params?.name === "list") return reply(id, { content: [{ type: "text", text: JSON.stringify(items) }] })
    if (params?.name === "get") {
      const item = items.find((candidate) => candidate.id === args.id)
      if (item) return reply(id, { content: [{ type: "text", text: JSON.stringify(item) }] })
    }
    return reply(id, {
      content: [{ type: "text", text: `Unknown tool or invalid input: ${params?.name}` }],
      isError: true,
    })
  }
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`)
})
