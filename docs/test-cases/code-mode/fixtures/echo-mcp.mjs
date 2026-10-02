#!/usr/bin/env node
import readline from "node:readline"

const tools = [
  {
    name: "echo",
    description: "Return the supplied message prefixed with Echo:.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  },
]

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on("line", (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`)
    return
  }
  const { id, method, params } = request
  if (method === "notifications/initialized" || method === "notifications/cancelled") return
  let result
  if (method === "initialize") {
    result = {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "echo-fixture", version: "1.0.0" },
    }
  } else if (method === "ping") {
    result = {}
  } else if (method === "tools/list") {
    result = { tools }
  } else if (method === "tools/call" && params?.name === "echo" && typeof params.arguments?.message === "string") {
    result = { content: [{ type: "text", text: `Echo: ${params.arguments.message}` }] }
  } else if (id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method or invalid tool call: ${method}` } })}\n`)
    return
  } else {
    return
  }
  if (id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
})
