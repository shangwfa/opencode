import { loadEnv } from "vite"
import type { Plugin, ViteDevServer } from "vite"
import { WebSocketServer, WebSocket } from "ws"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { loadServerConfig } from "./config.ts"
import type { ServerConfig } from "./config.ts"

// browser-cdp 测试前端：vite 插件提供两类能力
// 1. /api/*      —— 调 opencode SaaS API：创建会话(指定沙箱镜像)/boot/exec 拉起浏览器/endpoint 就绪探测
// 2. /cdp/:sid/* —— 把 CDP 流量(HTTP + WS upgrade)代理到沙箱内 cdp-gateway(9222)
//    upstream 优先沙箱 IP 直连（本地 OrbStack/K8s 内网均可达），失败降级 SaaS sandbox-proxy
//    （本地实测 sandbox-proxy 的 WS 转发会挂起，直连绕过该问题）。前端全程同源访问。

const JSON_HEADERS = { "Content-Type": "application/json" }

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
}

async function saas(config: ServerConfig, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${config.saasBaseUrl}${path}`, {
    signal: AbortSignal.timeout(120_000),
    ...init,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`SaaS ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

async function cdpReady(config: ServerConfig, sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${await cdpBase(config, sessionId)}/json/version`, {
      signal: AbortSignal.timeout(4000),
    })
    return res.ok
  } catch {
    return false
  }
}

// ── upstream 解析：沙箱 IP 直连优先，SaaS proxy 兜底 ──

async function probeBase(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

const baseCache = new Map<string, { base: string; expires: number }>()

// 返回可直接访问沙箱 cdp-gateway 的 http base（含 SaaS proxy 兜底路径）。
// 优先级：env 显式指定 → SaaS host-ip 接口（沙箱裸 IP:9222，WS 可直连）
//       → endpoint directUrl（ingress 形态，仅 HTTP）→ SaaS proxy
async function cdpBase(config: ServerConfig, sessionId: string): Promise<string> {
  const hit = baseCache.get(sessionId)
  if (hit && hit.expires > Date.now()) return hit.base

  const candidates: string[] = []
  if (config.directBase) candidates.push(config.directBase.replace("{sessionId}", sessionId))
  try {
    const info = await saas(config, `/session/${sessionId}/host-ip`)
    for (const ip of (info.ips as string[] | undefined) ?? []) candidates.push(`http://${ip}:9222`)
  } catch {}
  try {
    const ep = await saas(config, `/session/${sessionId}/endpoint/9222`)
    const direct = ep.directUrl as string | undefined
    if (direct) candidates.push(direct.replace(/\/$/, ""))
  } catch {}

  for (const candidate of candidates) {
    if (await probeBase(candidate)) {
      console.log(`[cdp] upstream: ${candidate}`)
      baseCache.set(sessionId, { base: candidate, expires: Date.now() + 30_000 })
      return candidate
    }
  }
  const fallback = `${config.saasBaseUrl}/session/${sessionId}/proxy/9222`
  baseCache.set(sessionId, { base: fallback, expires: Date.now() + 10_000 })
  return fallback
}

async function startBrowser(config: ServerConfig, sessionId: string) {
  const result = await saas(config, `/session/${sessionId}/exec`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ command: "/opt/cdp-browser/cdp-browser.sh start" }),
  })
  if (result.exitCode !== 0) {
    const errorValue = (result.error as { value?: unknown } | undefined)?.value
    throw new Error(`cdp-browser start failed: ${String(result.stdout ?? "") || String(errorValue ?? "unknown")}`)
  }
}

async function createSession(config: ServerConfig, image?: string) {
  const body = {
    sandbox: { cpu: config.cpu, memory: config.memory, image: image?.trim() || config.image },
  }
  const created = await saas(config, "/session", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
  const sessionId = String(created.id)

  // boot：立即创建沙箱（会话已固化 sandbox.image），失败时提示但会话保留
  let sandboxId: string | null = null
  try {
    const boot = await saas(config, `/session/${sessionId}/keep-alive`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: true, boot: true }),
    })
    sandboxId = (boot.sandboxId as string | null) ?? null
  } catch (err) {
    return { sessionId, sandboxId: null, ready: false, error: `boot failed: ${String(err)}` }
  }

  await startBrowser(config, sessionId)
  for (let i = 0; i < 20; i++) {
    if (await cdpReady(config, sessionId)) return { sessionId, sandboxId, ready: true, error: null }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return { sessionId, sandboxId, ready: false, error: "cdp 9222 not ready in 20s" }
}

async function sessionStatus(config: ServerConfig, sessionId: string) {
  const info = await saas(config, `/session/${sessionId}`)
  const sandbox = info.sandbox as Record<string, string> | undefined
  const ready = await cdpReady(config, sessionId)
  return { sessionId, sandboxId: (info.sandboxId as string | null) ?? null, sandbox, ready }
}

// ── CDP HTTP 代理：/cdp/:sessionId/<path> -> <cdpBase>/<path> ──
async function proxyCdpHttp(req: IncomingMessage, res: ServerResponse, config: ServerConfig, sessionId: string, rest: string, search: string) {
  const base = await cdpBase(config, sessionId)
  const upstream = `${base}${rest}${search}`
  const headers: Record<string, string> = {}
  for (const name of ["content-type", "accept", "authorization"]) {
    const value = req.headers[name]
    if (typeof value === "string") headers[name] = value
  }
  try {
    const body = ["GET", "HEAD"].includes(req.method ?? "") ? undefined : await readBodyBuffer(req)
    const proxyRes = await fetch(upstream, { method: req.method, headers, body, signal: AbortSignal.timeout(30_000) })
    const resHeaders: Record<string, string> = {}
    proxyRes.headers.forEach((value, name) => {
      if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(name)) resHeaders[name] = value
    })
    const buf = Buffer.from(await proxyRes.arrayBuffer())
    res.writeHead(proxyRes.status, resHeaders)
    res.end(buf)
  } catch (err) {
    json(res, 502, { error: `cdp proxy failed: ${String(err)}` })
  }
}

function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

// ── CDP WebSocket 代理 ──
function setupWsForwarding(server: ViteDevServer, config: ServerConfig) {
  const wss = new WebSocketServer({ noServer: true })
  const httpServer = server.httpServer as Server

  httpServer.on("upgrade", async (request, socket, head) => {
    const match = (request.url ?? "").match(/^\/cdp\/([^/]+)(\/.+)$/)
    if (!match) return
    const [, sessionId, rest] = match
    const base = await cdpBase(config, sessionId)
    const wsScheme = base.startsWith("https") ? "wss" : "ws"
    const upstreamUrl = `${wsScheme}://${base.replace(/^https?:\/\//, "")}${rest}`
    const protocols = (request.headers["sec-websocket-protocol"]
      ?.split(",")
      .map((p) => p.trim())
      .filter(Boolean)) ?? []

    wss.handleUpgrade(request, socket, head, (client) => {
      const upstream = new WebSocket(upstreamUrl, protocols.length ? protocols : undefined)
      const closeBoth = () => {
        if (client.readyState === WebSocket.OPEN) client.close()
        if (upstream.readyState === WebSocket.OPEN) upstream.close()
      }
      // upstream OPEN 前到达的 client 消息先缓冲（握手竞态窗口内直接发会静默丢失）
      let upstreamReady = false
      const pending: Array<{ data: WebSocket.RawData; isBinary: boolean }> = []

      upstream.on("open", () => {
        console.log(`[cdp-ws] ${sessionId}${rest} connected`)
        upstreamReady = true
        for (const msg of pending) upstream.send(msg.data, { binary: msg.isBinary })
        pending.length = 0
      })
      client.on("message", (data, isBinary) => {
        if (upstreamReady && upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
        else pending.push({ data, isBinary })
      })
      upstream.on("message", (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
      })
      upstream.on("error", (err) => {
        console.error(`[cdp-ws] upstream error (${sessionId}${rest}):`, err.message)
        closeBoth()
      })
      client.on("error", closeBoth)
      upstream.on("close", closeBoth)
      client.on("close", closeBoth)
    })
  })
}

export function browserCdp(): Plugin {
  let config: ServerConfig

  return {
    name: "browser-cdp-test",
    apply: "serve",
    enforce: "pre",

    configResolved(resolvedConfig) {
      config = loadServerConfig(loadEnv(resolvedConfig.mode, resolvedConfig.root, ""))
    },

    configureServer(server) {
      setupWsForwarding(server, config)

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost")
        const pathname = url.pathname

        const cdpMatch = pathname.match(/^\/cdp\/([^/]+)(\/.+)$/)
        if (cdpMatch) {
          await proxyCdpHttp(req, res, config, cdpMatch[1], cdpMatch[2], url.search)
          return
        }

        try {
          if (req.method === "GET" && pathname === "/api/config") {
            json(res, 200, { image: config.image, cpu: config.cpu, memory: config.memory, saasBaseUrl: config.saasBaseUrl })
            return
          }

          if (req.method === "POST" && pathname === "/api/sessions") {
            const body = await readJson(req)
            json(res, 201, await createSession(config, body.image ? String(body.image) : undefined))
            return
          }

          if (req.method === "GET" && pathname === "/api/sessions") {
            const list = await saas(config, "/session")
            const sessions = (Array.isArray(list) ? list : []) as Array<Record<string, unknown>>
            const entries = sessions.map((s) => ({
              id: s.id,
              title: s.title,
              timeUpdated: (s.time as Record<string, unknown> | undefined)?.updated ?? 0,
              sandbox: s.sandbox ?? null,
            }))
            entries.sort((a, b) => Number(b.timeUpdated) - Number(a.timeUpdated))
            json(res, 200, entries.slice(0, 50))
            return
          }

          const idMatch = pathname.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/)
          if (idMatch) {
            const [, sessionId, action] = idMatch
            if (!action) {
              json(res, 200, await sessionStatus(config, sessionId))
              return
            }
            if (action === "/status") {
              json(res, 200, await sessionStatus(config, sessionId))
              return
            }
            if (action === "/browser/start" && req.method === "POST") {
              await startBrowser(config, sessionId)
              for (let i = 0; i < 20; i++) {
                if (await cdpReady(config, sessionId)) break
                await new Promise((r) => setTimeout(r, 1000))
              }
              json(res, 200, { ready: await cdpReady(config, sessionId) })
              return
            }
            if (action === "/browser/stop" && req.method === "POST") {
              const result = await saas(config, `/session/${sessionId}/exec`, {
                method: "POST",
                headers: JSON_HEADERS,
                body: JSON.stringify({ command: "/opt/cdp-browser/cdp-browser.sh stop" }),
              })
              json(res, 200, { exitCode: result.exitCode })
              return
            }
            if (action === "/sandbox" && req.method === "DELETE") {
              json(res, 200, await saas(config, `/session/${sessionId}/kill-sandbox`, { method: "POST" }))
              return
            }
          }
        } catch (err) {
          console.error("[api] error:", err)
          json(res, 500, { error: err instanceof Error ? err.message : String(err) })
          return
        }

        next()
      })
    },
  }
}
