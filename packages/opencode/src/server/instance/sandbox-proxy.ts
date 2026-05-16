import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { describeRoute } from "hono-openapi"
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
const MAX_SESSIONS = 500
const reportTs = new Map<string, number>()
const REPORT_INTERVAL = 1000 // ms，每个 key 最多 1 次/秒

function push(sessionID: string, port: number, items: ProxyError[]) {
  const key = `${sessionID}:${port}`
  const buf = errors.get(key) ?? []
  buf.push(...items)
  if (buf.length > MAX_ERRORS) buf.splice(0, buf.length - MAX_ERRORS)
  errors.set(key, buf)
  if (errors.size > MAX_SESSIONS) {
    const oldest = errors.keys().next().value
    if (oldest) errors.delete(oldest)
  }
}

function get(sessionID: string, port: number) {
  return errors.get(`${sessionID}:${port}`) ?? []
}

export function clear(sessionID: string) {
  for (const key of errors.keys()) {
    if (key.startsWith(sessionID + ":")) errors.delete(key)
  }
  for (const key of reportTs.keys()) {
    if (key.startsWith(sessionID + ":")) reportTs.delete(key)
  }
}

const INJECT_SCRIPT = (prefix: string) => `<script>;(function(){
var P="${prefix}";
function f(u){return typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/"&&!u.startsWith(P)?P+u:u}
function fUrl(u){if(typeof u!=="string")return u;if(u.charAt(0)==="/"&&u.charAt(1)!=="/")return P+u;try{var x=new URL(u);if(x.host===location.host&&x.pathname.charAt(0)==="/"&&!x.pathname.startsWith(P))return x.origin+P+x.pathname+x.search+x.hash}catch(e){}return u}
var _ws=window.WebSocket;
window.WebSocket=function(u,pr){
  if(typeof u==="string"){u=fUrl(u)}
  return pr?new _ws(u,pr):new _ws(u);
};
window.WebSocket.prototype=_ws.prototype;
window.WebSocket.CONNECTING=_ws.CONNECTING;
window.WebSocket.OPEN=_ws.OPEN;
window.WebSocket.CLOSING=_ws.CLOSING;
window.WebSocket.CLOSED=_ws.CLOSED;
var _fetch=window.fetch;
window.fetch=function(i,o){
  if(typeof i==="string"){i=f(i)}
  else if(i instanceof Request){var x=new URL(i.url);if(x.host===location.host&&x.pathname.charAt(0)==="/"&&!x.pathname.startsWith(P)){i=new Request(P+x.pathname+x.search+x.hash,i)}}
  return _fetch.call(window,i,o);
};
var _es=window.EventSource;
window.EventSource=function(u,o){return new _es(typeof u==="string"?f(u):u,o)};
window.EventSource.prototype=_es.prototype;
window.EventSource.CONNECTING=_es.CONNECTING;
window.EventSource.OPEN=_es.OPEN;
window.EventSource.CLOSED=_es.CLOSED;
var _xo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){if(typeof u==="string")arguments[1]=f(u);return _xo.apply(this,arguments)};
function _patchSetter(proto,prop){var d=Object.getOwnPropertyDescriptor(proto,prop);if(!d||!d.set)return;Object.defineProperty(proto,prop,{set:function(u){return d.set.call(this,typeof u==="string"?f(u):u)},get:d.get,configurable:true})}
_patchSetter(HTMLScriptElement.prototype,"src");
_patchSetter(HTMLLinkElement.prototype,"href");
_patchSetter(HTMLImageElement.prototype,"src");
_patchSetter(HTMLMediaElement.prototype,"src");
var _err=console.error;
console.error=function(){
  _err.apply(console,arguments);
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
  img.src=P+"/__error_report?e="+encodeURIComponent(JSON.stringify(errs));
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
        const key = `${sessionID}:${port}`
        const now = Date.now()
        if ((reportTs.get(key) ?? 0) + REPORT_INTERVAL > now) return c.json({ ok: true })
        // 校验沙箱存在，防止 fake session 撑大 errors Map
        const sb = await AppRuntime.runPromise(
          SandboxProvider.Service.use((svc) => svc.get(sessionID)),
        ).catch(() => null)
        if (!sb) return c.json({ ok: true })
        reportTs.set(key, now)
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
        const subPath = "/" + (c.req.param("*") ?? "")

        const sb = await AppRuntime.runPromise(
          SandboxProvider.Service.use((svc) => svc.get(sessionID)),
        ).catch(() => null)
        if (!sb) return { onOpen(_: any, ws: any) { ws.close(1011, "sandbox unreachable") }, onMessage() {}, onClose() {}, onError() {} }
        const endpoint = await sb.getEndpointUrl(port).catch(() => null)
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
        const subPath = "/" + (c.req.param("*") ?? "")

        const sb = await AppRuntime.runPromise(
          SandboxProvider.Service.use((svc) => svc.get(sessionID)),
        ).catch(() => null)
        if (!sb) return c.json({ error: "sandbox unreachable" }, 502)
        const endpoint = await sb.getEndpointUrl(port).catch(() => null)
        if (!endpoint) return c.json({ error: "sandbox unreachable" }, 502)

        const target = new URL(endpoint + subPath)
        target.search = new URL(c.req.url).search

        const headers = new Headers()
        c.req.raw.headers.forEach((v, k) => {
          if (!["host", "connection", "accept-encoding"].includes(k.toLowerCase())) headers.set(k, v)
        })
        headers.set("Accept-Encoding", "identity")

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

        if (isHtml && res.body) {
          resHeaders.delete("content-encoding")
          resHeaders.delete("content-length")
          const text = await res.text()
          if (text.length > 5 * 1024 * 1024) {
            return new Response(text, { status: res.status, statusText: res.statusText, headers: resHeaders })
          }
          const htmlSrcHref = new RegExp(
            `((?:src|href)\\s*=\\s*["'])/(?!/)`,
            "g",
          )
          let rewritten = text.replace(htmlSrcHref, `$1${prefix}/`)
          // Rewrite import/from paths inside inline <script> blocks
          rewritten = rewritten.replace(
            /(<script[^>]*>)([\s\S]*?)(<\/script>)/gi,
            (_, open, code, close) => {
              // Skip scripts with src attribute (already handled by src rewrite above)
              if (/\ssrc\s*=/i.test(open)) return open + code + close
              let r = code.replace(
                new RegExp(`((?:import|from)\\s*(?:["']))/(?!/)`, "g"),
                `$1${prefix}/`,
              )
              // Rewrite JSON string paths in RSC flight data: "/_next/...", "/about", etc.
              r = r.replace(
                new RegExp(`(["'])/(?!/)(?!${prefix.slice(1)})`, "g"),
                `$1${prefix}/`,
              )
              // Rewrite escaped JSON paths: \"/_next/...\", \"/about\"
              r = r.replace(
                new RegExp(`(\\\\["'])/(?!/)(?!${prefix.slice(1)})`, "g"),
                `$1${prefix}/`,
              )
              return open + r + close
            },
          )
          const inject = `<script data-oc-prefix="${prefix}"></script>${INJECT_SCRIPT(prefix)}`
          if (/<head[\s>]/i.test(rewritten)) {
            rewritten = rewritten.replace(/(<head[^>]*>)/i, `$1${inject}`)
          } else if (/<body[\s>]/i.test(rewritten)) {
            rewritten = rewritten.replace(/(<body[^>]*>)/i, `${inject}$1`)
          } else {
            rewritten = inject + rewritten
          }
          if (res.status >= 400) {
            push(sessionID, port, [{
              type: "network",
              message: `HTTP ${res.status} ${res.statusText} for ${subPath}`,
              url: subPath,
              timestamp: Date.now(),
            }])
          }
          return new Response(rewritten, {
            status: res.status,
            statusText: res.statusText,
            headers: resHeaders,
          })
        }

        const isJs = /(?:javascript|ecmascript|text\/jsx|text\/tsx)/.test(contentType) || /\.(?:m?js|mjsx|ts|tsx)(?:\?|$)/.test(target.pathname)
        if (isJs && res.body) {
          resHeaders.delete("content-encoding")
          resHeaders.delete("content-length")
          const text = await res.text()
          if (text.length > 5 * 1024 * 1024) {
            return new Response(text, { status: res.status, statusText: res.statusText, headers: resHeaders })
          }
          let rewritten = text.replace(
            new RegExp(`((?:import|from)\\s*(?:["']))/(?!/)`, "g"),
            `$1${prefix}/`,
          )
          rewritten = rewritten.replace(
            /__webpack_require__\.p\s*=\s*"\/(?!\/)/g,
            `__webpack_require__.p="${prefix}/`,
          )
          rewritten = rewritten.replace(/\bBrowserRouter\b/g, "HashRouter")
          return new Response(rewritten, {
            status: res.status,
            statusText: res.statusText,
            headers: resHeaders,
          })
        }

        const isCss = contentType.includes("text/css") || /\.css(?:\?|$)/.test(target.pathname)
        if (isCss && res.body) {
          resHeaders.delete("content-encoding")
          resHeaders.delete("content-length")
          const text = await res.text()
          if (text.length > 5 * 1024 * 1024) {
            return new Response(text, { status: res.status, statusText: res.statusText, headers: resHeaders })
          }
          const rewritten = text.replace(
            /(url\s*\(\s*["']?)\//g,
            `$1${prefix}/`,
          )
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
