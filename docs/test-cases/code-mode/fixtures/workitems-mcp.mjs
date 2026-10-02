#!/usr/bin/env node
// Deterministic stdio MCP fixture for Code Mode HTTP/PG E2E scenarios.
// Implements the small newline-delimited JSON-RPC surface needed by MCP clients.
import readline from "node:readline"

const issues = {
  "OPS-101": { key: "OPS-101", title: "API requests fail intermittently", priority: "critical", status: "open" },
  "OPS-102": { key: "OPS-102", title: "Update dashboard copy", priority: "minor", status: "open" },
  "OPS-103": { key: "OPS-103", title: "Pagination is inconsistent", priority: "major", status: "open" },
}

const tools = [
  {
    name: "search_open",
    description: "List open issues for a repository.",
    inputSchema: {
      type: "object",
      properties: { repository: { type: "string" } },
      required: ["repository"],
      additionalProperties: false,
    },
  },
  {
    name: "get_issue",
    description: "Get one issue by key.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", enum: Object.keys(issues) } },
      required: ["key"],
      additionalProperties: false,
    },
  },
]

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`)
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on("line", (line) => {
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
      serverInfo: { name: "workitems-fixture", version: "1.0.0" },
    })
    return
  }
  if (method === "ping") {
    reply(id, {})
    return
  }
  if (method === "tools/list") {
    reply(id, { tools })
    return
  }
  if (method === "tools/call") {
    const args = params?.arguments ?? {}
    let value
    if (params?.name === "search_open" && args.repository === "acme/api") {
    value = Object.values(issues).map(({ key, title, status }) => ({ key, title, status }))
    } else if (params?.name === "get_issue" && Object.hasOwn(issues, args.key)) {
      value = issues[args.key]
    } else {
      reply(id, {
        content: [{ type: "text", text: `Unknown tool or invalid input: ${params?.name}` }],
        isError: true,
      })
      return
    }
    reply(id, {
      content: [{ type: "text", text: JSON.stringify(value) }],
    })
    return
  }
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`)
})
