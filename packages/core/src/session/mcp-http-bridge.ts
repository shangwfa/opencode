export * as McpHttpBridge from "./mcp-http-bridge.js"

/**
 * Sandbox-side bridge from streamable HTTP to a stdio MCP server. It replaces
 * supergateway for session MCPs: our client and this bridge speak the same
 * revision (the child negotiates `initialize` itself). Authentication is owned
 * by the provider's port gateway, not by an HTTP transport session header.
 *
 * Deliberately small: one stdio child per bridge, JSON-RPC responses routed by
 * id. Calls are serialized so server requests belong to exactly one POST SSE
 * stream; interactive messages are never broadcast to notification subscribers.
 */

/** Stable, snapshot-persisted path; the provider materializes the script before launch. */
export const path = "/workspace/.opencode/mcp-bridge/mcp-http-bridge.mjs"

export const script = String.raw`#!/usr/bin/env node
import http from "node:http"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1])
const port = Number(args.get("port"))
const stdio = args.get("stdio")
const timeoutMs = Number(args.get("timeout-ms") ?? 12 * 60 * 60 * 1000)
const heartbeatMs = Number(args.get("heartbeat-ms") ?? 15000)
if (!Number.isInteger(port) || !stdio) {
  process.stderr.write("usage: mcp-http-bridge --stdio <command> --port <port>\n")
  process.exit(1)
}

const sessionID = randomUUID()
const child = spawn("/bin/sh", ["-c", stdio], { detached: true, stdio: ["pipe", "pipe", "pipe"] })
const pending = new Map()
const reverse = new Map()
const streams = new Set()
let active
let buffered = ""
let dead = false
let sequence = 0
let initialized
let initialization
let notified = false

const key = (id) => "id:" + JSON.stringify(id)
const send = (message) => {
  if (!dead) child.stdin.write(JSON.stringify(message) + "\n")
}
const broadcast = (message) => {
  const frame = "event: message\ndata: " + JSON.stringify(message) + "\n\n"
  for (const stream of streams) stream.write(frame)
}
const settle = (id, message) => {
  const entry = pending.get(key(id))
  if (!entry) return
  entry(message)
}
const abandon = (entry, reason) => {
  if (active === entry) {
    send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: entry.id, reason } })
    // Stdio has no trustworthy parent ID on reverse requests. Do not reuse a
    // cancelled child's connection for the next caller while it may still run.
    dead = true
    try { process.kill(-child.pid, "SIGTERM") } catch {}
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} }, 500).unref()
    for (const request of pending.values()) finish(request, null)
  } else finish(entry, null)
}
const frame = (stream, message) => stream.write("event: message\ndata: " + JSON.stringify(message) + "\n\n")
const pump = () => {
  if (active || dead) return
  active = pending.values().next().value
  if (active) send({ ...active.message, id: active.id })
}
const finish = (entry, message) => {
  if (!pending.delete(key(entry.id))) return
  clearTimeout(entry.timer)
  for (const [id, request] of reverse) {
    if (request.owner !== entry) continue
    reverse.delete(id)
    send({ jsonrpc: "2.0", id: request.id, error: { code: -1, message: "Parent request ended" } })
  }
  if (!entry.response.destroyed) {
    frame(entry.response, message ?? { jsonrpc: "2.0", id: entry.message.id, error: { code: -32000, message: "MCP request ended before a response" } })
    entry.response.end()
  }
  if (entry.message.method === "initialize" && message?.result) initialized = message.result
  if (active === entry) active = undefined
  pump()
}

child.stdout.setEncoding("utf8")
child.stdout.on("data", (chunk) => {
  buffered += chunk
  let index
  while ((index = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, index).trim()
    buffered = buffered.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (!message || typeof message !== "object") continue
    if (message.method === undefined) {
      settle(message.id, message)
      continue
    }
    if (message.id !== undefined) {
      if (!active || active.response.destroyed) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -1, message: "No originating client request" } })
        continue
      }
      const id = randomUUID()
      reverse.set(key(id), { id: message.id, owner: active })
      frame(active.response, { ...message, id })
      continue
    }
    if (message.method === "notifications/cancelled") {
      for (const [id, entry] of reverse) {
        if (entry.id !== message.params?.requestId) continue
        frame(entry.owner.response, { ...message, params: { ...message.params, requestId: JSON.parse(id.slice(3)) } })
        reverse.delete(id)
      }
    } else if (message.method === "notifications/progress") {
      if (active) frame(active.response, message)
    } else broadcast(message)
  }
})
child.stderr.on("data", (chunk) => process.stderr.write(chunk))
child.on("exit", () => {
  dead = true
  for (const entry of pending.values()) entry(null)
  pending.clear()
})
child.on("error", () => {
  dead = true
  for (const entry of pending.values()) entry(null)
  pending.clear()
})
child.stdin.on("error", () => {})

const request = (message, response) => {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...(message.method === "initialize" ? { "mcp-session-id": sessionID } : {}) })
  response.write(": connected\n\n")
  const heartbeat = setInterval(() => response.write(": ping\n\n"), heartbeatMs)
  response.once("close", () => clearInterval(heartbeat))
  const id = ++sequence
  const entry = Object.assign((value) => finish(entry, value === null ? null : { ...value, id: message.id }), { id, message, response })
  entry.timer = setTimeout(() => {
    abandon(entry, "Request timed out")
  }, timeoutMs)
  pending.set(key(id), entry)
  response.on("close", () => {
    if (!pending.has(key(id))) return
    abandon(entry, "Client disconnected")
  })
  if (dead) return finish(entry, null)
  pump()
}

const readBody = (request_) =>
  new Promise((resolve) => {
    const chunks = []
    request_.on("data", (chunk) => chunks.push(chunk))
    request_.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request_.on("error", () => resolve(""))
  })

const server = http.createServer(async (request_, response) => {
  if (request_.method === "GET" && request_.url === "/health") {
    response.writeHead(dead ? 503 : 200, { "content-type": "application/json" })
    response.end(JSON.stringify({ ready: !dead }))
    return
  }
  if (request_.method === "GET") {
    // Notification stream the MCP client subscribes to after initialize.
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    response.write(": connected\n\n")
    streams.add(response)
    const heartbeat = setInterval(() => response.write(": ping\n\n"), 15000)
    response.on("close", () => {
      clearInterval(heartbeat)
      streams.delete(response)
    })
    return
  }
  if (request_.method === "DELETE") {
    response.writeHead(204)
    response.end()
    return
  }
  if (request_.method !== "POST") {
    response.writeHead(405)
    response.end()
    return
  }
  let message
  try {
    message = JSON.parse(await readBody(request_))
  } catch {
    response.writeHead(400)
    response.end()
    return
  }
  // Batches were removed from Streamable HTTP in protocol revision 2025-06-18.
  if (Array.isArray(message)) { response.writeHead(400); response.end(); return }
  if (message && message.id !== undefined && message.method === undefined && ("result" in message || "error" in message)) {
    const entry = reverse.get(key(message.id))
    if (!entry) { response.writeHead(404); response.end(); return }
    reverse.delete(key(message.id))
    send({ ...message, id: entry.id })
    response.writeHead(202)
    response.end()
    return
  }
  if (!message || message.method === undefined) {
    response.writeHead(400)
    response.end()
    return
  }
  // Notifications (initialized, cancelled, ...) never carry responses.
  if (message.id === undefined) {
    if (message.method === "notifications/cancelled") {
      const entries = Array.from(pending.values()).filter((entry) => entry.message.id === message.params?.requestId)
      // Duplicate caller IDs are ambiguous: never cancel somebody else's call.
      if (entries.length === 1) {
        const entry = entries[0]
        abandon(entry, message.params?.reason ?? "Client cancelled")
      }
    } else if (message.method === "notifications/initialized") {
      if (!notified) { notified = true; send(message) }
    } else send(message)
    response.writeHead(202)
    response.end()
    return
  }
  if (message.method === "initialize") {
    if (initialization) await initialization
    if (initialized && !dead) {
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": sessionID })
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: initialized }))
      return
    }
    let done
    initialization = new Promise(resolve => { done = resolve })
    response.once("close", () => { done(); initialization = undefined })
  }
  request(message, response)
})
server.listen(port, "0.0.0.0", () => process.stdout.write("mcp-http-bridge:" + port + "\n"))
process.on("SIGTERM", () => {
  // Terminate the whole stdio tree (sh -> npx -> server), not only its wrapper.
  const kill = (signal) => {
    try { if (child.pid) process.kill(-child.pid, signal) } catch {}
  }
  kill("SIGTERM")
  server.close()
  for (const stream of streams) stream.end()
  setTimeout(() => { kill("SIGKILL"); process.exit(0) }, 500)
})
`

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** 0: ready; 1: confirmed dead before dispatch; 2: outcome unknown. Never calls a tool. */
export const healthCommand = (base: string, port: number, timeout = 2000): string => {
  const code = `const fs=require("node:fs"),http=require("node:http");try{const pid=Number(fs.readFileSync(${JSON.stringify(`${base}.pid`)},"utf8").trim());if(!Number.isInteger(pid)||pid<1)process.exit(2);process.kill(pid,0)}catch(e){process.exit(e.code==="ENOENT"||e.code==="ESRCH"?1:2)}const r=http.get({host:"127.0.0.1",port:${port},path:"/health",timeout:${timeout}},s=>{s.resume();process.exit(s.statusCode===200?0:s.statusCode===503?1:2)});r.on("timeout",()=>r.destroy());r.on("error",e=>process.exit(e.code==="ECONNREFUSED"?1:2));`
  return `node -e ${quote(code)}`
}

/**
 * Idempotent launcher. The bridge binary and port expand from shell variables so
 * the launcher's own argv never contains a `mcp-http-bridge ... --port <port>`
 * span: images that ship pkill (Vercel's ubuntu base) would otherwise match and
 * kill the launching shell. Stale cleanup also clears pre-bridge supergateway
 * processes left in snapshotted workspaces.
 */
export const startCommand = (input: {
  name: string
  port: number
  stdio: string
  environment?: Readonly<Record<string, string>>
  base: string
  fingerprint?: string
}): string => {
  const pid = `${input.base}.pid`
  const log = `${input.base}.log`
  const environment = Object.entries(input.environment ?? {})
    .map(([key, value]) => `${quote(key)}=${quote(value)}`)
    .join(" ")
  const stale = [
    `if [ -f ${quote(pid)} ]; then kill "$(cat ${quote(pid)})" 2>/dev/null || true; fi`,
    `pkill -f ${quote(`mcp-http-bridg[e].*--port ${input.port}( |$)`)} 2>/dev/null || true`,
    `pkill -f ${quote(`supergatewa[y].*--port ${input.port}( |$)`)} 2>/dev/null || true`,
    "sleep 0.5",
  ].join("; ")
  const launch = [
    `BRIDGE=${quote(path)}`,
    `BPORT=${input.port}`,
    "mkdir -p /tmp/opencode-mcp",
    stale,
    `nohup ${environment ? `env ${environment} ` : ""}node "$BRIDGE" --stdio ${quote(input.stdio)} --port "$BPORT" > ${quote(log)} 2>&1 </dev/null & echo $! > ${quote(pid)}`,
  ].join("; ")
  if (!input.fingerprint) return launch
  const marker = `${input.base}.meta`
  const reuse = `if [ "$(cat ${quote(marker)} 2>/dev/null)" = ${quote(input.fingerprint)} ] && ${healthCommand(input.base, input.port)}; then echo bridge-reused; exit 0; fi`
  const ready = `for i in $(seq 1 10); do ${healthCommand(input.base, input.port, 500)} && exit 0; sleep 0.1; done; exit 1`
  return `mkdir -p /tmp/opencode-mcp; flock --close -x /tmp/opencode-mcp/.registry.lock -c ${quote(`${reuse}; ${launch}; printf %s ${quote(input.fingerprint)} > ${quote(marker)}; ${ready}`)}`
}
