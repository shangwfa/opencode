// Vercel preview/endpoint acceptance: the sandbox's public route is the product
// surface. No SaaS-side HTML injection or path rewriting is expected; arbitrary
// ports are registered lazily on the Vercel sandbox (15-port cap).
// Run through sandbox-vercel-t19.mjs so public SSE, cleanup and PG checks apply.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"

const base = process.env.BASE.replace(/\/$/, "")
const headers = { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}` }
const out = process.env.STRESS_OUT
await mkdir(out, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sql = (statement) =>
  execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", statement], { encoding: "utf8" }).trim()

const api = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.body ? { "content-type": "application/json" } : {}) } })
  const text = await response.text()
  return { response, text, data: (() => { try { return JSON.parse(text) } catch { return undefined } })() }
}
const checks = []
const check = (name, passed, detail) => {
  checks.push({ name, passed, ...(detail ? { detail } : {}) })
  console.log(`${passed ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`)
  assert.ok(passed, `${name}: ${detail}`)
}
const query = `SELECT data FROM event WHERE aggregate_id='%s' AND type LIKE 'session.preview.down%%' ORDER BY seq`
const previewDown = (sessionID) =>
  sql(query.replace("%s", sessionID))
    .trim().split("\n").filter(Boolean).map((row) => JSON.parse(row))

const SERVER_JS = `
const http = require("http")
http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost")
  if (url.pathname === "/") {
    res.setHeader("content-type", "text/html")
    return res.end('<!doctype html><html><head><title>oc-preview</title><link rel="stylesheet" href="/style.css"><script type="module" src="/main.js"></script></head><body><h1>hello-preview</h1></body></html>')
  }
  if (url.pathname === "/main.js") {
    res.setHeader("content-type", "text/javascript")
    return res.end('import helper from "/helper.js";\\nexport default "/assets/logo.png";')
  }
  if (url.pathname === "/style.css") {
    res.setHeader("content-type", "text/css")
    return res.end(".hero { background-image: url(/assets/bg.png); }")
  }
  if (url.pathname === "/api/json") {
    res.setHeader("content-type", "application/json")
    return res.end(JSON.stringify({ message: "hello-from-node", path: url.pathname }))
  }
  if (url.pathname === "/redirect") {
    res.statusCode = 302
    res.setHeader("location", "/target")
    return res.end()
  }
  res.statusCode = 404
  res.end("not found")
}).listen(8080, "0.0.0.0")
`
const WS_ECHO_SERVER = `
const http = require("http")
const crypto = require("crypto")
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const server = http.createServer((req, res) => res.end("ws-server"))
server.on("upgrade", (req, socket) => {
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64")
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n")
  socket.on("data", (buf) => {
    let offset = 0
    while (offset + 2 <= buf.length) {
      const opcode = buf[offset] & 0x0f
      let len = buf[offset + 1] & 0x7f
      let header = 2
      if (len === 126) { len = buf.readUInt16BE(2); header = 4 }
      if (offset + header + 4 + len > buf.length) return
      const mask = buf.slice(offset + header, offset + header + 4)
      const payload = buf.slice(offset + header + 4, offset + header + 4 + len)
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      offset += header + 4 + len
      if (opcode === 0x1 || opcode === 0x2) {
        const frame = Buffer.alloc(2 + payload.length)
        frame[0] = 0x81
        frame[1] = payload.length
        payload.copy(frame, 2)
        socket.write(frame)
      } else if (opcode === 0x8) { socket.write(Buffer.from([0x88, 0])); socket.end() }
    }
  })
})
server.listen(8081, "0.0.0.0")
`
const shell = async (sessionID, command, timeout = 120_000) => {
  const result = await api(`/api/session/${sessionID}/shell`, {
    method: "POST", body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(timeout),
  })
  assert.equal(result.response.status, 204, `shell HTTP ${result.response.status}: ${result.text.slice(0, 200)}`)
}
const endpoint = (sessionID, port) => api(`/api/session/${sessionID}/endpoint/${port}`)

const session = (await api("/api/session", { method: "POST", body: JSON.stringify({ title: "vercel-preview" }) })).data.data
await writeFile(`${out}/session.json`, JSON.stringify({ id: session.id }))
console.log(`会话 ▶ ${session.id}`)
try {
  const boot = await api(`/api/experimental/session/${session.id}/keep-alive`, {
    method: "POST", body: JSON.stringify({ enabled: true, boot: true }),
  })
  assert.equal(boot.response.status, 200, `keep-alive HTTP ${boot.response.status}`)

  await shell(session.id, `echo '${Buffer.from(SERVER_JS).toString("base64")}' | base64 -d > /workspace/preview-server.js`)
  await shell(session.id, `(nohup node /workspace/preview-server.js > /tmp/preview.log 2>&1 < /dev/null &) ; echo started`)

  // Endpoint resolution registers 8080 lazily. Poll until the public route is live.
  let resolved
  for (let attempt = 0; attempt < 20; attempt++) {
    resolved = await endpoint(session.id, 8080)
    if (resolved.response.status === 200 && resolved.data?.directUrl) {
      const probe = await fetch(resolved.data.directUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
      if (probe?.status === 200) break
    }
    await sleep(2000)
  }
  assert.ok(resolved?.data?.directUrl, `endpoint did not resolve: ${resolved?.text?.slice(0, 300)}`)

  const info = resolved.data
  check("T17.3 mode=direct", info.mode === "direct", JSON.stringify(info).slice(0, 240))
  check(
    "T17.3 public URL shape",
    /^https:\/\/[^/]+\/t\/[^/]+$/.test(info.url) && info.url === info.directUrl && info.url === info.proxyUrl,
    info.url,
  )
  check("T17.3 payload fields", info.port === 8080 && Boolean(info.sandboxId) && String(info.fallback).startsWith(`/api/session/${session.id}/proxy/8080`))

  const direct = await fetch(info.directUrl, { signal: AbortSignal.timeout(20_000) })
  const html = await direct.text()
  check("T17.4 direct 200", direct.status === 200, `HTTP ${direct.status}`)
  check("T17.4 direct has no proxy injection", !html.includes("data-oc-prefix") && !html.includes("window.__OC_PROXY_PREFIX__"))
  check("T17.4 direct HTML source", html.includes("hello-preview") && html.includes('src="/main.js"'))

  const js = await (await fetch(`${info.directUrl}/main.js`, { signal: AbortSignal.timeout(20_000) })).text()
  check("T17.4 JS stays unrewritten", js.includes('from "/helper.js"') && js.includes('"/assets/logo.png"'), js.slice(0, 120))
  const css = await (await fetch(`${info.directUrl}/style.css`, { signal: AbortSignal.timeout(20_000) })).text()
  check("T17.4 CSS stays unrewritten", css.includes("url(/assets/bg.png)"), css)
  const json = JSON.parse(await (await fetch(`${info.directUrl}/api/json`, { signal: AbortSignal.timeout(20_000) })).text())
  check("T17.4 JSON passthrough", json.message === "hello-from-node" && json.path === "/api/json")
  const redirect = await fetch(`${info.directUrl}/redirect`, { redirect: "manual", signal: AbortSignal.timeout(20_000) })
  check("T17.4 redirect stays upstream", redirect.status === 302 && redirect.headers.get("location") === "/target", redirect.headers.get("location"))
  await redirect.body?.cancel()

  // WebSocket direct on a second lazily registered port.
  if (typeof WebSocket === "function") {
    await shell(session.id, `echo '${Buffer.from(WS_ECHO_SERVER).toString("base64")}' | base64 -d > /workspace/ws-echo.js`)
    await shell(session.id, `(nohup node /workspace/ws-echo.js > /tmp/ws-echo.log 2>&1 < /dev/null &) ; echo started`)
    let wsEndpoint
    for (let attempt = 0; attempt < 20; attempt++) {
      wsEndpoint = await endpoint(session.id, 8081)
      if (wsEndpoint.response.status === 200 && wsEndpoint.data?.directUrl) {
        const probe = await fetch(wsEndpoint.data.directUrl, { signal: AbortSignal.timeout(8_000) }).catch(() => undefined)
        if (probe?.status === 200) break
      }
      await sleep(2000)
    }
    assert.ok(wsEndpoint?.data?.directUrl, "endpoint/8081 did not resolve")
    const wsResult = await new Promise((resolve) => {
      const socket = new WebSocket(`${wsEndpoint.data.directUrl.replace(/^https:/, "wss:")}/`)
      const timer = setTimeout(() => { socket.close(); resolve("timeout") }, 15_000)
      socket.onopen = () => socket.send("hello-direct")
      socket.onmessage = (event) => { clearTimeout(timer); socket.close(); resolve(event.data === "hello-direct" ? "ok" : `mismatch:${event.data}`) }
      socket.onerror = () => { clearTimeout(timer); resolve("error") }
    })
    check("T11.31 direct WebSocket echo", wsResult === "ok", wsResult)
  } else check("T11.31 direct WebSocket echo", false, "runtime lacks WebSocket")

  // SaaS proxy remains a fallback transport; Vercel does not promise injection.
  const viaProxy = await fetch(`${base}${info.fallback}`, { headers, signal: AbortSignal.timeout(30_000) })
  check("proxy fallback reachable", viaProxy.status === 200, `HTTP ${viaProxy.status}`)
  await viaProxy.body?.cancel()

  for (const port of ["0", "99999", "abc"]) {
    check(`T17.2 endpoint port=${port} → 400`, (await endpoint(session.id, port)).response.status === 400)
  }

  check("T11.39 healthy session has no preview.down", previewDown(session.id).length === 0)
  const killed = await api(`/api/session/${session.id}/kill-sandbox`, { method: "POST" })
  assert.equal(killed.response.status, 200, `kill-sandbox HTTP ${killed.response.status}`)
  await sleep(2000)
  const afterKill = await endpoint(session.id, 8080)
  check("T17.6 destroyed endpoint 502", afterKill.response.status === 502, `HTTP ${afterKill.response.status}`)
  check("T17.6 SandboxUnreachableError", afterKill.data?._tag === "SandboxUnreachableError" || afterKill.data?.error === "sandbox unreachable", JSON.stringify(afterKill.data).slice(0, 120))
  const afterKillProxy = await fetch(`${base}${info.fallback}`, { headers, signal: AbortSignal.timeout(30_000) })
  check("T17.6 destroyed proxy 502", afterKillProxy.status === 502, `HTTP ${afterKillProxy.status}`)
  await afterKillProxy.body?.cancel()
  const down = previewDown(session.id)
  check("T11.38 destroyed endpoint records preview.down", down.length >= 1 && down[0]?.reason === "sandbox-unreachable", `count=${down.length}`)
  const countBefore = down.length
  const throttled = await endpoint(session.id, 8080)
  check("T11.38 60s throttle", previewDown(session.id).length === countBefore, `before=${countBefore}`)
} finally {
  await api(`/api/session/${session.id}/kill-sandbox`, { method: "POST" }).catch(() => undefined)
}

// No-sandbox session records exactly one preview.down and resolves after boot.
const lazy = (await api("/api/session", { method: "POST", body: JSON.stringify({ title: "vercel-preview-lazy" }) })).data.data
try {
  const missing = await endpoint(lazy.id, 8082)
  check("T11.38 no-sandbox endpoint 502", missing.response.status === 502, `HTTP ${missing.response.status}`)
  await sleep(2000)
  check("T11.38 exactly one event", previewDown(lazy.id).length === 1, `count=${previewDown(lazy.id).length}`)
  const keep = await api(`/api/experimental/session/${lazy.id}/keep-alive`, { method: "POST", body: JSON.stringify({ enabled: true, boot: true }) })
  assert.equal(keep.response.status, 200)
  let healthy
  for (let attempt = 0; attempt < 30; attempt++) {
    healthy = await endpoint(lazy.id, 8082)
    if (healthy.response.status === 200) break
    await sleep(2000)
  }
  check("T11.39 endpoint resolves after boot", healthy.response.status === 200, `HTTP ${healthy.response.status}`)
  check("T11.39 no extra events", previewDown(lazy.id).length === 1)
} finally {
  await api(`/api/session/${lazy.id}/kill-sandbox`, { method: "POST" }).catch(() => undefined)
}

await writeFile(`${out}/preview-report.json`, JSON.stringify({ passed: true, checks }, null, 2))
console.log("VERCEL-PREVIEW", JSON.stringify({ passed: true, checks: checks.length }))
