import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { AppRuntime } from "@/effect/app-runtime"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { SessionID } from "@/session/schema"
import { Session } from "@/session"
import { Bus } from "@/bus"

type ProxyError = {
  type: "runtime" | "network" | "compile"
  message: string
  url?: string
  line?: number
  col?: number
  stack?: string
  timestamp: number
}

const errors = new Map<string, ProxyError[]>()
const MAX_ERRORS = 100

function push(sessionID: string, port: number, items: ProxyError[]) {
  const key = `${sessionID}:${port}`
  const buf = errors.get(key) ?? []
  buf.push(...items)
  if (buf.length > MAX_ERRORS) buf.splice(0, buf.length - MAX_ERRORS)
  errors.set(key, buf)
}

function get(sessionID: string, port: number) {
  return errors.get(`${sessionID}:${port}`) ?? []
}

export function clear(sessionID: string) {
  for (const key of errors.keys()) {
    if (key.startsWith(sessionID + ":")) errors.delete(key)
  }
}

const INJECT_SCRIPT = (prefix: string) => `<script>;(function(){
var _p="${prefix}";
var _origWS=window.WebSocket;
window.WebSocket=function(url,protocols){
  if(typeof url==="string"&&url.charAt(0)==="/"){url=_p+url}
  else if(typeof url==="string"&&url.indexOf(location.host)!==-1&&url.indexOf(_p)===-1){url=url.replace(location.host,location.host+_p)}
  return protocols?new _origWS(url,protocols):new _origWS(url);
};
window.WebSocket.prototype=_origWS.prototype;
window.WebSocket.CONNECTING=_origWS.CONNECTING;
window.WebSocket.OPEN=_origWS.OPEN;
window.WebSocket.CLOSING=_origWS.CLOSING;
window.WebSocket.CLOSED=_origWS.CLOSED;
var _origErr=console.error;
console.error=function(){
  _origErr.apply(console,arguments);
  try{__ocReport([{type:"runtime",message:Array.from(arguments).map(function(a){return typeof a==="string"?a:typeof a==="object"&&a&&a.message?a.message:String(a)}).join(" "),timestamp:Date.now()}])}catch(e){}
};
window.addEventListener("error",function(e){
  try{__ocReport([{type:"runtime",message:e.message,url:e.filename,line:e.lineno,col:e.colno,stack:e.error&&e.error.stack||"",timestamp:Date.now()}])}catch(ex){}
});
window.addEventListener("unhandledrejection",function(e){
  try{__ocReport([{type:"runtime",message:"UnhandledPromise: "+(e.reason&&e.reason.message||String(e.reason)),stack:e.reason&&e.reason.stack||"",timestamp:Date.now()}])}catch(ex){}
});
function __ocReport(errs){
  var img=new Image();
  img.src=_p+"/__error_report?e="+encodeURIComponent(JSON.stringify(errs));
}
})();</script>`

const NOOP_WS = { onOpen() {}, onMessage() {}, onClose() {}, onError() {} }

export const SandboxProxyRoutes = (upgrade: UpgradeWebSocket): Hono =>
  new Hono()
    .get(
      "/session/:sessionID/proxy/:port/__errors",
      async (c) => {
        const sessionID = c.req.param("sessionID") as SessionID
        const port = parseInt(c.req.param("port"), 10)
        return c.json(get(sessionID, port))
      },
    )
    .get(
      "/session/:sessionID/proxy/:port/__error_report",
      async (c) => {
        const sessionID = c.req.param("sessionID") as SessionID
        const port = parseInt(c.req.param("port"), 10)
        const raw = c.req.query("e")
        if (!raw || raw.length > 10240) return c.json({ ok: true })
        try {
          const parsed = JSON.parse(decodeURIComponent(raw))
          if (!Array.isArray(parsed)) return c.json({ ok: true })
          const items: ProxyError[] = parsed.slice(0, 10).map((e: any) => ({
            type: (e.type === "runtime" || e.type === "network" || e.type === "compile") ? e.type : "runtime",
            message: String(e.message ?? "").slice(0, 2048),
            url: e.url ? String(e.url).slice(0, 512) : undefined,
            line: typeof e.line === "number" ? e.line : undefined,
            col: typeof e.col === "number" ? e.col : undefined,
            stack: e.stack ? String(e.stack).slice(0, 4096) : undefined,
            timestamp: typeof e.timestamp === "number" ? e.timestamp : Date.now(),
          }))
          push(sessionID, port, items)
          Bus.publish(Session.Event.ProxyError, { sessionID, port, errors: items }).catch(() => {})
        } catch {}
        return c.json({ ok: true })
      },
    )
    .get(
      "/session/:sessionID/proxy/:port/*",
      upgrade(async (c) => {
        const sessionID = c.req.param("sessionID") as SessionID
        const port = parseInt(c.req.param("port"), 10)
        if (isNaN(port) || port < 1 || port > 65535) return NOOP_WS
        const prefix = `/session/${sessionID}/proxy/${port}`
        const wildcard = c.req.path.slice(prefix.length + 1) || ""
        const subPath = "/" + wildcard

        const endpoint = await AppRuntime.runPromise(
          SandboxProvider.Service.use((svc) => svc.getEndpoint(sessionID, port)),
        ).catch(() => null)
        if (!endpoint) return { onOpen(_: any, ws: any) { ws.close(1011, "sandbox unreachable") }, onMessage() {}, onClose() {}, onError() {} }

        const wsUrl = endpoint.replace(/^http/, "ws") + subPath + (c.req.url.includes("?") ? new URL(c.req.url).search : "")
        const clientProtocol = c.req.header("sec-websocket-protocol") ?? ""
        let upstream: WebSocket | null = null
        const queue: (string | ArrayBuffer)[] = []

        return {
          onOpen(_, ws) {
            const protocols = clientProtocol ? clientProtocol.split(",").map(s => s.trim()) : undefined
            upstream = new WebSocket(wsUrl, protocols as string[] | undefined)
            upstream.onopen = () => {
              for (const m of queue) upstream!.send(m)
              queue.length = 0
            }
            upstream.onmessage = (e) => {
              if (typeof e.data === "string") ws.send(e.data)
              else if (e.data instanceof ArrayBuffer) ws.send(e.data)
              else if (ArrayBuffer.isView(e.data)) ws.send(e.data.buffer as ArrayBuffer)
            }
            upstream.onclose = (e) => ws.close(e.code, e.reason)
            upstream.onerror = () => ws.close()
          },
          onMessage(event, ws) {
            if (!upstream) return
            if (upstream.readyState === WebSocket.OPEN) {
              if (typeof event.data === "string") upstream.send(event.data)
              else if (event.data instanceof ArrayBuffer) upstream.send(event.data)
            } else if (upstream.readyState === WebSocket.CONNECTING) {
              if (typeof event.data === "string") queue.push(event.data)
              else if (event.data instanceof ArrayBuffer) queue.push(event.data)
            }
          },
          onClose() {
            upstream?.close()
            upstream = null
            queue.length = 0
          },
          onError() {
            upstream?.close()
            upstream = null
            queue.length = 0
          },
        }
      }),
    )
    .all(
      "/session/:sessionID/proxy/:port/*",
      describeRoute({
        summary: "Proxy request to sandbox service",
        description: "Proxy HTTP requests to a service running inside the sandbox. Use after starting a dev server with bash background:true.",
        operationId: "session.proxy",
        responses: {
          200: { description: "Proxied response" },
        },
      }),
      async (c) => {
        const sessionID = c.req.param("sessionID") as SessionID
        const port = parseInt(c.req.param("port"), 10)
        if (isNaN(port) || port < 1 || port > 65535) return c.json({ error: "invalid port" }, 400)

        const prefix = `/session/${sessionID}/proxy/${port}`
        const wildcard = c.req.path.slice(prefix.length + 1) || ""
        const subPath = "/" + wildcard

        const endpoint = await AppRuntime.runPromise(
          SandboxProvider.Service.use((svc) => svc.getEndpoint(sessionID, port)),
        ).catch(() => null)
        if (!endpoint) return c.json({ error: "sandbox unreachable" }, 502)

        const target = new URL(subPath === "/" ? "/" : subPath, endpoint)
        target.search = new URL(c.req.url).search

        const headers = new Headers()
        c.req.raw.headers.forEach((v, k) => {
          if (!["host", "connection"].includes(k.toLowerCase())) headers.set(k, v)
        })

        let res: Response
        try {
          res = await fetch(target.toString(), {
            method: c.req.method,
            headers,
            body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
            redirect: "manual",
          })
        } catch (e: any) {
          return c.json({ error: "sandbox unreachable", detail: e?.message }, 502)
        }

        const resHeaders = new Headers(res.headers)
        resHeaders.delete("transfer-encoding")

        const location = resHeaders.get("location")
        if (location) {
          if (location.startsWith("/")) {
            resHeaders.set("location", prefix + location)
          } else if (location.startsWith(endpoint)) {
            resHeaders.set("location", prefix + location.slice(endpoint.length))
          }
        }

        const contentType = resHeaders.get("content-type") ?? ""
        const isHtml = contentType.includes("text/html")
        const isJs = /(?:javascript|ecmascript|text\/jsx|text\/tsx)/.test(contentType) || /\.(?:m?js|mjsx|ts|tsx)(?:\?|$)/.test(target.pathname)
        const skipRewrite = /\/(_next|_nuxt|assets|build|static)\/(static\/)?(chunks|js|css|media)\//.test(target.pathname)

        if ((isHtml || (isJs && !skipRewrite)) && res.body) {
          resHeaders.delete("content-encoding")
          resHeaders.delete("content-length")
          const text = await res.text()
          if (text.length > 5 * 1024 * 1024) {
            return new Response(text, { status: res.status, statusText: res.statusText, headers: resHeaders })
          }
          const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          let rewritten = text.replace(
            new RegExp(`(["'])((?!${escaped}|//)/[^"'>]*)(?=["'])`, "g"),
            `$1${prefix}$2`,
          )
          if (isHtml) {
            rewritten = rewritten.replace(
              /(<head[^>]*>)/i,
              `$1<script data-oc-prefix="${prefix}"></script>${INJECT_SCRIPT(prefix)}`,
            )
            if (res.status >= 400) {
              push(sessionID, port, [{
                type: "network",
                message: `HTTP ${res.status} ${res.statusText} for ${subPath}`,
                url: subPath,
                timestamp: Date.now(),
              }])
            }
          }
          return new Response(rewritten, {
            status: res.status,
            statusText: res.statusText,
            headers: resHeaders,
          })
        }

        resHeaders.delete("content-encoding")
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: resHeaders,
        })
      },
    )
    .get(
      "/session/:sessionID/proxy-errors",
      async (c) => {
        const sessionID = c.req.param("sessionID") as SessionID
        const result: Record<number, ProxyError[]> = {}
        for (const [key, errs] of errors) {
          if (key.startsWith(sessionID + ":")) {
            const port = parseInt(key.split(":")[1], 10)
            if (!isNaN(port) && errs.length) result[port] = errs.slice(-20)
          }
        }
        return c.json(result)
      },
    )
