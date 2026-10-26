// Multi-session Streamable HTTP fixture for T22.13/15; no cloud resources.
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"

const sessions = new Map()
const evidence = { initialized: 0, calls: [] }
const key = process.env.MCP_REMOTE_MARKER
if (!key) throw new Error("需要 MCP_REMOTE_MARKER，以隔离本机测试端点")
const server = createServer(async (request, response) => {
  const json = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)) }
  try {
    if (request.headers["x-mcp-test"] !== key) return json({ error: "unauthorized test fixture" }, 401)
    if (request.url === "/stats") return json(evidence)
    if (request.url !== "/mcp") return json({ error: "not found" }, 404)
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      response.write(": connected\n\n")
      const timer = setInterval(() => response.write(": heartbeat\n\n"), 5000)
      response.on("close", () => clearInterval(timer))
      return
    }
    const sid = request.headers["mcp-session-id"]
    if (request.method === "DELETE") { sessions.delete(sid); response.writeHead(204); return response.end() }
    let body = ""
    for await (const chunk of request) { body += chunk; if (body.length > 1048576) return json({ error: "too large" }, 413) }
    const message = JSON.parse(body)
    const result = (value) => json({ jsonrpc: "2.0", id: message.id, result: value })
    if (message.method === "initialize") {
      const id = randomUUID()
      sessions.set(id, true)
      evidence.initialized++
      response.setHeader("mcp-session-id", id)
      return result({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "t22-echo", version: "1" } })
    }
    if (!sessions.has(sid)) return json({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32000, message: "Session not found" } }, 404)
    if (message.id === undefined) { response.writeHead(202); return response.end() }
    if (message.method === "tools/list") return result({ tools: [{ name: "echo", description: "Echo the supplied message", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }] })
    if (message.method === "tools/call" && message.params?.name === "echo") {
      const marker = message.params.arguments?.message
      evidence.calls.push({ session: sid, marker })
      await mkdir(process.env.STRESS_OUT, { recursive: true })
      await writeFile(`${process.env.STRESS_OUT}/remote-calls.json`, JSON.stringify(evidence, null, 2))
      return result({ content: [{ type: "text", text: `ECHO:${marker}` }] })
    }
    return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })
  } catch (error) { if (!response.headersSent) json({ error: error.message }, 400); else response.end() }
})
server.listen(Number(process.env.MCP_REMOTE_PORT ?? 19105), "0.0.0.0", () => console.log("Remote MCP 测试夹具就绪"))
