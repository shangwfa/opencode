#!/usr/bin/env node
// Controlled long-running tool for timeout and interrupt HTTP/PG scenarios.
import readline from "node:readline"

const tools = [
  {
    name: "wait",
    description: "Wait for a bounded number of milliseconds, then return the requested marker.",
    inputSchema: {
      type: "object",
      properties: {
        durationMs: { type: "integer", minimum: 0, maximum: 30000 },
        marker: { type: "string" },
      },
      required: ["durationMs", "marker"],
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
  if (method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "delay-fixture", version: "1.0.0" },
        },
      })}\n`,
    )
    return
  }
  if (method === "ping") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`)
    return
  }
  if (method === "tools/list") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { tools } })}\n`)
    return
  }
  if (method === "tools/call" && params?.name === "wait") {
    const durationMs = params.arguments?.durationMs
    const marker = params.arguments?.marker
    if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 30_000 || typeof marker !== "string") {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid wait arguments" } })}\n`,
      )
      return
    }
    setTimeout(
      () =>
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: marker }] } })}\n`,
        ),
      durationMs,
    )
    return
  }
  if (id !== undefined)
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })}\n`,
    )
})
