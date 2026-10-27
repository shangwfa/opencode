// Run original sandbox API scripts against Docker SaaS; subscribe to public SSE before returning each created session.
import { createServer } from "node:http"
import { Readable } from "node:stream"
import { once } from "node:events"
import { spawn, execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const [name, output] = process.argv.slice(2)
const allowed = new Set(["exec-api-v2", "sandbox-keepalive-v2", "sandbox-keepalive-lazy-v2", "sandbox-idle-reap-v2", "files-api-v2", "files-api-glob-v2", "files-api-edge-v2", "files-api-stress-v2", "agent-chain-v2", "mcp-interactions-v2", "sandbox-vercel-tool-t20", "sandbox-proxy-endpoint-v2", "sandbox-vercel-preview-v2", "sandbox-vercel-session-mcp-t22", "sandbox-vercel-multipod-race", "e2b-extensions", "sandbox-aliyun-preview"])
if (!allowed.has(name) || !output || !process.env.BASE || !process.env.PG_URL) throw new Error("Expected original T19 script name, output directory, BASE and PG_URL")
if (!new URL(process.env.PG_URL).pathname.endsWith("-test")) throw new Error("A dedicated test PG database is required")
if (process.env.RESTART_CONTAINER && !process.env.RESTART_CONTAINER.startsWith("opencode-vercel-t19-")) throw new Error("Refusing to restart a non-test container")
const base = process.env.BASE.replace(/\/$/, "")
const expectedProvider = process.env.EXPECT_PROVIDER ?? "vercel"
const sessionSandbox = process.env.SESSION_SANDBOX ? JSON.parse(process.env.SESSION_SANDBOX) : undefined
const headers = { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}` }
const sessions = new Map()
const events = []
const formAttempts = new Map()
async function answerForms(id) {
  const response = await fetch(`${base}/api/session/${id}/form`, { headers, signal: AbortSignal.timeout(10000) })
  if (!response.ok) return
  for (const form of (await response.json()).data ?? []) {
    if ((formAttempts.get(form.id) ?? 0) >= 2 || form.fields?.some((field) => field.type === "external")) continue
    const answer = Object.fromEntries((form.fields ?? []).map((field) => [field.key,
      field.type === "boolean" ? field.default ?? true : ["number", "integer"].includes(field.type) ? field.default ?? field.minimum ?? 1
        : field.type === "multiselect" ? [field.options?.[0]?.value ?? field.default?.[0]].filter(Boolean)
          : field.options?.[0]?.value ?? field.default ?? "请按推荐方案继续",
    ]))
    formAttempts.set(form.id, (formAttempts.get(form.id) ?? 0) + 1)
    const reply = await fetch(`${base}/api/session/${id}/form/${form.id}/reply`, { method: "POST",
      headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ answer }), signal: AbortSignal.timeout(10000) })
    console.log(`FORM · ${id} HTTP ${reply.status}`)
  }
}
await mkdir(output, { recursive: true })
const result = { name, status: "running", codeMode: ["agent-chain-v2", "mcp-interactions-v2"].includes(name) || (name === "sandbox-vercel-session-mcp-t22" && process.env.MCP_T22_STAGE !== "A") || name === "e2b-extensions" ? "sandbox executor; verify execute calls and nested MCP calls in events" : name === "sandbox-vercel-tool-t20" ? "built-in tools execute in the Vercel sandbox; verify tool parts, session.shell and isolation" : "not exercised: shell API cases contain no model turn", assertions: name === "sandbox-proxy-endpoint-v2" ? "underlying API assertions; endpoint mode selected explicitly; WebSocket targets BASE_DIRECT" : name === "sandbox-vercel-session-mcp-t22" ? "API/PG checks plus strict completed MCP calls; provider-specific execution" : name === "sandbox-vercel-multipod-race" ? "public API, two blocked PG sweep claims, real cloud generation and workspace checks" : name === "e2b-extensions" ? "tool parts, SSE, PG and deterministic shell evidence for skills/commands/agents/plugins/tools/MCP" : "original scripts unchanged", sessions: [], cleanup: [], pg: [], bindings: [] }

function captureBinding(id) {
  const sql = `SELECT json_build_object('sessionID',session_id,'provider',provider,'remoteName',remote_name)::text FROM sandbox WHERE session_id='${id.replaceAll("'", "''")}'`
  const value = execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
  if (value) {
    const binding = JSON.parse(value)
    if (binding.remoteName && !result.bindings.some((item) => item.remoteName === binding.remoteName)) result.bindings.push(binding)
  }
}

async function verifyWorkspace(id) {
  const command = "pwd # vercel-t19-workspace"
  const shell = await fetch(`${base}/api/session/${id}/shell`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ command }), signal: AbortSignal.timeout(60_000),
  })
  if (shell.status !== 204) throw new Error(`Workspace shell HTTP ${shell.status}`)
  const log = await fetch(`${base}/api/experimental/session/${id}/log?follow=false&after=0`, { headers, signal: AbortSignal.timeout(15_000) })
  if (log.status !== 200) throw new Error(`Workspace replay HTTP ${log.status}`)
  const events = (await log.text()).split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
  const ended = events.find((event) => event.type === "session.shell.ended" && event.data?.shell?.command === command)
  if (ended?.data?.shell?.exit !== 0 || ended?.data?.output?.output?.trim() !== "/workspace") throw new Error("Shell did not execute in /workspace")
  result.workspaceCheck = { command, exit: 0, output: "/workspace" }
  console.log("✅ Vercel shell working directory: /workspace (API + durable log)")
}

const deadline = Date.now() + 120_000
let ready = false
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${base}/api/info`, { headers, signal: AbortSignal.timeout(5000) })
    if (response.ok) { ready = true; break }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
if (!ready) throw new Error("Docker SaaS API did not become ready")
console.log(`API ▶ ${base} ready`)

async function watch(id, source = base) {
  const controller = new AbortController()
  const response = await fetch(`${source}/api/session/${id}/event`, { headers, signal: controller.signal })
  if (response.status !== 200) throw new Error(`Public SSE subscription failed: HTTP ${response.status}`)
  const state = { controller, connected: 1, done: null, peers: [] }
  const prior = sessions.get(id)
  if (prior) prior.peers.push(state)
  else sessions.set(id, state)
  console.log(`SSE ▶ ${id} ${source} connected`)
  const consume = async (initial) => {
    let stream = initial
    while (!controller.signal.aborted) {
      try {
        const reader = stream.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let index
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index).trim()
            buffer = buffer.slice(index + 1)
            if (!line.startsWith("data:")) continue
            const event = JSON.parse(line.slice(5))
            events.push({ sessionID: id, source, ...event })
            if (event.type === "form.created") void answerForms(id).catch(() => {})
            if (event.type?.endsWith(".delta")) continue
            if (/shell|tool\.|execution|sandbox|form\.|reasoning\.ended|text\.ended/.test(event.type ?? "")) {
              console.log(`SSE · ${id} ${event.type} ${JSON.stringify(event.data ?? {}).slice(0, 180)}`)
            }
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return
        console.log(`SSE · ${id} reconnecting after ${error.name}`)
      }
      if (controller.signal.aborted) return
      await new Promise((resolve) => setTimeout(resolve, 1000))
      try {
        stream = await fetch(`${source}/api/session/${id}/event`, { headers, signal: controller.signal })
        if (stream.status === 404) return
        if (stream.status !== 200) continue
        state.connected++
      } catch { if (controller.signal.aborted) return }
    }
  }
  state.done = consume(response)
}

const proxy = createServer(async (request, response) => {
  const controller = new AbortController()
  response.on("close", () => controller.abort())
  try {
    if (request.method === "DELETE" && /^\/api\/session\/[^/]+$/.test(request.url ?? "")) {
      const id = request.url.split("/").pop()
      captureBinding(id)
      if (name === "exec-api-v2") await verifyWorkspace(id)
    }
    const body = []
    for await (const chunk of request) body.push(chunk)
    let forwardedBody = body.length ? Buffer.concat(body) : undefined
    if (sessionSandbox && request.method === "POST" && request.url === "/api/session") {
      const input = JSON.parse(forwardedBody?.toString("utf8") || "{}")
      forwardedBody = Buffer.from(JSON.stringify({ ...input, sandbox: { ...sessionSandbox, ...input.sandbox } }))
    }
    const forward = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (!["host", "connection", "content-length", "transfer-encoding"].includes(key) && value) forward.set(key, Array.isArray(value) ? value.join(",") : value)
    }
    const upstream = await fetch(`${base}${request.url}`, {
      method: request.method, headers: forward, signal: controller.signal,
      redirect: "manual",
      body: forwardedBody,
    })
    const responseHeaders = Object.fromEntries([...upstream.headers].filter(([key]) => !["connection", "transfer-encoding", "content-length", "content-encoding"].includes(key)))
    if (request.method === "POST" && (request.url === "/api/session" || request.url?.endsWith("/fork")) && upstream.status === 200) {
      const bytes = Buffer.from(await upstream.arrayBuffer())
      const id = JSON.parse(bytes.toString("utf8"))?.data?.id
      if (id && !sessions.has(id)) {
        if (process.env.SESSION_KEEPALIVE === "1") {
          const kept = await fetch(`${base}/api/experimental/session/${id}/keep-alive`, {
            method: "POST", headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ keepAlive: true }), signal: AbortSignal.timeout(15000),
          })
          if (!kept.ok) throw new Error(`Test keep-alive HTTP ${kept.status}`)
        }
        await watch(id)
        if (process.env.BASE_SECONDARY && process.env.BASE_SECONDARY.replace(/\/$/, "") !== base) await watch(id, process.env.BASE_SECONDARY.replace(/\/$/, ""))
      }
      response.writeHead(upstream.status, responseHeaders)
      response.end(bytes)
    } else {
      response.writeHead(upstream.status, responseHeaders)
      if (upstream.body) Readable.fromWeb(upstream.body).on("error", () => response.destroy()).pipe(response)
      else response.end()
    }
  } catch (error) {
    if (!response.headersSent) response.writeHead(502)
    response.end(`T19 test proxy failed: ${error.name}`)
  }
})
proxy.listen(0, "127.0.0.1")
await once(proxy, "listening")
try {
  const address = proxy.address()
  if (!address || typeof address === "string") throw new Error("Test proxy failed to bind")
  const child = spawn(process.execPath, [path.join(import.meta.dirname, `${name}.mjs`)], {
    env: { ...process.env, BASE: `http://127.0.0.1:${address.port}`, BASE_DIRECT: base }, stdio: ["ignore", "pipe", "pipe"],
  })
  let transcript = ""
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { transcript += chunk; process.stdout.write(chunk) })
  const [code] = await once(child, "close")
  result.exitCode = code
  result.status = code === 0 ? "passed" : "failed"
  await writeFile(path.join(output, "executor.log"), transcript)
} catch (error) {
  result.status = "failed"
  result.error = error.message
} finally {
  result.sessions = [...sessions].map(([id, state]) => ({ id, sseConnections: state.connected + state.peers.reduce((total, peer) => total + peer.connected, 0) }))
  for (const [id, state] of sessions) {
    state.controller.abort()
    for (const peer of state.peers) peer.controller.abort()
    await Promise.all([state.done, ...state.peers.map((peer) => peer.done)])
    try {
      captureBinding(id)
      const response = await fetch(`${base}/api/session/${id}`, { method: "DELETE", headers, signal: AbortSignal.timeout(60_000) })
      result.cleanup.push({ id, status: response.status })
      if (![200, 204, 404].includes(response.status)) result.status = "failed"
    } catch (error) { result.cleanup.push({ id, error: error.name }); result.status = "failed" }
  }
  const ids = [...sessions.keys()].map((id) => `'${id.replaceAll("'", "''")}'`).join(",")
  if (ids) {
    try {
      const sql = `SELECT json_build_object('sessionID',session_id,'id',id,'provider',provider,'state',state,'keepAlive',keep_alive,'remoteName',remote_name)::text FROM sandbox WHERE session_id IN (${ids})`
      result.pg = execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      const expectSandbox = process.env.EXPECT_SANDBOX !== "0"
       if (expectSandbox && (result.pg.length !== sessions.size || result.pg.some((row) => row.provider !== expectedProvider || row.state !== "destroyed" || row.remoteName !== null))) result.status = "failed"
       if (!expectSandbox && result.pg.some((row) => row.provider !== expectedProvider || row.state !== "destroyed" || row.remoteName !== null)) result.status = "failed"
    } catch (error) { result.pgError = error.message; result.status = "failed" }
  }
  proxy.closeAllConnections()
  await new Promise((resolve) => proxy.close(resolve))
  await writeFile(path.join(output, "events.json"), JSON.stringify(events, null, 2))
  await writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
}
process.exitCode = result.status === "passed" ? 0 : 1
