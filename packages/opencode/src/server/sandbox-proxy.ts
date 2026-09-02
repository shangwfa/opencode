import { Effect, Schema, Queue, Stream, Fiber, Duration, Option, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import * as Sse from "effect/unstable/encoding/Sse"
import { ConnectionConfig } from "@alibaba-group/opensandbox"
import { Bus } from "@/bus"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { Flag } from "@/flag/flag"
import * as Database from "@/storage/db"
import { SessionTable } from "@/session/session.pg"
import { eq } from "drizzle-orm"
import { websocket } from "./routes/instance/httpapi/middleware/proxy"
import { resolveSandboxOpts } from "@/session/sandbox-opts"
import { insertExecLog, updateExecLog, queryExecLogsBySession, queryExecLog, type ExecLog } from "@/session/exec-log"
import { ExecFailed } from "@/sandbox/exec-failed"
import { toSandboxCwd, toSandboxPath } from "@/tool/sandbox-path"
import path from "path"

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
const REPORT_INTERVAL = 1000

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

export function clearProxyErrors(sessionID: string) {
  for (const key of errors.keys()) {
    if (key.startsWith(sessionID + ":")) errors.delete(key)
  }
  for (const key of reportTs.keys()) {
    if (key.startsWith(sessionID + ":")) reportTs.delete(key)
  }
}

const INJECT_SCRIPT = (prefix: string) => `<script>;(function(){
var P="${prefix}";
window.__OC_PROXY_PREFIX__=P;
try{var _yd=window.YD||{};Object.defineProperty(window,"YD",{configurable:true,get:function(){return _yd},set:function(v){_yd=Object.assign({},_yd,v)}});if(_yd.__PROJECT_APP_BASE_ROUTE__===undefined)_yd.__PROJECT_APP_BASE_ROUTE__=P}catch(e){}
function f(u){return typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/"&&!u.startsWith(P)?P+u:u}
 function fUrl(u){if(typeof u!=="string")return u;if(u.charAt(0)==="/"&&u.charAt(1)!=="/")return P+u;try{var x=new URL(u);if((x.protocol==="ws:"||x.protocol==="wss:")&&x.pathname.charAt(0)==="/"&&!x.pathname.startsWith(P)){var p=location.protocol==="https:"?"wss:":"ws:";return p+"//"+location.host+P+x.pathname+x.search+x.hash}if(x.host===location.host&&x.pathname.charAt(0)==="/"&&!x.pathname.startsWith(P))return x.origin+P+x.pathname+x.search+x.hash}catch(e){}return u}
var _ws=window.WebSocket;
window.WebSocket=function(u,pr){if(typeof u==="string")u=fUrl(u);return pr?new _ws(u,pr):new _ws(u)};
window.WebSocket.prototype=_ws.prototype;
window.WebSocket.CONNECTING=_ws.CONNECTING;window.WebSocket.OPEN=_ws.OPEN;window.WebSocket.CLOSING=_ws.CLOSING;window.WebSocket.CLOSED=_ws.CLOSED;
var _fetch=window.fetch;
window.fetch=function(i,o){
if(typeof i==="string"){i=f(i)}
else if(i instanceof Request){var x=new URL(i.url);if(x.host===location.host&&x.pathname.charAt(0)==="/"&&!x.pathname.startsWith(P))i=new Request(P+x.pathname+x.search+x.hash,i)}
return _fetch.call(window,i,o)};
var _es=window.EventSource;
window.EventSource=function(u,o){return new _es(typeof u==="string"?f(u):u,o)};
window.EventSource.prototype=_es.prototype;
window.EventSource.CONNECTING=_es.CONNECTING;window.EventSource.OPEN=_es.OPEN;window.EventSource.CLOSED=_es.CLOSED;
var _xo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){if(typeof u==="string")arguments[1]=f(u);return _xo.apply(this,arguments)};
function _patchSetter(proto,prop){var d=Object.getOwnPropertyDescriptor(proto,prop);if(!d||!d.set)return;Object.defineProperty(proto,prop,{set:function(u){return d.set.call(this,typeof u==="string"?f(u):u)},get:d.get,configurable:true})}
_patchSetter(HTMLScriptElement.prototype,"src");
_patchSetter(HTMLLinkElement.prototype,"href");
_patchSetter(HTMLImageElement.prototype,"src");
_patchSetter(HTMLMediaElement.prototype,"src");
var _err=console.error;
console.error=function(){_err.apply(console,arguments);try{__ocReport([{type:"runtime",message:Array.from(arguments).map(function(a){return typeof a==="string"?a:typeof a==="object"&&a&&a.message?a.message:String(a)}).join(" "),timestamp:Date.now()}])}catch(e){}};
window.addEventListener("error",function(e){try{__ocReport([{type:"runtime",message:e.message,url:e.filename,line:e.lineno,col:e.colno,stack:e.error&&e.error.stack||"",timestamp:Date.now()}])}catch(ex){}});
window.addEventListener("unhandledrejection",function(e){try{__ocReport([{type:"runtime",message:"UnhandledPromise: "+(e.reason&&e.reason.message||String(e.reason)),stack:e.reason&&e.reason.stack||"",timestamp:Date.now()}])}catch(ex){}});
function __ocReport(errs){var img=new Image();img.src=P+"/__error_report?e="+encodeURIComponent(JSON.stringify(errs))}
})();</script>`

const VITE_CLIENT_BUST = `oc=${Date.now().toString(36)}`

function rewriteHtml(prefix: string, text: string) {
  const htmlSrcHref = new RegExp("((?:src|href)\\s*=\\s*[\"'])/(?!/)", "g")
  let rewritten = text.replace(htmlSrcHref, `$1${prefix}/`)
  rewritten = rewritten.replace(`${prefix}/@vite/client`, `${prefix}/@vite/client?${VITE_CLIENT_BUST}`)
  rewritten = rewritten.replace(
    /(<script[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_, open, code, close) => {
      if (/\ssrc\s*=/i.test(open)) return open + code + close
      let r = code.replace(new RegExp(`((?:import|from)\\s*(?:["']))/(?!/)`, "g"), `$1${prefix}/`)
      r = r.replace(new RegExp(`(["'])/(?!/)(?!${prefix.slice(1)})`, "g"), `$1${prefix}/`)
      return open + r + close
    },
  )
  const inject = `<script data-oc-prefix="${prefix}"></script>${INJECT_SCRIPT(prefix)}`
  if (/<head[\s>]/i.test(rewritten)) rewritten = rewritten.replace(/(<head[^>]*>)/i, `$1${inject}`)
  else if (/<body[\s>]/i.test(rewritten)) rewritten = rewritten.replace(/(<body[^>]*>)/i, `${inject}$1`)
  else rewritten = inject + rewritten
  return rewritten
}

function rewriteJs(prefix: string, text: string, isViteClient = false) {
  let rewritten = text.replace(new RegExp(`((?:import|from)\\s*(?:["']))/(?!/)`, "g"), `$1${prefix}/`)
  rewritten = rewritten.replace(/__webpack_require__\.p\s*=\s*"\/(?!\/)/g, `__webpack_require__.p="${prefix}/`)
  rewritten = rewritten.replace(/__HMR_BASE__/g, JSON.stringify(prefix + "/"))
  rewritten = rewritten.replace(/__BASE__/g, JSON.stringify(prefix + "/"))
  if (isViteClient) {
    rewritten = rewritten.replace('${"/"}', '${"' + prefix + '/"}')
    rewritten = rewritten.replace(/__HMR_CONFIG_NAME__/g, "undefined")
    rewritten = rewritten.replace(/__HMR_PROTOCOL__/g, "undefined")
    rewritten = rewritten.replace(/__HMR_PORT__/g, "undefined")
    rewritten = rewritten.replace(/__HMR_HOSTNAME__/g, "undefined")
    rewritten = rewritten.replace(/__HMR_DIRECT_TARGET__/g, "undefined")
    rewritten = rewritten.replace(/__HMR_TIMEOUT__/g, "30000")
    rewritten = rewritten.replace(/__HMR_ENABLE_OVERLAY__/g, "true")
    rewritten = rewritten.replace(/__SERVER_HOST__/g, '"localhost"')
    rewritten = rewritten.replace(/__WS_TOKEN__/g, '""')
  }
  // 依赖包（react-router-dom 等）内部同时定义 BrowserRouter 与 HashRouter，
  // 全局替换会产生重复声明导致库崩溃；应用侧用 window.__OC_PROXY_PREFIX__
  // （见 INJECT_SCRIPT）作为 BrowserRouter basename 适配代理前缀
  // 模块 import 的 /@vite/client 与 HTML script 引用统一 cache-bust，
  // 避免浏览器用旧缓存 client（base 无代理前缀）处理 HMR 消息
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  rewritten = rewritten.replace(
    new RegExp(`(${escapedPrefix}/@vite/client)(?!\\?)`, "g"),
    `$1?${VITE_CLIENT_BUST}`,
  )
  return rewritten
}

function rewriteCss(prefix: string, text: string) {
  return text.replace(/(url\s*\(\s*["']?)\//g, `$1${prefix}/`)
}

function parsePort(raw: string) {
  const p = parseInt(raw, 10)
  if (isNaN(p) || p < 1 || p > 65535) return undefined
  return p
}

function extractSubPath(url: string, prefix: string) {
  if (!url) return "/"
  const parsed = new URL(url, "http://localhost")
  const path = parsed.pathname
  if (path.startsWith(prefix)) {
    const rest = path.slice(prefix.length)
    return rest.startsWith("/") ? rest : "/" + rest
  }
  return "/"
}

function headersToRecord(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {}
  headers.forEach((v, k) => { obj[k] = v })
  return obj
}

const MAX_BODY = 5 * 1024 * 1024
const PathParams = Schema.Struct({ sessionID: SessionID, port: Schema.String })
const SessionParams = Schema.Struct({ sessionID: SessionID })
const SandboxParams = Schema.Struct({ sandboxID: Schema.String })
const ExecIdParams = Schema.Struct({ sessionID: SessionID, execId: Schema.String })
const ErrorReportQuery = Schema.Struct({ e: Schema.optional(Schema.String) })
const ExecBody = Schema.Struct({
  command: Schema.String,
  workingDirectory: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(Schema.Number),
  // async exec opt-in: 失败时是否注入自修复提示到会话。默认不开启，由调用方显式声明
  repairOnFailure: Schema.optional(Schema.Boolean),
})
const KeepAliveBody = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  boot: Schema.optional(Schema.Boolean),
})

// ── files API（创建目录 / 创建文件 / 下载 / 上传）────────────────
const FilePathQuery = Schema.Struct({
  path: Schema.String,
})
const FileUploadQuery = Schema.Struct({
  path: Schema.optional(Schema.String),
  filename: Schema.String,
})
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

function encodeDownloadFilename(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

type ExecSseEvent =
  | { _tag: "stdout"; text: string }
  | { _tag: "stderr"; text: string }
  | { _tag: "done"; exitCode: number | null; stdout: string; stderr: string }

type ExecState = {
  status: "running" | "completed" | "failed" | "killed" | "timed_out"
  exitCode: number | null
  stdout: string
  stderr: string
  startedAt: number
  finishedAt: number | null
  error?: { name: string; value: string; traceback: string[] }
  queue: Queue.Queue<ExecSseEvent>
  seq: number
  sessionID: string
  command: string
  fiber: Fiber.Fiber<void, unknown> | null
  queuedOutputSize: number
}
const execStore = new Map<string, ExecState>()
const sessionExecIndex = new Map<string, Set<string>>()
const MAX_EXEC_STORE = 200
let execCounter = 0

const MAX_OUTPUT = 64 * 1024
function truncateOutput(s: string | undefined): string | undefined {
  if (!s) return s
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n...[truncated]" : s
}

export const sandboxProxyRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const sandbox = yield* SandboxProvider.Service
    const bus = yield* Bus.Service

    const requireSession = (sessionID: SessionID) =>
      Effect.promise(() =>
        Database.use((db) => db
          .select({ id: SessionTable.id, directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()),
      ).pipe(
        Effect.flatMap((row) => row ? Effect.succeed(row) : Effect.fail({ _tag: "NotFound" as const, sessionID })),
      )

    const resolveRootSessionID = (sessionID: SessionID) =>
      Effect.promise(() => resolveSandboxOpts(sessionID)).pipe(Effect.map((root) => root.id))

    // Retry worktree creation — newly created sandboxes may need a few
    // seconds for execd to become ready (especially under QEMU). The old
    yield* router.add("GET", "/session/:sessionID/proxy/:port/__errors",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(PathParams)
        const port = parsePort(params.port)
        if (!port) return HttpServerResponse.jsonUnsafe({ error: "invalid port" }, { status: 400 })
        return HttpServerResponse.jsonUnsafe(get(params.sessionID, port))
      }),
    )

    yield* router.add("GET", "/session/:sessionID/proxy/:port/__error_report",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(PathParams)
        const port = parsePort(params.port)
        if (!port) return HttpServerResponse.jsonUnsafe({ ok: true })
        const query = yield* HttpServerRequest.schemaSearchParams(ErrorReportQuery)
        const raw = query.e
        if (!raw || raw.length > 10240) return HttpServerResponse.jsonUnsafe({ ok: true })
        const key = `${params.sessionID}:${port}`
        const now = Date.now()
        if ((reportTs.get(key) ?? 0) + REPORT_INTERVAL > now) return HttpServerResponse.jsonUnsafe({ ok: true })
        const sb = yield* sandbox.get(params.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!sb) return HttpServerResponse.jsonUnsafe({ ok: true })
        reportTs.set(key, now)
        try {
          const parsed = JSON.parse(decodeURIComponent(raw))
          if (!Array.isArray(parsed)) return HttpServerResponse.jsonUnsafe({ ok: true })
          const items: ProxyError[] = parsed.slice(0, 10).map((e: any) => ({
            type: (e.type === "runtime" || e.type === "network" || e.type === "compile") ? e.type : "runtime",
            message: String(e.message ?? "").slice(0, 2048),
            url: e.url ? String(e.url).slice(0, 512) : undefined,
            line: typeof e.line === "number" ? e.line : undefined,
            col: typeof e.col === "number" ? e.col : undefined,
            stack: e.stack ? String(e.stack).slice(0, 4096) : undefined,
            timestamp: typeof e.timestamp === "number" ? e.timestamp : Date.now(),
          }))
          push(params.sessionID, port, items)
        } catch {}
        return HttpServerResponse.jsonUnsafe({ ok: true })
      }),
    )

    yield* router.add("GET", "/session/:sessionID/proxy-errors",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(Schema.Struct({ sessionID: SessionID }))
        const result: Record<number, ProxyError[]> = {}
        for (const [key, errs] of errors) {
          if (key.startsWith(params.sessionID + ":")) {
            const p = parseInt(key.split(":")[1], 10)
            if (!isNaN(p) && errs.length) result[p] = errs.slice(-20)
          }
        }
        return HttpServerResponse.jsonUnsafe(result)
      }),
    )

    yield* router.add("GET", "/session/:sessionID/endpoint/:port",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(PathParams)
        const port = parsePort(params.port)
        if (!port) return HttpServerResponse.jsonUnsafe({ error: "invalid port" }, { status: 400 })

        const sb = yield* sandbox.get(params.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!sb) return HttpServerResponse.jsonUnsafe({ error: "sandbox unreachable" }, { status: 502 })

        const protocol = (process.env.OPENCODE_SANDBOX_PROTOCOL as "http" | "https") ?? "http"

        const directUrl = yield* Effect.tryPromise({
          try: async () => {
            const ep = await (sb as any).sandboxes.getSandboxEndpoint(sb.id, port, false)
            return `${protocol}://${ep.endpoint}` as string | undefined
          },
          catch: () => undefined as string | undefined,
        })

        const proxyUrl = yield* Effect.tryPromise({
          try: async () => {
            const ep = await (sb as any).sandboxes.getSandboxEndpoint(sb.id, port, true)
            return `${protocol}://${ep.endpoint}`
          },
          catch: () => undefined as string | undefined,
        })

        const req = yield* HttpServerRequest.HttpServerRequest
        const reqMode = new URL(Option.getOrElse(HttpServerRequest.toURL(req), () => new URL(req.url, "http://localhost"))).searchParams.get("mode")

        const fallback = `/session/${params.sessionID}/proxy/${port}/`
        const mode = reqMode === "proxy" ? "proxy" : reqMode === "direct" ? "direct" : directUrl ? "direct" : "proxy"
        const url = mode === "proxy" ? (proxyUrl ?? fallback) : (directUrl ?? proxyUrl ?? fallback)

        // 完整的外部可访问代理地址（基于浏览器可达的 public domain），预览前端拿到即可直接访问
        const previewUrl = proxyUrl
          ? proxyUrl.replace(/^https?:\/\/[^/]+/, `${protocol}://${Flag.OPENCODE_SANDBOX_PUBLIC_DOMAIN}`)
          : undefined

        return HttpServerResponse.jsonUnsafe({
          mode,
          url,
          directUrl,
          proxyUrl,
          previewUrl,
          port,
          sandboxId: sb.id,
          fallback,
        })
      }),
    )

    yield* router.add("POST", "/session/:sessionID/exec",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(SessionParams)
        const session = yield* requireSession(params.sessionID).pipe(Effect.catch(() => Effect.fail(HttpServerResponse.jsonUnsafe({ error: "session not found" }, { status: 404 }))))
        const body = yield* HttpServerRequest.schemaBodyJson(ExecBody).pipe(
          Effect.catch(() => Effect.fail(HttpServerResponse.jsonUnsafe({ error: "invalid request body" }, { status: 400 }))),
        )
        if (!body.command) return HttpServerResponse.jsonUnsafe({ error: "command is required" }, { status: 400 })

        // 查 root session 的 pvcMode/appId（app 模式需正确 PVC subPath）
        const root = yield* Effect.promise(() => resolveSandboxOpts(params.sessionID))
        const useApp = root.pvcMode === "app" && !!root.appId?.trim()

        if (useApp) {
          yield* sandbox.getOrCreate(root.id, { pvcMode: root.pvcMode, appId: root.appId, sandbox: root.sandbox }).pipe(
            Effect.catch(() => Effect.void),
          )
        }

        const command = body.command
        const workingDirectory = body.workingDirectory ?? session.directory
        const sandboxWorkingDirectory = toSandboxCwd(workingDirectory, session.directory)
        const t0 = Date.now()
        const execId = `exec-${++execCounter}-${t0}`
        const result = yield* sandbox.runInSession(
          root.id,
          command,
          { workingDirectory: sandboxWorkingDirectory, timeoutSeconds: body.timeoutSeconds },
          {},
        ).pipe(Effect.catch((err) => Effect.succeed({ err } as any)))

        const stdout = result?.logs?.stdout.map((m: any) => m.text).join("\n") ?? ""
        const stderr = result?.logs?.stderr.map((m: any) => m.text).join("\n") ?? (result?.err?.message ?? "Sandbox execution failed")

        yield* Effect.promise(() => insertExecLog({
          id: execId,
          session_id: root.id,
          command,
          working_directory: workingDirectory,
          status: result?.error?.name === "TimeoutError" ? "timed_out" : (result && !result.err) ? "completed" : "failed",
          exit_code: result?.exitCode ?? null,
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
          error: result?.error ? JSON.stringify({ name: result.error.name, value: result.error.value }) : null,
          source: "exec",
          time_started: t0,
          time_finished: Date.now(),
        })).pipe(Effect.catch(() => Effect.void))

        // 同步 exec 的失败结果直接返回给调用方，不触发自修复注入
        if (!result) return HttpServerResponse.jsonUnsafe({ error: "execution failed" }, { status: 502 })

        return HttpServerResponse.jsonUnsafe({
          id: execId,
          exitCode: result.exitCode,
          stdout,
          stderr,
          error: result.error ? { name: result.error.name, value: result.error.value, traceback: result.error.traceback } : undefined,
        })
      }),
    )

    // ── async exec: 立即返回 execId，后台执行 ──────────────────────
    yield* router.add("POST", "/session/:sessionID/exec/async",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(SessionParams)
        const session = yield* requireSession(params.sessionID).pipe(Effect.catch(() => Effect.fail(HttpServerResponse.jsonUnsafe({ error: "session not found" }, { status: 404 }))))
        const body = yield* HttpServerRequest.schemaBodyJson(ExecBody).pipe(
          Effect.catch(() => Effect.fail(HttpServerResponse.jsonUnsafe({ error: "invalid request body" }, { status: 400 }))),
        )
        if (!body.command) return HttpServerResponse.jsonUnsafe({ error: "command is required" }, { status: 400 })

        // 查 root session 的 pvcMode/appId（app 模式需正确 PVC subPath）
        const root = yield* Effect.promise(() => resolveSandboxOpts(params.sessionID))
        const useApp = root.pvcMode === "app" && !!root.appId?.trim()

        if (useApp) {
          yield* sandbox.getOrCreate(root.id, { pvcMode: root.pvcMode, appId: root.appId, sandbox: root.sandbox }).pipe(
            Effect.catch(() => Effect.void),
          )
        }

        const sid = root.id
        const workingDirectory = body.workingDirectory ?? session.directory
        const execId = `exec-${++execCounter}-${Date.now()}`
        const q = yield* Queue.unbounded<ExecSseEvent>()
        const state: ExecState = {
          status: "running",
          exitCode: null,
          stdout: "",
          stderr: "",
          startedAt: Date.now(),
          finishedAt: null,
          queue: q,
          seq: 0,
          sessionID: sid,
          command: body.command,
          fiber: null,
          queuedOutputSize: 0,
        }
        execStore.set(execId, state)
        yield* Effect.promise(() => insertExecLog({
          id: execId,
          session_id: sid,
          command: body.command,
          working_directory: workingDirectory,
          status: "running",
          source: "exec-async",
          time_started: state.startedAt,
        })).pipe(Effect.catch(() => Effect.void))
        const idx = sessionExecIndex.get(sid)
        if (idx) idx.add(execId)
        else sessionExecIndex.set(sid, new Set([execId]))
        if (execStore.size > MAX_EXEC_STORE) {
          const oldest = execStore.keys().next().value
          if (oldest) {
            const old = execStore.get(oldest)
            execStore.delete(oldest)
            if (old) {
              if (old.status === "running" && old.fiber) {
                yield* Fiber.interrupt(old.fiber).pipe(Effect.catch(() => Effect.void))
              }
              const oldIdx = sessionExecIndex.get(old.sessionID)
              if (oldIdx) { oldIdx.delete(oldest); if (!oldIdx.size) sessionExecIndex.delete(old.sessionID) }
            }
          }
        }

        const cmd = body.command
        const opts = {
          workingDirectory: toSandboxCwd(workingDirectory, session.directory),
          timeoutSeconds: body.timeoutSeconds,
        }

        const handlers = {
          onStdout: (msg: { text: string }) => {
            const remaining = MAX_OUTPUT - state.queuedOutputSize
            if (remaining <= 0) return
            const text = msg.text.slice(0, remaining)
            state.queuedOutputSize += text.length
            Queue.offerUnsafe(q, { _tag: "stdout" as const, text })
          },
          onStderr: (msg: { text: string }) => {
            const remaining = MAX_OUTPUT - state.queuedOutputSize
            if (remaining <= 0) return
            const text = msg.text.slice(0, remaining)
            state.queuedOutputSize += text.length
            Queue.offerUnsafe(q, { _tag: "stderr" as const, text })
          },
        }

        const runAsync = Effect.gen(function* () {
          const result = yield* sandbox.runDetached(sid, cmd, opts, handlers).pipe(
            Effect.catch(() => Effect.succeed(null as any)),
          )
          if (state.status === "killed") return
          let fullStdout = ""
          let fullStderr = ""
          if (result) {
            fullStdout = result.logs.stdout.map((m: any) => m.text).join("\n")
            fullStderr = result.logs.stderr.map((m: any) => m.text).join("\n")
            state.exitCode = result.exitCode
            state.stdout = truncateOutput(fullStdout) ?? ""
            state.stderr = truncateOutput(fullStderr) ?? ""
            if (result.error) state.error = { name: result.error.name, value: result.error.value, traceback: result.error.traceback }
            state.status =
              result.error?.name === "TimeoutError"
                ? "timed_out"
                : result.exitCode !== null && result.exitCode !== 0
                  ? "failed"
                  : "completed"
          } else {
            state.status = "failed"
            fullStderr = "Sandbox execution failed"
          }
          state.finishedAt = Date.now()
          yield* Effect.promise(() => updateExecLog(execId, {
            status: state.status,
            exit_code: state.exitCode,
            stdout: truncateOutput(state.stdout),
            stderr: truncateOutput(state.stderr),
            error: state.error ? JSON.stringify({ name: state.error.name, value: state.error.value }) : null,
            time_finished: state.finishedAt,
          })).pipe(Effect.catch(() => Effect.void))
          if (state.status !== "completed" && body.repairOnFailure === true) {
            yield* ExecFailed.maybeTrigger({
              provider: sandbox,
              rootID: sid,
              directory: session.directory,
              execId,
              command: body.command,
              workingDirectory: opts.workingDirectory,
              exitCode: state.exitCode,
              status: state.status,
              stdout: fullStdout,
              stderr: fullStderr,
            })
          }
          Queue.offerUnsafe(q, { _tag: "done" as const, exitCode: state.exitCode, stdout: state.stdout, stderr: state.stderr })
          Queue.endUnsafe(q as any)
        }).pipe(Effect.catch(() => Effect.gen(function* () {
          if (state.status === "killed") return
          state.status = "failed"
          state.finishedAt = Date.now()
          yield* Effect.promise(() => updateExecLog(execId, {
            status: "failed",
            time_finished: state.finishedAt,
          })).pipe(Effect.catch(() => Effect.void))
          Queue.offerUnsafe(q, { _tag: "done" as const, exitCode: null, stdout: "", stderr: "" })
          Queue.endUnsafe(q as any)
        })))

        const fiber = Effect.runFork(runAsync.pipe(Effect.provideService(SandboxProvider.Service, sandbox)))
        state.fiber = fiber

        return HttpServerResponse.jsonUnsafe({ execId, status: "running", sessionID: sid })
      }),
    )

    // ── exec status: 查看 async 执行结果 ─────────────────────────
    yield* router.add("GET", "/session/:sessionID/exec/:execId",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(ExecIdParams)
        const rootID = yield* resolveRootSessionID(params.sessionID)
        const state = execStore.get(params.execId)
        if (state) {
          if (state.sessionID !== rootID) return HttpServerResponse.jsonUnsafe({ error: "execId not found" }, { status: 404 })
          const { queue: _, seq: __, fiber: ___, ...rest } = state
          return HttpServerResponse.jsonUnsafe({ execId: params.execId, ...rest })
        }
        const log = yield* Effect.promise(() => queryExecLog(params.execId))
        if (!log || (log.session_id !== rootID && log.session_id !== params.sessionID)) {
          return HttpServerResponse.jsonUnsafe({ error: "execId not found" }, { status: 404 })
        }
        return HttpServerResponse.jsonUnsafe({ execId: log.id, sessionID: log.session_id, status: log.status, exitCode: log.exit_code, stdout: log.stdout, stderr: log.stderr, command: log.command, startedAt: log.time_started, finishedAt: log.time_finished })
      }),
    )

    // ── exec stream: SSE 实时输出 ────────────────────────────────
    yield* router.add("GET", "/session/:sessionID/exec/:execId/stream",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(ExecIdParams)
        const rootID = yield* resolveRootSessionID(params.sessionID)
        const state = execStore.get(params.execId)
        if (!state || state.sessionID !== rootID) return HttpServerResponse.jsonUnsafe({ error: "execId not found" }, { status: 404 })

        const q = state.queue

        const heartbeat = Stream.tick("15 seconds").pipe(
          Stream.drop(1),
          Stream.map(() => ({ _tag: "heartbeat" as const })),
        )

        const sseEvent = (ev: ExecSseEvent | { _tag: "heartbeat" }): Sse.Event | null => {
          if (ev._tag === "heartbeat") return { _tag: "Event" as const, event: "ping", id: undefined, data: "" }
          if (ev._tag === "stdout") return { _tag: "Event" as const, event: "stdout", id: undefined, data: JSON.stringify({ text: ev.text + "\n" }) }
          if (ev._tag === "stderr") return { _tag: "Event" as const, event: "stderr", id: undefined, data: JSON.stringify({ text: ev.text + "\n" }) }
          return { _tag: "Event" as const, event: "done", id: undefined, data: JSON.stringify({ execId: params.execId, status: state.status, exitCode: ev.exitCode, stdout: ev.stdout, stderr: ev.stderr }) }
        }

        return HttpServerResponse.stream(
          Stream.fromQueue(q).pipe(
            Stream.merge(heartbeat, { haltStrategy: "left" }),
            Stream.map(sseEvent),
            Stream.filter((ev): ev is Sse.Event => ev !== null),
            Stream.pipeThroughChannel(Sse.encode()),
            Stream.encodeText,
          ),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
            },
          },
        )
      }),
    )

    // ── exec kill: 中断正在运行的命令 ──────────────────────────────
    yield* router.add("POST", "/session/:sessionID/exec/:execId/kill",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(ExecIdParams)
        const rootID = yield* resolveRootSessionID(params.sessionID)
        const state = execStore.get(params.execId)
        if (!state || state.sessionID !== rootID) return HttpServerResponse.jsonUnsafe({ error: "execId not found" }, { status: 404 })
        if (state.status !== "running") return HttpServerResponse.jsonUnsafe({ error: "exec not running" }, { status: 409 })

        state.status = "killed"
        state.finishedAt = Date.now()
        state.exitCode = null
        yield* Effect.promise(() => updateExecLog(params.execId, {
          status: "killed",
          time_finished: state.finishedAt,
        })).pipe(Effect.catch(() => Effect.void))
        Queue.offerUnsafe(state.queue, { _tag: "done" as const, exitCode: null, stdout: state.stdout, stderr: state.stderr })
        Queue.endUnsafe(state.queue as any)

        // 并发 interrupt sandbox 命令 + fiber，加超时保护
        const fiberInterrupt = state.fiber
          ? Fiber.interrupt(state.fiber).pipe(Effect.catch(() => Effect.void))
          : Effect.void
        yield* Effect.all([
          sandbox.interrupt(rootID).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.catch(() => Effect.void),
          ),
          fiberInterrupt,
        ], { concurrency: "unbounded" }).pipe(Effect.catch(() => Effect.void))

        return HttpServerResponse.jsonUnsafe({ execId: params.execId, status: "killed" })
      }),
    )

    // ── exec list: 查询 session 的所有 exec ─────────────────────────
    yield* router.add("GET", "/session/:sessionID/execs",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(SessionParams)
        const rootID = yield* resolveRootSessionID(params.sessionID)
        const logs = yield* Effect.promise(async () => {
          if (rootID === params.sessionID) return await queryExecLogsBySession(rootID)
          const [rootLogs, sessionLogs] = await Promise.all([
            queryExecLogsBySession(rootID),
            queryExecLogsBySession(params.sessionID),
          ])
          return [...rootLogs, ...sessionLogs].sort((a, b) => b.time_started - a.time_started)
        })
        return HttpServerResponse.jsonUnsafe({ execs: logs.map((l: ExecLog) => ({ execId: l.id, command: l.command, status: l.status, startedAt: l.time_started, finishedAt: l.time_finished, exitCode: l.exit_code })) })
      }),
    )

    yield* router.add("POST", "/session/:sessionID/keep-alive",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(SessionParams)
        const body = yield* HttpServerRequest.schemaBodyJson(KeepAliveBody).pipe(
          Effect.catch(() => Effect.succeed({ enabled: true, boot: undefined })),
        )
        if (body.enabled !== false) {
          yield* sandbox.keepAlive(params.sessionID)
        } else {
          yield* sandbox.release(params.sessionID)
        }
        const sandboxId = body.enabled !== false && body.boot === true
          ? yield* sandbox.getOrCreate(params.sessionID).pipe(
              Effect.map((s) => s.id),
              Effect.catchDefect(() => Effect.succeed(null)),
            )
          : null
        yield* Effect.promise(() => insertExecLog({
          id: `action-${++execCounter}-${Date.now()}`,
          session_id: params.sessionID,
          command: JSON.stringify({ enabled: body.enabled !== false, boot: body.boot ?? false }),
          status: "completed",
          source: "keep-alive",
          time_started: Date.now(),
          time_finished: Date.now(),
        })).pipe(Effect.catch(() => Effect.void))
        return HttpServerResponse.jsonUnsafe({ sessionID: params.sessionID, keepAlive: body.enabled, sandboxId })
      }),
    )

    yield* router.add("GET", "/session/:sessionID/sandbox",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(SessionParams)
        const sb = yield* sandbox.get(params.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!sb) return HttpServerResponse.jsonUnsafe({ sessionID: params.sessionID, sandboxId: null })
        const healthy = yield* Effect.tryPromise(() => sb.isHealthy()).pipe(Effect.catch(() => Effect.succeed(false)))
        if (!healthy) return HttpServerResponse.jsonUnsafe({ sessionID: params.sessionID, sandboxId: null })
        return HttpServerResponse.jsonUnsafe({ sessionID: params.sessionID, sandboxId: sb.id })
      }),
    )

    yield* router.add("GET", "/session/:sessionID/keep-alive",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(SessionParams)
        const keep = yield* sandbox.isKeepAlive(params.sessionID)
        return HttpServerResponse.jsonUnsafe({ sessionID: params.sessionID, keepAlive: keep })
      }),
    )

    yield* router.add("POST", "/session/:sessionID/kill-sandbox",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(SessionParams)
        yield* sandbox.destroy(params.sessionID).pipe(Effect.catch(() => Effect.void))
        yield* Effect.promise(() => insertExecLog({
          id: `action-${++execCounter}-${Date.now()}`,
          session_id: params.sessionID,
          command: "destroy sandbox",
          status: "completed",
          source: "kill-sandbox",
          time_started: Date.now(),
          time_finished: Date.now(),
        })).pipe(Effect.catch(() => Effect.void))
        return HttpServerResponse.jsonUnsafe({ sessionID: params.sessionID, destroyed: true })
      }),
    )

    yield* router.add("POST", "/sandbox/:sandboxID/kill",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(SandboxParams)
        const sessionID = yield* sandbox.destroyById(params.sandboxID).pipe(Effect.catch(() => Effect.succeed(null)))
        if (!sessionID) return HttpServerResponse.jsonUnsafe({ error: "sandbox not found", sandboxID: params.sandboxID }, { status: 404 })
        yield* Effect.promise(() => insertExecLog({
          id: `action-${++execCounter}-${Date.now()}`,
          session_id: sessionID,
          command: `destroy sandbox ${params.sandboxID}`,
          status: "completed",
          source: "kill-sandbox",
          time_started: Date.now(),
          time_finished: Date.now(),
        })).pipe(Effect.catch(() => Effect.void))
        return HttpServerResponse.jsonUnsafe({ sandboxID: params.sandboxID, sessionID, destroyed: true })
      }),
    )

    // ── files API: 创建目录 / 创建文件 / 下载 / 上传 ──────────────
    // 解析 root session 的 sandbox（app 模式 PVC subPath 需要 root）
    const resolveSandbox = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const session = yield* requireSession(sessionID).pipe(Effect.catch(() => Effect.fail(HttpServerResponse.jsonUnsafe({ error: "session not found" }, { status: 404 }))))
        const root = yield* Effect.promise(() => resolveSandboxOpts(sessionID))
        const sb = yield* sandbox.getOrCreate(root.id, {
          pvcMode: root.pvcMode,
          appId: root.appId,
          sandbox: root.sandbox,
        }).pipe(Effect.mapError(() => HttpServerResponse.jsonUnsafe({ error: "sandbox unavailable" }, { status: 502 })))
        return { root, sb, session }
      })

    yield* router.add("POST", "/session/:sessionID/files/mkdir",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(SessionParams)
        const query = yield* HttpServerRequest.schemaSearchParams(FilePathQuery).pipe(
          Effect.catch(() => Effect.fail(HttpServerResponse.jsonUnsafe({ error: "invalid query" }, { status: 400 }))),
        )
        const { root, sb, session } = yield* resolveSandbox(params.sessionID)
        const sandboxPath = toSandboxPath(query.path, session.directory)
        const dir = path.posix.normalize(sandboxPath)
        if (!path.posix.isAbsolute(dir))
          return HttpServerResponse.jsonUnsafe({ error: "path must be absolute" }, { status: 400 })

        yield* Effect.tryPromise({
          try: () => sb.files.createDirectories([{ path: dir, mode: 755 }]),
          catch: (e) => new Error(`mkdir failed: ${e instanceof Error ? e.message : String(e)}`),
        }).pipe(
          Effect.mapError((error) => HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 502 })),
        )

        yield* Effect.promise(() => insertExecLog({
          id: `action-${++execCounter}-${Date.now()}`,
          session_id: root.id,
          command: JSON.stringify({ path: dir }),
          status: "completed",
          source: "file-mkdir",
          time_started: Date.now(),
          time_finished: Date.now(),
        })).pipe(Effect.catch(() => Effect.void))

        return HttpServerResponse.jsonUnsafe({ sessionID: params.sessionID, path: dir, created: true })
      }),
    )

    yield* router.add("POST", "/session/:sessionID/files/create",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(SessionParams)
        const query = yield* HttpServerRequest.schemaSearchParams(FilePathQuery).pipe(
          Effect.catch(() => Effect.fail(HttpServerResponse.jsonUnsafe({ error: "invalid query" }, { status: 400 }))),
        )
        const request = yield* HttpServerRequest.HttpServerRequest
        const sourceBody = request.source instanceof Request ? request.source.body : null

        const { root, sb, session } = yield* resolveSandbox(params.sessionID)
        const sandboxPath = toSandboxPath(query.path, session.directory)
        const target = path.posix.normalize(sandboxPath)
        if (!path.posix.isAbsolute(target))
          return HttpServerResponse.jsonUnsafe({ error: "path must be absolute" }, { status: 400 })
        const parent = path.posix.dirname(target)

        let size = 0
        const t0 = Date.now()
        let data: AsyncGenerator<Uint8Array> | ArrayBuffer
        if (sourceBody) {
          data = (async function* () {
            const reader = sourceBody.getReader()
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                size += value.byteLength
                if (size > MAX_UPLOAD_BYTES) throw new Error(`file exceeds ${MAX_UPLOAD_BYTES} byte limit`)
                yield value
              }
            } finally {
              reader.releaseLock()
            }
          })()
        } else {
          const buffer = yield* Effect.orDie(request.arrayBuffer)
          if (buffer.byteLength > MAX_UPLOAD_BYTES)
            return HttpServerResponse.jsonUnsafe({ error: `file exceeds ${MAX_UPLOAD_BYTES} byte limit` }, { status: 413 })
          size = buffer.byteLength
          data = buffer
        }

        yield* Effect.tryPromise({
          try: () =>
            sb.files
              .createDirectories([{ path: parent, mode: 755 }])
              .then(() => sb.files.writeFiles([{ path: target, data, mode: 644 }])),
          catch: (e) => new Error(`create failed: ${e instanceof Error ? e.message : String(e)}`),
        }).pipe(
          Effect.mapError((error) =>
            error.message.startsWith("file exceeds")
              ? HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 413 })
              : HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 502 }),
          ),
        )

        yield* Effect.promise(() => insertExecLog({
          id: `action-${++execCounter}-${Date.now()}`,
          session_id: root.id,
          command: JSON.stringify({ path: target, size }),
          status: "completed",
          source: "file-create",
          time_started: t0,
          time_finished: Date.now(),
        })).pipe(Effect.catch(() => Effect.void))

        return HttpServerResponse.jsonUnsafe({ sessionID: params.sessionID, path: target, size, created: true })
      }),
    )

    yield* router.add("GET", "/session/:sessionID/files/download",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(SessionParams)
        const query = yield* HttpServerRequest.schemaSearchParams(FilePathQuery).pipe(
          Effect.catch(() => Effect.fail(HttpServerResponse.jsonUnsafe({ error: "invalid query" }, { status: 400 }))),
        )
        const { root, sb, session } = yield* resolveSandbox(params.sessionID)
        const sandboxPath = toSandboxPath(query.path, session.directory)
        const target = path.posix.normalize(sandboxPath)
        if (!path.posix.isAbsolute(target))
          return HttpServerResponse.jsonUnsafe({ error: "path must be absolute" }, { status: 400 })

        // execd 的 getFileInfo 不保证返回类型位/type 字段（远程实现 mode 为纯权限位），
        // 存在性用 getFileInfo 确认，文件/目录类型用 exec 判断（与 tree 一致）。
        const info = yield* Effect.tryPromise({
          try: async () => (await sb.files.getFileInfo([target]))[target],
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined))
        if (!info) return HttpServerResponse.jsonUnsafe({ error: `path not found: ${target}` }, { status: 404 })

        const kindCmd = `if [ -d ${shellQuote(target)} ]; then echo dir; elif [ -f ${shellQuote(target)} ]; then echo file; else echo other; fi`
        const kind = yield* sandbox.runInSession(root.id, kindCmd, { timeoutSeconds: 10 }).pipe(
          Effect.mapError(() => HttpServerResponse.jsonUnsafe({ error: "sandbox unavailable" }, { status: 502 })),
        )
        const isDir = kind.logs.stdout.map((m: any) => m.text).join("").trim() === "dir"

        const downloadName = path.posix.basename(target) || "download"
        const disposition = `attachment; filename="download"; filename*=UTF-8''${encodeDownloadFilename(downloadName)}`
        const logDownload = (detail: Record<string, unknown>) =>
          Effect.promise(() => insertExecLog({
            id: `action-${++execCounter}-${Date.now()}`,
            session_id: root.id,
            command: JSON.stringify({ path: target, ...detail }),
            status: "completed",
            source: "file-download",
            time_started: Date.now(),
            time_finished: Date.now(),
          })).pipe(Effect.catch(() => Effect.void))

        // 文件：流式返回原始字节，Content-Type 用 mime-types 推断
        if (!isDir) {
          const size = typeof info.size === "number" ? info.size : undefined
          yield* logDownload({ type: "file", size })
          const { lookup } = yield* Effect.promise(() => import("mime-types"))
          return HttpServerResponse.stream(
            Stream.fromAsyncIterable(sb.files.readBytesStream(target), (cause) => cause),
            {
              contentType: lookup(downloadName) || "application/octet-stream",
              contentLength: size,
              headers: {
                "Content-Disposition": disposition,
                "X-Content-Type-Options": "nosniff",
              },
            },
          )
        }

        // 目录：沙箱内用 python zipfile 打包为 zip（沙箱必有 python3，不依赖系统 zip/tar），
        // 归档写到 /tmp（overlay，避开 PVC），流式回传后清理。
        const archiveId = `oc-dl-${Date.now()}-${++execCounter}`
        const archivePath = `/tmp/${archiveId}.zip`
        const zipScript = [
          "import base64,zipfile,os,sys",
          "target=base64.b64decode(sys.argv[1]).decode()",
          "out=sys.argv[2]",
          "base=os.path.basename(target.rstrip('/')) or 'download'",
          "count=[0]",
          "with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:",
          "    for root,dirs,files in os.walk(target):",
          "        for f in files:",
          "            p=os.path.join(root,f)",
          "            z.write(p, os.path.join(base, os.path.relpath(p,target)))",
          "            count[0]+=1",
          "        for d in dirs:",
          "            p=os.path.join(root,d)",
          "            z.writestr(zipfile.ZipInfo(os.path.join(base, os.path.relpath(p,target))+'/'), b'')",
          "            count[0]+=1",
          "    if count[0]==0:",
          "        z.writestr(zipfile.ZipInfo(base+'/'), b'')",
          "print(os.path.getsize(out))",
        ].join("\n")
        const zipCmd = `python3 -c "import base64,sys;exec(base64.b64decode('${Buffer.from(zipScript).toString("base64")}').decode())" ${shellQuote(Buffer.from(target).toString("base64"))} ${shellQuote(archivePath)}`
        const pack = yield* sandbox.runInSession(root.id, zipCmd, { timeoutSeconds: 180 }).pipe(
          Effect.mapError(() => HttpServerResponse.jsonUnsafe({ error: "archive failed" }, { status: 502 })),
        )
        if (pack.exitCode !== 0)
          return HttpServerResponse.jsonUnsafe({ error: "archive failed", stderr: pack.logs.stderr.map((m: any) => m.text).join("\n").slice(0, 1024) }, { status: 502 })

        const archiveSize = Number.parseInt(pack.logs.stdout.map((m: any) => m.text).join("").trim(), 10)
        yield* logDownload({ type: "directory", archive: "zip", size: Number.isNaN(archiveSize) ? undefined : archiveSize })

        const cleanup = Effect.promise(() => sb.files.deleteFiles([archivePath]).catch(() => undefined))
        return HttpServerResponse.stream(
          Stream.fromAsyncIterable(sb.files.readBytesStream(archivePath), (cause) => cause).pipe(
            Stream.ensuring(cleanup),
          ),
          {
            contentType: "application/zip",
            contentLength: Number.isNaN(archiveSize) ? undefined : archiveSize,
            headers: {
              "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeDownloadFilename(`${downloadName}.zip`)}`,
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )

    yield* router.add("POST", "/session/:sessionID/files/upload",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(SessionParams)
        const query = yield* HttpServerRequest.schemaSearchParams(FileUploadQuery).pipe(
          Effect.catch(() => Effect.fail(HttpServerResponse.jsonUnsafe({ error: "invalid query" }, { status: 400 }))),
        )
        const filename = query.filename.trim()
        if (!filename || filename.includes("/") || filename.includes("\0") || filename === "." || filename === "..")
          return HttpServerResponse.jsonUnsafe({ error: "filename must be a bare file name" }, { status: 400 })

        const request = yield* HttpServerRequest.HttpServerRequest
        const sourceBody = request.source instanceof Request ? request.source.body : null

        const { root, sb, session } = yield* resolveSandbox(params.sessionID)
        const sandboxPath = toSandboxPath(query.path || "/workspace", session.directory)
        const dir = path.posix.normalize(sandboxPath)
        if (!path.posix.isAbsolute(dir))
          return HttpServerResponse.jsonUnsafe({ error: "path must be absolute" }, { status: 400 })
        const target = `${dir}/${filename}`

        let size = 0
        const t0 = Date.now()
        let data: AsyncGenerator<Uint8Array> | ArrayBuffer
        if (sourceBody) {
          data = (async function* () {
            const reader = sourceBody.getReader()
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                size += value.byteLength
                if (size > MAX_UPLOAD_BYTES) throw new Error(`upload exceeds ${MAX_UPLOAD_BYTES} byte limit`)
                yield value
              }
            } finally {
              reader.releaseLock()
            }
          })()
        } else {
          const buffer = yield* Effect.orDie(request.arrayBuffer)
          if (buffer.byteLength > MAX_UPLOAD_BYTES)
            return HttpServerResponse.jsonUnsafe({ error: `upload exceeds ${MAX_UPLOAD_BYTES} byte limit` }, { status: 413 })
          size = buffer.byteLength
          data = buffer
        }

        yield* Effect.tryPromise({
          try: () =>
            sb.files
              .createDirectories([{ path: dir, mode: 755 }])
              .then(() => sb.files.writeFiles([{ path: target, data, mode: 644 }])),
          catch: (e) => new Error(`upload failed: ${e instanceof Error ? e.message : String(e)}`),
        }).pipe(
          Effect.mapError((error) =>
            error.message.startsWith("upload exceeds")
              ? HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 413 })
              : HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 502 }),
          ),
        )

        yield* Effect.promise(() => insertExecLog({
          id: `action-${++execCounter}-${Date.now()}`,
          session_id: root.id,
          command: JSON.stringify({ path: target, size, filename }),
          status: "completed",
          source: "file-upload",
          time_started: t0,
          time_finished: Date.now(),
        })).pipe(Effect.catch(() => Effect.void))

        return HttpServerResponse.jsonUnsafe({ sessionID: params.sessionID, path: target, filename, size })
      }),
    )


    yield* router.add("POST", "/session/:sessionID/files/remove",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(SessionParams)
        const query = yield* HttpServerRequest.schemaSearchParams(FilePathQuery).pipe(
          Effect.catch(() => Effect.fail(HttpServerResponse.jsonUnsafe({ error: "invalid query" }, { status: 400 }))),
        )
        const { root, sb, session } = yield* resolveSandbox(params.sessionID)
        const sandboxPath = toSandboxPath(query.path, session.directory)
        const target = path.posix.normalize(sandboxPath)
        if (!path.posix.isAbsolute(target))
          return HttpServerResponse.jsonUnsafe({ error: "path must be absolute" }, { status: 400 })

        const info = yield* Effect.tryPromise({
          try: async () => (await sb.files.getFileInfo([target]))[target],
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined))
        if (!info) return HttpServerResponse.jsonUnsafe({ error: `path not found: ${target}` }, { status: 404 })

        const kindCmd = `if [ -d ${shellQuote(target)} ]; then echo dir; elif [ -f ${shellQuote(target)} ]; then echo file; else echo other; fi`
        const kind = yield* sandbox.runInSession(root.id, kindCmd, { timeoutSeconds: 10 }).pipe(
          Effect.mapError(() => HttpServerResponse.jsonUnsafe({ error: "sandbox unavailable" }, { status: 502 })),
        )
        const isDir = kind.logs.stdout.map((m: any) => m.text).join("").trim() === "dir"

        yield* Effect.tryPromise({
          try: () => isDir ? sb.files.deleteDirectories([target]) : sb.files.deleteFiles([target]),
          catch: (e) => new Error(`remove failed: ${e instanceof Error ? e.message : String(e)}`),
        }).pipe(
          Effect.mapError((error) => HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 502 })),
        )

        yield* Effect.promise(() => insertExecLog({
          id: `action-${++execCounter}-${Date.now()}`,
          session_id: root.id,
          command: JSON.stringify({ path: target, type: isDir ? "directory" : "file" }),
          status: "completed",
          source: "file-remove",
          time_started: Date.now(),
          time_finished: Date.now(),
        })).pipe(Effect.catch(() => Effect.void))

        return HttpServerResponse.jsonUnsafe({ sessionID: params.sessionID, path: target, removed: true, type: isDir ? "directory" : "file" })
      }),
    )


    yield* router.add("*", "/session/:sessionID/proxy/:port/*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const isWs = request.headers["upgrade"]?.toLowerCase() === "websocket"
        const params = yield* HttpRouter.schemaPathParams(PathParams)
        const port = parsePort(params.port)
        if (!port) return HttpServerResponse.jsonUnsafe({ error: "invalid port" }, { status: 400 })
        const prefix = `/session/${params.sessionID}/proxy/${port}`
        const subPath = extractSubPath(request.url ?? "", prefix)

        const sb = yield* sandbox.get(params.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!sb) {
          if (isWs) { yield* rejectWs(request, 1011, "sandbox unreachable"); return HttpServerResponse.empty() }
          return HttpServerResponse.jsonUnsafe({ error: "sandbox unreachable" }, { status: 502 })
        }

        const endpoint = yield* Effect.tryPromise({
          try: async () => {
            const ep = await (sb as any).sandboxes.getSandboxEndpoint(sb.id, port, Flag.OPENCODE_SANDBOX_USE_SERVER_PROXY)
            return `http://${ep.endpoint}`
          },
          catch: () => undefined,
        })
        if (!endpoint) {
          if (isWs) { yield* rejectWs(request, 1011, "sandbox unreachable"); return HttpServerResponse.empty() }
          return HttpServerResponse.jsonUnsafe({ error: "sandbox unreachable" }, { status: 502 })
        }

        if (isWs) {
          const targetQuery = request.url ? (() => { try { return new URL(request.url, "http://localhost").search } catch { return "" } })() : ""
          return yield* websocket(request, endpoint + subPath + targetQuery)
        }

        return yield* proxyHttp(request, params.sessionID, port, prefix, subPath, endpoint)
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 502 })))),
    )
  }),
).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))

function rejectWs(request: HttpServerRequest.HttpServerRequest, code: number, reason: string) {
  return Effect.gen(function* () {
    const inbound = yield* Effect.orDie(request.upgrade)
    const write = yield* inbound.writer
    yield* write(new Socket.CloseEvent(code, reason)).pipe(Effect.catch(() => Effect.void))
  })
}

function proxyHttp(
  request: HttpServerRequest.HttpServerRequest,
  sessionID: string,
  port: number,
  prefix: string,
  subPath: string,
  endpoint: string,
) {
  return Effect.gen(function* () {
    const target = new URL(endpoint + subPath)
    if (request.url) {
      try { target.search = new URL(request.url, "http://localhost").search } catch {}
    }

    const outHeaders = new Headers()
    for (const key of Object.keys(request.headers)) {
      if (!["host", "connection", "accept-encoding"].includes(key.toLowerCase())) {
        outHeaders.set(key, request.headers[key] as string)
      }
    }
    outHeaders.set("Accept-Encoding", "identity")

    const sourceBody = request.source instanceof Request ? request.source.body : null
    const reqBody = ["GET", "HEAD"].includes(request.method) ? undefined : sourceBody

    const res = yield* Effect.tryPromise({
      try: () => fetch(target.toString(), { method: request.method, headers: outHeaders, body: reqBody, redirect: "manual" }),
      catch: (e) => e,
    }).pipe(Effect.catch(() => Effect.succeed(null)))

    if (!res || res instanceof Error) {
      return HttpServerResponse.jsonUnsafe({
        error: "sandbox unreachable",
        detail: res instanceof Error ? res.message : undefined,
      }, { status: 502 })
    }

    const resHeaders = new Headers(res.headers)
    // hop-by-hop 头在 HTTP/2 响应中违规（RFC 9113 8.2.2，浏览器报 ERR_HTTP2_PROTOCOL_ERROR）；
    // date/server 由本层 server 生成，透传会产生重复头
    for (const h of ["transfer-encoding", "connection", "keep-alive", "proxy-connection", "upgrade", "te", "trailer", "date", "server", "content-encoding"]) {
      resHeaders.delete(h)
    }
    // 预览页面常被平台前端跨域 iframe 嵌入：显式放行跨域资源与嵌入
    // （允许嵌入的正确方式是不发送 X-Frame-Options，ALLOWALL 等值非标准且部分浏览器按 DENY 处理）
    for (const h of ["x-frame-options", "cross-origin-resource-policy", "cross-origin-embedder-policy"]) {
      resHeaders.delete(h)
    }
    resHeaders.set("access-control-allow-origin", "*")
    resHeaders.set("cross-origin-resource-policy", "cross-origin")

    const location = resHeaders.get("location")
    if (location) {
      if (location.startsWith("/")) resHeaders.set("location", prefix + location)
      else if (location.startsWith(endpoint)) resHeaders.set("location", prefix + location.slice(endpoint.length))
    }

    const contentType = resHeaders.get("content-type") ?? ""

    if (contentType.includes("text/html")) {
      const text = yield* Effect.tryPromise(() => res.text())
      const rewritten = text.length > MAX_BODY ? text : rewriteHtml(prefix, text)
      if (res.status >= 400) {
        push(sessionID, port, [{
          type: "network", message: `HTTP ${res.status} ${res.statusText} for ${subPath}`,
          url: subPath, timestamp: Date.now(),
        }])
      }
      return HttpServerResponse.text(rewritten, {
        status: res.status, statusText: res.statusText || undefined,
        headers: headersToRecord(resHeaders),
      })
    }

    const isJs = /(?:javascript|ecmascript|text\/jsx|text\/tsx)/.test(contentType) ||
      /\.(?:m?js|mjsx|ts|tsx)(?:\?|$)/.test(target.pathname)
    if (isJs) {
      const text = yield* Effect.tryPromise(() => res.text())
      const isViteClient = subPath === "/@vite/client" || target.pathname.endsWith("/@vite/client")
      if (isViteClient) resHeaders.set("cache-control", "no-cache")
      const rewritten = text.length > MAX_BODY ? text : rewriteJs(prefix, text, isViteClient)
      return HttpServerResponse.text(rewritten, {
        status: res.status, statusText: res.statusText || undefined,
        headers: headersToRecord(resHeaders),
      })
    }

    const isCss = contentType.includes("text/css") || /\.css(?:\?|$)/.test(target.pathname)
    if (isCss) {
      const text = yield* Effect.tryPromise(() => res.text())
      const rewritten = text.length > MAX_BODY ? text : rewriteCss(prefix, text)
      return HttpServerResponse.text(rewritten, {
        status: res.status, statusText: res.statusText || undefined,
        headers: headersToRecord(resHeaders),
      })
    }

    const body = yield* Effect.tryPromise(() => res.arrayBuffer())
    return HttpServerResponse.uint8Array(new Uint8Array(body), {
      status: res.status, statusText: res.statusText || undefined,
      headers: headersToRecord(resHeaders),
    })
  })
}

export * as SandboxProxy from "./sandbox-proxy"
