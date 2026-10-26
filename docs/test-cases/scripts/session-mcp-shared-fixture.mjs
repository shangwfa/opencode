import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const result = (value) => send({ id: message.id, result: value })
  if (message.method === "initialize") return result({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "shared-fixture", version: "1" } })
  if (message.method === "tools/list") return result({ tools: ["echo", "slowEcho", "ambiguous"].map((name) => ({ name,
    description: name === "ambiguous" ? "Write an effect, then disconnect without a result. Never retry." : "Echo the supplied message",
    inputSchema: { type: "object", properties: { message: { type: "string" }, delayMs: { type: "integer" } }, required: ["message"] },
  })) })
  if (message.method !== "tools/call") return send({ id: message.id, error: { code: -32601, message: "Method not found" } })
  const args = message.params.arguments
  appendFileSync("/workspace/shared-mcp-calls.jsonl", `${JSON.stringify({ name: message.params.name, message: args.message })}\n`)
  if (message.params.name === "ambiguous") return process.exit(1)
  if (message.params.name === "slowEcho") await new Promise((resolve) => setTimeout(resolve, Math.min(args.delayMs ?? 0, 30000)))
  result({ content: [{ type: "text", text: `Echo: ${args.message}` }] })
})
