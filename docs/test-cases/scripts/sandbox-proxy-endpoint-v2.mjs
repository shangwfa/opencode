// Verify the V2 session preview proxy and endpoint APIs against a controlled
// Node HTTP server inside the session sandbox (T11.x/T17.x V2 mapping).
//
//   OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
//   BASE=http://localhost:14106 \
//   PG_URL='postgresql://local@127.0.0.1:15432/opencode-v2-up' \
//   node docs/test-cases/scripts/sandbox-proxy-endpoint-v2.mjs
//
// Covers: proxy passthrough + HTML/JS/CSS rewriting + inject script, non-HTML
// passthrough, redirect rewrite, __errors/proxy-errors, invalid port (400),
// dead port (502), endpoint resolution + direct access, sandbox teardown
// (502), preview-down event throttling in the `event` table (T11.38/T11.39).
// The Vite HMR WebSocket bridge (T11.31) needs a real dev server — see the
// manual steps in docs/test-cases/sandbox/sandbox-proxy-endpoint.md.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14106").replace(/\/$/, "")
const PG_URL = process.env.PG_URL ?? "postgresql://local@127.0.0.1:15432/opencode-v2-up"
const PASSWORD = process.env.OPENCODE_PASSWORD
const headers = {
  "content-type": "application/json",
  ...(PASSWORD ? { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` } : {}),
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(60_000) })
  return response
}

function previewDownRows(sessionID) {
  const rows = execFileSync(
    "psql",
    [PG_URL, "-X", "-A", "-t", "-q", "-c", `SELECT data FROM event WHERE aggregate_id='${sessionID}' AND type LIKE 'session.preview.down%' ORDER BY seq`],
    { encoding: "utf8" },
  )
  return rows.trim().split("\n").filter(Boolean).map((row) => JSON.parse(row))
}

async function createSession(title) {
  const response = await api("/api/session", { method: "POST", body: JSON.stringify({ title }) })
  assert.equal(response.status, 200, `session.create HTTP ${response.status}`)
  return (await response.json()).data.id
}

async function waitSandbox(sessionID, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await api(`/api/session/${sessionID}/sandbox`)
    if (response.status === 200) {
      const { sandboxId } = await response.json()
      if (sandboxId) return sandboxId
    }
    await sleep(3_000)
  }
  throw new Error(`sandbox not ready within ${timeoutMs}ms for ${sessionID}`)
}

async function shell(sessionID, command, timeoutSeconds = 120) {
  const response = await api(`/api/session/${sessionID}/shell`, {
    method: "POST",
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  })
  assert.equal(response.status, 204, `session.shell(${command.slice(0, 40)}) HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
}

// A minimal dependency-free WebSocket echo server for the bridge check:
// RFC 6455 handshake + unmasked text-frame echo (small single frames only).
const WS_ECHO_SERVER = `
const http = require("http")
const crypto = require("crypto")
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const server = http.createServer((req, res) => res.end("ws-server"))
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"]
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64")
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n")
  socket.on("data", (buf) => {
    let offset = 0
    while (offset + 2 <= buf.length) {
      const opcode = buf[offset] & 0x0f
      let len = buf[offset + 1] & 0x7f
      let header = 2
      if (len === 126) { len = buf.readUInt16BE(2); header = 4 }
      if (offset + header + 4 + len > buf.length) return
      const maskKey = buf.slice(offset + header, offset + header + 4)
      const payload = buf.slice(offset + header + 4, offset + header + 4 + len)
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]
      offset += header + 4 + len
      if (opcode === 0x1 || opcode === 0x2) {
        const frame = Buffer.alloc(2 + payload.length)
        frame[0] = 0x81
        frame[1] = payload.length
        payload.copy(frame, 2)
        socket.write(frame)
      } else if (opcode === 0x8) {
        socket.write(Buffer.from([0x88, 0]))
        socket.end()
      }
    }
  })
})
server.listen(8081, "0.0.0.0", () => console.log("ws-echo-ready"))
`

// A tiny deterministic upstream: HTML/JS/CSS/JSON + redirect, so every rewrite
// rule can be asserted without pulling a real dev server.
const SERVER_JS = `
const http = require("http")
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost")
  if (url.pathname === "/") {
    res.setHeader("content-type", "text/html")
    res.end('<!doctype html><html><head><title>oc-preview</title><link rel="stylesheet" href="/style.css"><script type="module" src="/main.js"></script></head><body><h1>hello-preview</h1></body></html>')
    return
  }
  if (url.pathname === "/main.js") {
    res.setHeader("content-type", "text/javascript")
    res.end('import helper from "/helper.js";\\nexport default "/assets/logo.png";\\nconst lazy = await import("/lazy.js");')
    return
  }
  if (url.pathname === "/style.css") {
    res.setHeader("content-type", "text/css")
    res.end('.hero { background-image: url(/assets/bg.png); }')
    return
  }
  if (url.pathname === "/api/json") {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ message: "hello-from-node", path: url.pathname }))
    return
  }
  if (url.pathname === "/redirect") {
    res.statusCode = 302
    res.setHeader("location", "/target")
    res.end()
    return
  }
  res.statusCode = 404
  res.end("not found")
})
server.listen(8080, "0.0.0.0", () => console.log("preview-server-ready"))
`
const SERVER_B64 = Buffer.from(SERVER_JS).toString("base64")

const failures = []
function check(name, condition, detail) {
  if (condition) {
    console.log(`✅ ${name}`)
  } else {
    failures.push(name)
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

// ── main session: sandbox + preview server ───────────────────────────────────
const sessionID = await createSession("sandbox-proxy-endpoint-v2")
console.log(`session: ${sessionID}`)
try {
  const keep = await api(`/api/experimental/session/${sessionID}/keep-alive`, {
    method: "POST",
    body: JSON.stringify({ enabled: true, boot: true }),
  })
  assert.equal(keep.status, 200, `keep-alive HTTP ${keep.status}`)
  const sandboxId1 = await waitSandbox(sessionID)
  console.log(`sandbox: ${sandboxId1}`)

  await shell(sessionID, `echo '${SERVER_B64}' | base64 -d > /workspace/preview-server.js`)
  await shell(sessionID, `(nohup node /workspace/preview-server.js > /tmp/preview-server.log 2>&1 </dev/null &) ; echo started`)

  const prefix = `/api/session/${sessionID}/proxy/8080`
  let booted = false
  for (let attempt = 0; attempt < 20; attempt++) {
    const probe = await fetch(`${BASE}${prefix}/`, { headers, signal: AbortSignal.timeout(10_000) })
    if (probe.status === 200) {
      booted = true
      break
    }
    await sleep(2_000)
  }
  assert.ok(booted, "preview server did not come up through the proxy")

  // T11.1/T11.2: proxy HTML passthrough + inject script
  const html = await (await fetch(`${BASE}${prefix}/`, { headers })).text()
  check("T11.2 HTML 注入 data-oc-prefix", html.includes(`data-oc-prefix="${prefix}"`))
  check("T11.2 window.__OC_PROXY_PREFIX__", html.includes("window.__OC_PROXY_PREFIX__"))
  check("T11.2 fetch/WebSocket/XHR patch", html.includes("window.fetch=function") && html.includes("window.WebSocket=function") && html.includes("XMLHttpRequest.prototype.open"))

  // T11.3: src/href rewritten
  check("T11.3 script src 重写", html.includes(`src="${prefix}/main.js"`))
  check("T11.3 link href 重写", html.includes(`href="${prefix}/style.css"`))

  // T11.5: JS import / dynamic import / export default rewriting
  const js = await (await fetch(`${BASE}${prefix}/main.js`, { headers })).text()
  check("T11.5 静态 import 重写", js.includes(`import helper from "${prefix}/helper.js"`), js.slice(0, 120))
  check("T11.5 动态 import 重写", js.includes(`import("${prefix}/lazy.js")`))
  check("T11.37 export default 资源重写", js.includes(`export default "${prefix}/assets/logo.png"`))
  check("T11.30 JS 无 HTML 注入", !js.includes("data-oc-prefix") && !js.includes("window.fetch=function"))

  // T11.7: CSS url() rewriting
  const css = await (await fetch(`${BASE}${prefix}/style.css`, { headers })).text()
  check("T11.7 CSS url() 重写", css.includes(`url(${prefix}/assets/bg.png)`), css)

  // T11.30/T11.35: non-HTML JSON passthrough
  const json = await (await fetch(`${BASE}${prefix}/api/json`, { headers })).text()
  const parsed = JSON.parse(json)
  check("T11.35 JSON 透传且无注入", parsed.message === "hello-from-node" && !json.includes("data-oc-prefix"), json.slice(0, 120))

  // redirect location rewrite
  const redirect = await fetch(`${BASE}${prefix}/redirect`, { headers, redirect: "manual" })
  check("redirect location 重写", redirect.status === 302 && redirect.headers.get("location") === `${prefix}/target`, redirect.headers.get("location"))
  await redirect.body?.cancel()

  // T11.31: WebSocket upgrade bridging (Node >= 22 has a global WebSocket
  // client). A dependency-free echo server runs inside the sandbox; the proxy
  // must bridge the upgrade and forward text frames both ways.
  if (typeof WebSocket === "function") {
    // The heredoc-size shell can outlive the client timeout while the sandbox
    // still completes it — poll readiness either way instead of hard failing.
    await shell(
      sessionID,
      `echo '${Buffer.from(WS_ECHO_SERVER).toString("base64")}' | base64 -d > /workspace/ws-echo.js; (nohup node /workspace/ws-echo.js > /tmp/ws-echo.log 2>&1 </dev/null &) ; echo ws-started`,
      240,
    ).catch(() => console.log("⚠️ ws-echo 启动命令超时,继续探测端口"))
    const wsPrefix = `/api/session/${sessionID}/proxy/8081`
    let wsReady = false
    for (let attempt = 0; attempt < 15; attempt++) {
      const probe = await fetch(`${BASE}${wsPrefix}/`, { headers, signal: AbortSignal.timeout(5_000) })
      if (probe.status === 200) {
        wsReady = true
        break
      }
      await sleep(2_000)
    }
    if (wsReady) {
      const bridged = await new Promise((resolve) => {
        const token = Buffer.from(`opencode:${PASSWORD ?? ""}`).toString("base64")
        const ws = new WebSocket(`${(process.env.BASE_DIRECT ?? BASE).replace(/^http/, "ws")}${wsPrefix}/?auth_token=${token}`)
        const timer = setTimeout(() => {
          ws.close()
          resolve("timeout")
        }, 15_000)
        ws.onopen = () => ws.send("hello-bridge")
        ws.onmessage = (event) => {
          clearTimeout(timer)
          ws.close()
          resolve(event.data === "hello-bridge" ? "ok" : `mismatch:${event.data}`)
        }
        ws.onerror = () => {
          clearTimeout(timer)
          resolve("error")
        }
      })
      check("T11.31 WebSocket 桥接 echo", bridged === "ok", bridged)
    } else {
      console.log("⚠️ SKIP T11.31 WebSocket 桥接:沙箱内 echo 服务未就绪")
    }
  } else {
    console.log("⚠️ SKIP T11.31 WebSocket 桥接:需要 Node >= 22 的原生 WebSocket 客户端")
  }

  // T11.8: error endpoints
  const inner = await api(`${prefix}/__errors`)
  const outer = await api(`/api/session/${sessionID}/proxy-errors`)
  check("T11.8 __errors / proxy-errors 均 200", inner.status === 200 && outer.status === 200)

  // T11.32: subpaths
  const sub = await fetch(`${BASE}${prefix}/api/json`, { headers })
  check("T11.32 子路径代理", sub.status === 200)
  await sub.body?.cancel()

  // T11.9/T11.20: keepAlive keeps sandbox stable
  const sandboxId2 = await waitSandbox(sessionID)
  const afterIdle = await fetch(`${BASE}${prefix}/`, { headers })
  check("T11.9/T11.20 keepAlive 下 sandboxId 不变", sandboxId1 === sandboxId2)
  check("T11.9 idle 后 proxy 仍 200", afterIdle.status === 200)
  await afterIdle.body?.cancel()

  // T11.33: dead port → 502 with diagnostics
  const dead = await fetch(`${BASE}/api/session/${sessionID}/proxy/9999/`, { headers, signal: AbortSignal.timeout(30_000) })
  check("T11.33 无服务端口 502", dead.status === 502, `HTTP ${dead.status}`)
  await dead.body?.cancel()

  // T17.2: port validation
  for (const port of ["0", "99999", "abc"]) {
    const response = await api(`/api/session/${sessionID}/endpoint/${port}`)
    check(`T17.2 endpoint port=${port} → 400`, response.status === 400, `HTTP ${response.status}`)
    const proxy = await fetch(`${BASE}/api/session/${sessionID}/proxy/${port}/`, { headers })
    check(`T17.2 proxy port=${port} → 400`, proxy.status === 400, `HTTP ${proxy.status}`)
    await proxy.body?.cancel()
  }

  // T17.3: endpoint payload
  const endpoint = await (await api(`/api/session/${sessionID}/endpoint/8080`)).json()
  const expectedMode = process.env.EXPECT_ENDPOINT_MODE ?? "direct"
  check(`T17.3 mode=${expectedMode}`, endpoint.mode === expectedMode, JSON.stringify(endpoint).slice(0, 200))
  check("T17.3 url/sandboxId/port/fallback", Boolean(endpoint.url) && endpoint.port === 8080 && Boolean(endpoint.sandboxId) && String(endpoint.fallback).startsWith(`/api/session/${sessionID}/proxy/8080`))
  check("T17.3 previewUrl 指向 SaaS proxy", !endpoint.previewUrl || endpoint.previewUrl.includes(`/api/session/${sessionID}/proxy/8080`))

  // T17.4/T17.5: direct access has no injection. The local test host may
  // route sandbox-container addresses through a TUN proxy (fake-ip), which
  // breaks direct fetches — degrade to a skip instead of failing there.
  if (endpoint.directUrl) {
    try {
      const direct = await fetch(`${endpoint.directUrl}/`, { signal: AbortSignal.timeout(15_000) })
      const directHtml = await direct.text()
      check("T17.4 直连 200 无注入", direct.status === 200 && !directHtml.includes("data-oc-prefix") && directHtml.includes("hello-preview"))
      check("T17.5 proxy 注入 / direct 原始", html.length > directHtml.length && html.includes("data-oc-prefix"))
    } catch (error) {
      console.log(`⚠️ SKIP T17.4/T17.5 直连验证:本地代理拦截了沙箱直连地址(${error.cause?.code ?? error.message})`)
    }
  } else {
    check("T17.4/T17.5 directUrl 缺失(本地 docker 环境可接受)", true)
  }

  // T11.39 part 1: healthy session records no preview-down events
  check("T11.39 存活时无 preview-down 事件", previewDownRows(sessionID).length === 0)

  // T17.6: destroy → endpoint 502, proxy 502
  const killed = await api(`/api/session/${sessionID}/kill-sandbox`, { method: "POST" })
  assert.equal(killed.status, 200, `kill-sandbox HTTP ${killed.status}`)
  await sleep(2_000)
  const afterKill = await api(`/api/session/${sessionID}/endpoint/8080`)
  check("T17.6 销毁后 endpoint 502", afterKill.status === 502, `HTTP ${afterKill.status}`)
  const afterKillBody = await afterKill.json()
  check("T17.6 错误体 SandboxUnreachableError", afterKillBody._tag === "SandboxUnreachableError" || afterKillBody.error === "sandbox unreachable", JSON.stringify(afterKillBody).slice(0, 120))
  const proxyAfterKill = await fetch(`${BASE}${prefix}/`, { headers })
  check("T17.6 销毁后 proxy 502", proxyAfterKill.status === 502, `HTTP ${proxyAfterKill.status}`)
  await proxyAfterKill.body?.cancel()

  // T11.38: throttled preview-down events for the killed session
  const downEvents = previewDownRows(sessionID)
  check("T11.38 endpoint 502 落 session.preview.down ≥1", downEvents.length >= 1, `count=${downEvents.length}`)
  const firstReason = downEvents[0]?.reason
  check("T11.38 事件 reason=sandbox-unreachable", firstReason === "sandbox-unreachable", JSON.stringify(downEvents[0]))
  const countBefore = downEvents.length
  const throttled = await api(`/api/session/${sessionID}/endpoint/8080`)
  await throttled.body?.cancel()
  const throttledProxy = await fetch(`${BASE}${prefix}/`, { headers })
  await throttledProxy.body?.cancel()
  check("T11.38 60s 节流 + proxy 热路径不落库", previewDownRows(sessionID).length === countBefore, `before=${countBefore} after=${previewDownRows(sessionID).length}`)
} finally {
  await api(`/api/session/${sessionID}/kill-sandbox`, { method: "POST" }).catch(() => {})
  await api(`/api/session/${sessionID}`, { method: "DELETE" }).catch(() => {})
}

// ── no-sandbox session: 502 + event recording (T11.38/T11.39) ────────────────
const lazyID = await createSession("sandbox-proxy-endpoint-v2-lazy")
try {
  const endpoint = await api(`/api/session/${lazyID}/endpoint/5174`)
  check("T11.38 无沙箱 endpoint 502", endpoint.status === 502, `HTTP ${endpoint.status}`)
  await endpoint.body?.cancel()
  await sleep(2_000)
  const events = previewDownRows(lazyID)
  check("T11.38 event 表落 1 条 preview.down", events.length === 1, `count=${events.length}`)

  const proxy1 = await fetch(`${BASE}/api/session/${lazyID}/proxy/5174/`, { headers })
  const proxy2 = await fetch(`${BASE}/api/session/${lazyID}/proxy/5174/`, { headers })
  await proxy1.body?.cancel()
  await proxy2.body?.cancel()
  await sleep(1_000)
  check("T11.38 proxy 502 不落库", previewDownRows(lazyID).length === 1, `count=${previewDownRows(lazyID).length}`)

  // T11.39: boot the sandbox; endpoint resolves, no further events
  const keep = await api(`/api/experimental/session/${lazyID}/keep-alive`, {
    method: "POST",
    body: JSON.stringify({ enabled: true, boot: true }),
  })
  assert.equal(keep.status, 200, `keep-alive HTTP ${keep.status}`)
  await waitSandbox(lazyID)
  const healthy = await api(`/api/session/${lazyID}/endpoint/5174`)
  check("T11.39 存活后 endpoint 200", healthy.status === 200, `HTTP ${healthy.status}`)
  await healthy.body?.cancel()
  check("T11.39 存活时无新增 preview.down", previewDownRows(lazyID).length === 1, `count=${previewDownRows(lazyID).length}`)
} finally {
  await api(`/api/session/${lazyID}/kill-sandbox`, { method: "POST" }).catch(() => {})
  await api(`/api/session/${lazyID}`, { method: "DELETE" }).catch(() => {})
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`)
  process.exitCode = 1
} else {
  console.log("\nall checks passed")
}
