#!/usr/bin/env node
// CDP 网关：把 Chromium DevTools 端口(默认 127.0.0.1:9221)透出到 0.0.0.0:9222。
//
// 直接透出会踩两个坑：
// 1. Chrome 校验 Host 头（只接受 IP/localhost），经 sandbox-proxy 域名访问会被 400 拒绝
//    —— 网关按请求改写 Host 后转发。
// 2. /json/version、/json/list 返回的 webSocketDebuggerUrl 指向 127.0.0.1，外部客户端
//    （Playwright/Puppeteer）拿到后连不上 —— 网关按请求 Host 改写。
//
// 同时内嵌 /viewer 实时画面页（Page.startScreencast，见 viewer.html）。
// 零 npm 依赖，node cdp-gateway.mjs 直接运行。

import http from "node:http"
import net from "node:net"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const LISTEN_PORT = Number(process.env.CDP_GATEWAY_PORT || 9222)
const UP_HOST = "127.0.0.1"
const UP_PORT = Number(process.env.CDP_UPSTREAM_PORT || 9221)
const VIEWER_FILE = join(dirname(fileURLToPath(import.meta.url)), "viewer.html")

// hop-by-hop 头不应转发
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

const viewerHtml = readFile(VIEWER_FILE, "utf8").catch(() => null)

// 外部视角的 host:port 与 scheme：Host 头优先（proxy 与直连都带），无则回落上游地址
function externalOrigin(req) {
  const host = req.headers.host || `${UP_HOST}:${UP_PORT}`
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
  const scheme = proto === "https" || proto === "wss" ? "wss" : "ws"
  return { host, scheme }
}

function rewriteDevtoolsUrls(body, req) {
  const { host, scheme } = externalOrigin(req)
  return body
    .split(`ws://${UP_HOST}:${UP_PORT}`)
    .join(`${scheme}://${host}`)
    .split(`http://${UP_HOST}:${UP_PORT}`)
    .join(`http://${host}`)
}

// /json* 响应体小，整体缓冲重写；其余路径流式透传
function needsRewrite(pathname) {
  return pathname === "/json" || pathname.startsWith("/json/") || pathname === "/json/version"
}

function proxyRequest(req, res) {
  const headers = { ...req.headers, host: `${UP_HOST}:${UP_PORT}` }
  for (const name of HOP_HEADERS) delete headers[name]
  const upstream = http.request(
    { host: UP_HOST, port: UP_PORT, method: req.method, path: req.url, headers, agent: false },
    (upRes) => {
      const resHeaders = { ...upRes.headers }
      delete resHeaders["connection"]
      delete resHeaders["keep-alive"]
      delete resHeaders["transfer-encoding"]
      const rewrite = needsRewrite(new URL(req.url, "http://x").pathname)
      if (!rewrite) {
        res.writeHead(upRes.statusCode || 502, resHeaders)
        upRes.pipe(res)
        return
      }
      const chunks = []
      upRes.on("data", (chunk) => chunks.push(chunk))
      upRes.on("end", () => {
        const body = rewriteDevtoolsUrls(Buffer.concat(chunks).toString("utf8"), req)
        res.writeHead(upRes.statusCode || 502, { ...resHeaders, "content-length": Buffer.byteLength(body) })
        res.end(body)
      })
    },
  )
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" })
    res.end(`cdp-gateway: upstream chromium not reachable at ${UP_HOST}:${UP_PORT}\n`)
  })
  req.pipe(upstream)
}

// WebSocket 升级：用 rawHeaders 重建握手请求（保留 sec-websocket-* 原样，改写 Host），
// 发给上游后纯双向 pipe
function proxyUpgrade(req, socket, head) {
  const lines = []
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]
    const value = req.rawHeaders[i + 1]
    lines.push(name.toLowerCase() === "host" ? `Host: ${UP_HOST}:${UP_PORT}` : `${name}: ${value}`)
  }
  const upstream = net.connect(UP_PORT, UP_HOST, () => {
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`)
    if (head.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  const cleanup = () => {
    socket.destroy()
    upstream.destroy()
  }
  upstream.on("error", cleanup)
  socket.on("error", cleanup)
  upstream.on("close", cleanup)
  socket.on("close", cleanup)
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://x").pathname
  if (pathname === "/" || pathname === "/viewer") {
    const html = await viewerHtml
    if (html === null) {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("viewer.html missing\n")
      return
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
    res.end(html)
    return
  }
  proxyRequest(req, res)
})

server.on("upgrade", proxyUpgrade)

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`[cdp-gateway] listening on 0.0.0.0:${LISTEN_PORT} -> ${UP_HOST}:${UP_PORT}, viewer at /viewer`)
})
