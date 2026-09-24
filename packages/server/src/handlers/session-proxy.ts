import { Bus } from "@opencode/core/bus"
import { SandboxConfig } from "@opencode/core/sandbox/config"
import { SandboxPath } from "@opencode/core/sandbox/path"
import { SandboxProvider } from "@opencode/core/sandbox/provider"
import { SandboxProxyRewrite } from "@opencode/core/sandbox/proxy-rewrite"
import { SessionEvent } from "@opencode/schema/session-event"
import type { SessionID } from "@opencode/schema/session-id"
import { InvalidRequestError, SandboxUnreachableError } from "@opencode/protocol/errors"
import { Effect, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Socket } from "effect/unstable/socket"
import { Api } from "../api"

type PortDiagnostics = SandboxProxyRewrite.PortDiagnostics

type ProxyForwardContext = {
  readonly params: { readonly sessionID: SessionID; readonly port: string }
  readonly request: HttpServerRequest.HttpServerRequest
}

type ProxyError = {
  type: "runtime" | "network" | "compile"
  message: string
  url?: string
  line?: number
  col?: number
  stack?: string
  timestamp: number
}

const MAX_ERRORS = 100
const MAX_SESSIONS = 500

// A preview page fans out into many assets; avoid resolving its sandbox
// endpoint for each one. The short TTL still rechecks lifecycle state and
// refreshes the sandbox activity timestamp.
const PROXY_TARGET_TTL_MS = 10_000
const MAX_PROXY_TARGETS = 2_000

const proxyTargets = new Map<string, { endpoint: string; expiresAt: number }>()
const errors = new Map<string, ProxyError[]>()

const proxyTargetKey = (sessionID: string, port: number) => `${sessionID}:${port}`

function getProxyTarget(sessionID: string, port: number) {
  const target = proxyTargets.get(proxyTargetKey(sessionID, port))
  if (!target) return undefined
  if (target.expiresAt > Date.now()) return target
  proxyTargets.delete(proxyTargetKey(sessionID, port))
  return undefined
}

function setProxyTarget(sessionID: string, port: number, target: { endpoint: string }) {
  const key = proxyTargetKey(sessionID, port)
  if (!proxyTargets.has(key) && proxyTargets.size >= MAX_PROXY_TARGETS) {
    const oldest = proxyTargets.keys().next().value
    if (oldest) proxyTargets.delete(oldest)
  }
  proxyTargets.set(key, { ...target, expiresAt: Date.now() + PROXY_TARGET_TTL_MS })
}

function clearProxyTarget(sessionID: string, port: number) {
  proxyTargets.delete(proxyTargetKey(sessionID, port))
}

function pushError(sessionID: string, port: number, items: ProxyError[]) {
  const key = proxyTargetKey(sessionID, port)
  const buffer = errors.get(key) ?? []
  buffer.push(...items)
  if (buffer.length > MAX_ERRORS) buffer.splice(0, buffer.length - MAX_ERRORS)
  errors.set(key, buffer)
  if (errors.size > MAX_SESSIONS) {
    const oldest = errors.keys().next().value
    if (oldest) errors.delete(oldest)
  }
}

// Port diagnostics run inside the sandbox on the 502 path; results cache for a
// few seconds because a page refresh fans out into several failing requests.
// Any failure degrades silently — diagnostics must never slow the 502 further.
const DIAG_CACHE_MS = 5_000
const diagCache = new Map<string, { at: number; data: PortDiagnostics }>()

const diagnosePort = (provider: SandboxProvider.Interface, sessionID: string, port: number) =>
  Effect.gen(function* () {
    const key = proxyTargetKey(sessionID, port)
    const cached = diagCache.get(key)
    if (cached && Date.now() - cached.at < DIAG_CACHE_MS) return cached.data
    const result = yield* provider
      .run({
        sessionID,
        command: SandboxProxyRewrite.diagCommand(port),
        hostWorkdir: SandboxPath.WORKDIR,
        timeoutMs: 8_000,
      })
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!result) return undefined
    const data = SandboxProxyRewrite.parseDiag(result.output)
    diagCache.set(key, { at: Date.now(), data })
    return data
  })

// Preview-down events are throttled per session:port so a failing frontend
// polling or refreshing cannot flood the durable session log.
const PREVIEW_DOWN_THROTTLE_MS = 60_000
const previewDownAt = new Map<string, number>()

const logPreviewDown = (
  bus: Bus.Interface,
  sessionID: SessionID,
  port: number,
  reason: "sandbox-unreachable" | "port-unreachable",
  hint: string,
) =>
  Effect.gen(function* () {
    const key = proxyTargetKey(sessionID, port)
    const now = Date.now()
    if (now - (previewDownAt.get(key) ?? 0) < PREVIEW_DOWN_THROTTLE_MS) return
    previewDownAt.set(key, now)
    if (previewDownAt.size > 1000) {
      for (const [stale, at] of previewDownAt) if (now - at > PREVIEW_DOWN_THROTTLE_MS) previewDownAt.delete(stale)
    }
    yield* bus
      .publish(SessionEvent.Preview.Down, {
        sessionID,
        port,
        reason,
        hint: hint.slice(0, 300),
      })
      .pipe(Effect.catch(() => Effect.void))
  })

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  return record
}

function websocketProtocols(headers: Record<string, string | undefined>) {
  const value = headers["sec-websocket-protocol"]
  if (!value) return []
  return value.split(",").map((item) => item.trim()).filter(Boolean)
}

function websocketTargetURL(target: string) {
  const url = new URL(target)
  if (url.protocol === "http:") url.protocol = "ws:"
  if (url.protocol === "https:") url.protocol = "wss:"
  return url.toString()
}

/**
 * Bridge an inbound browser WebSocket to the sandbox upstream. The outbound
 * side uses the platform WebSocket deliberately: Effect's socket client can
 * hang on the raw-route upgrade path, a lesson inherited from V1.
 */
function bridgeWebSocket(request: HttpServerRequest.HttpServerRequest, target: string) {
  return Effect.gen(function* () {
    const inbound = yield* Effect.orDie(request.upgrade)
    const outbound = yield* Effect.tryPromise({
      try: () =>
        new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(websocketTargetURL(target), websocketProtocols(request.headers))
          socket.binaryType = "arraybuffer"
          socket.onopen = () => resolve(socket)
          socket.onerror = () => reject(new Error("outbound websocket connection failed"))
        }),
      catch: (cause) => new Error(`outbound websocket failed: ${cause instanceof Error ? cause.message : String(cause)}`),
    }).pipe(Effect.orDie)
    const writeInbound = yield* inbound.writer
    outbound.onmessage = (event) => {
      const data = event.data
      if (data instanceof Blob) {
        void data.arrayBuffer().then((value) => Effect.runFork(writeInbound(new Uint8Array(value))))
        return
      }
      Effect.runFork(writeInbound(typeof data === "string" ? data : new Uint8Array(data)))
    }
    outbound.onclose = (event) => {
      Effect.runFork(writeInbound(new Socket.CloseEvent(event.code, event.reason)))
    }
    outbound.onerror = () => {
      Effect.runFork(writeInbound(new Socket.CloseEvent(1011, "proxy error")))
    }
    yield* inbound
      .runRaw((message) => {
        if (message instanceof Socket.CloseEvent) {
          outbound.close(message.code, message.reason)
          return Effect.void
        }
        // The inbound socket hands text frames over as bytes; re-sending them
        // as binary would break text protocols (Vite HMR), so decode to text.
        if (outbound.readyState === WebSocket.OPEN)
          outbound.send(typeof message === "string" ? message : new TextDecoder().decode(message))
        return Effect.void
      })
      .pipe(
        Effect.catch(() => Effect.void),
        Effect.ensuring(Effect.sync(() => outbound.close())),
      )
    return HttpServerResponse.empty()
  })
}

function rejectWebSocket(request: HttpServerRequest.HttpServerRequest, code: number, reason: string) {
  return Effect.gen(function* () {
    const inbound = yield* Effect.orDie(request.upgrade)
    const write = yield* inbound.writer
    yield* write(new Socket.CloseEvent(code, reason)).pipe(Effect.catch(() => Effect.void))
  })
}

function proxyHttp(input: {
  readonly request: HttpServerRequest.HttpServerRequest
  readonly provider: SandboxProvider.Interface
  readonly sessionID: string
  readonly port: number
  readonly prefix: string
  readonly subPath: string
  readonly endpoint: string
}) {
  const { request, provider, sessionID, port, prefix, subPath, endpoint } = input
  return Effect.gen(function* () {
    const target = new URL(endpoint + subPath)
    try {
      target.search = new URL(request.url ?? "/", "http://localhost").search
    } catch {
      // keep the endpoint path as-is when the request URL is unparseable
    }

    const outHeaders = new Headers()
    for (const key of Object.keys(request.headers)) {
      if (!["host", "connection", "accept-encoding"].includes(key.toLowerCase())) {
        outHeaders.set(key, request.headers[key] as string)
      }
    }
    // Identity encoding keeps the rewriting path simple (no decompression).
    outHeaders.set("Accept-Encoding", "identity")
    // Dev previews must never serve from cache: a 304 lets the browser reuse a
    // stale module referencing chunks that no longer exist (Strict MIME error).
    outHeaders.delete("if-none-match")
    outHeaders.delete("if-modified-since")

    // The request body stream is already consumed by the platform layer, so it
    // must be buffered and re-sent; forwarding the stream yields an empty body.
    const reqBody = ["GET", "HEAD"].includes(request.method)
      ? undefined
      : yield* Effect.orDie(request.arrayBuffer)

    const res = yield* Effect.tryPromise({
      try: () => fetch(target.toString(), { method: request.method, headers: outHeaders, body: reqBody, redirect: "manual" }),
      catch: (cause) => cause,
    }).pipe(Effect.catch(() => Effect.succeed(null)))

    if (!res || res instanceof Error) {
      clearProxyTarget(sessionID, port)
      const diagnostics = yield* diagnosePort(provider, sessionID, port)
      const hint = diagnostics ? SandboxProxyRewrite.diagHint(diagnostics, port) : "port has no listener"
      yield* Effect.logWarning("session-proxy: upstream process unreachable", { sessionID, port, hint })
      return HttpServerResponse.jsonUnsafe(
        {
          error: "sandbox process unreachable",
          port,
          ...(diagnostics ? { diagnostics: { ...diagnostics, hint } } : {}),
          ...(res instanceof Error ? { detail: res.message } : {}),
        },
        { status: 502 },
      )
    }

    const resHeaders = new Headers(res.headers)
    // Hop-by-hop headers are illegal in HTTP/2 responses; date/server belong
    // to this server and would arrive duplicated.
    for (const header of [
      "transfer-encoding",
      "connection",
      "keep-alive",
      "proxy-connection",
      "upgrade",
      "te",
      "trailer",
      "date",
      "server",
      "content-encoding",
    ]) {
      resHeaders.delete(header)
    }
    resHeaders.set("cache-control", "no-cache, no-store, must-revalidate")
    resHeaders.delete("etag")
    resHeaders.delete("last-modified")
    resHeaders.delete("expires")
    // Preview pages are commonly iframed cross-origin; the correct way to
    // allow framing is not sending X-Frame-Options at all.
    for (const header of ["x-frame-options", "cross-origin-resource-policy", "cross-origin-embedder-policy"]) {
      resHeaders.delete(header)
    }
    resHeaders.set("access-control-allow-origin", "*")
    resHeaders.set("cross-origin-resource-policy", "cross-origin")

    const location = resHeaders.get("location")
    if (location) {
      if (location.startsWith("/")) resHeaders.set("location", prefix + location)
      else if (location.startsWith(endpoint)) resHeaders.set("location", prefix + location.slice(endpoint.length))
    }

    const contentType = resHeaders.get("content-type") ?? ""
    const responseOptions = { status: res.status, statusText: res.statusText || undefined, headers: headersToRecord(resHeaders) }

    // The server-proxy plane answers a dead upstream with an opaque 5xx JSON;
    // surface port-level diagnostics instead of forwarding the vagueness.
    if (res.status >= 500 && contentType.includes("json")) {
      const text = yield* Effect.tryPromise(() => res.text()).pipe(Effect.catch(() => Effect.succeed("")))
      if (text.includes("Could not connect to the backend sandbox")) {
        clearProxyTarget(sessionID, port)
        const diagnostics = yield* diagnosePort(provider, sessionID, port)
        const hint = diagnostics ? SandboxProxyRewrite.diagHint(diagnostics, port) : "port has no listener"
        yield* Effect.logWarning("session-proxy: upstream process unreachable via server proxy", { sessionID, port, hint })
        return HttpServerResponse.jsonUnsafe(
          {
            error: "sandbox process unreachable",
            port,
            ...(diagnostics ? { diagnostics: { ...diagnostics, hint } } : {}),
            ...(text ? { originalError: text.slice(0, 500) } : {}),
          },
          { status: 502 },
        )
      }
      return HttpServerResponse.text(text, responseOptions)
    }

    if (contentType.includes("text/html")) {
      const text = yield* Effect.orDie(Effect.tryPromise(() => res.text()))
      // 20MB cap: skipping injection on giant pages loses baseroute state, so
      // the threshold only guards against pathological payloads.
      const rewritten = text.length > 20 * 1024 * 1024 ? text : SandboxProxyRewrite.rewriteHtml(prefix, text)
      if (res.status >= 400) {
        pushError(sessionID, port, [
          { type: "network", message: `HTTP ${res.status} ${res.statusText} for ${subPath}`, url: subPath, timestamp: Date.now() },
        ])
      }
      return HttpServerResponse.text(rewritten, responseOptions)
    }

    const isJs =
      /(?:javascript|ecmascript|text\/jsx|text\/tsx)/.test(contentType) || /\.(?:m?js|mjsx|ts|tsx)(?:\?|$)/.test(target.pathname)
    if (isJs) {
      const text = yield* Effect.orDie(Effect.tryPromise(() => res.text()))
      // JS modules rewrite unconditionally: an unwritten import reaches the
      // SaaS root, receives the SPA fallback HTML and fails Strict MIME. The
      // regexes only scan import statements, so size does not matter.
      const isViteClient = subPath === "/@vite/client" || target.pathname.endsWith("/@vite/client")
      const rewritten = SandboxProxyRewrite.rewriteJs(prefix, text, isViteClient)
      return HttpServerResponse.text(rewritten, responseOptions)
    }

    const isCss = contentType.includes("text/css") || /\.css(?:\?|$)/.test(target.pathname)
    if (isCss) {
      const text = yield* Effect.orDie(Effect.tryPromise(() => res.text()))
      const rewritten = text.length > 20 * 1024 * 1024 ? text : SandboxProxyRewrite.rewriteCss(prefix, text)
      return HttpServerResponse.text(rewritten, responseOptions)
    }

    const body = res.body
    if (!body) return HttpServerResponse.empty(responseOptions)
    return HttpServerResponse.stream(
      Stream.fromReadableStream({ evaluate: () => body, onError: () => undefined }).pipe(
        Stream.catchCause(() => Stream.empty),
      ),
      responseOptions,
    )
  })
}

export const SessionProxyHandler = HttpApiBuilder.group(Api, "server.session-proxy", (handlers) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = SandboxConfig.load()

    const resolveProxyTarget = (provider: SandboxProvider.Interface, sessionID: string, port: number) =>
      Effect.gen(function* () {
        const resolution = yield* provider.endpoint(sessionID, port, config.useServerProxy)
        if (resolution._tag !== "resolved") return undefined
        const target = { endpoint: `${config.protocol}://${resolution.endpoint}` }
        setProxyTarget(sessionID, port, target)
        return target
      })

    // The session-location middleware injects the session's sandbox provider,
    // so it is resolved per request like the session-fs routes.
    const proxyHandler = Effect.fn("SessionProxyHandler.forward")(function* (ctx: ProxyForwardContext) {
      const provider = yield* SandboxProvider.Service
      const { sessionID } = ctx.params
      const port = SandboxProxyRewrite.parsePort(ctx.params.port)
      if (!port) return HttpServerResponse.jsonUnsafe({ error: "invalid port" }, { status: 400 })
      const prefix = `/api/session/${sessionID}/proxy/${port}`
      const subPath = SandboxProxyRewrite.extractSubPath(ctx.request.url ?? "", prefix)

      if (subPath === "/__errors") {
        return HttpServerResponse.jsonUnsafe(errors.get(proxyTargetKey(sessionID, port)) ?? [])
      }

      const isWs = ctx.request.headers["upgrade"]?.toLowerCase() === "websocket"
      const proxyTarget = getProxyTarget(sessionID, port) ?? (yield* resolveProxyTarget(provider, sessionID, port))
      if (!proxyTarget) {
        // Hot path: log only, never record events — every asset of a failing
        // page hits this branch and the durable log lives in the endpoint API.
        yield* Effect.logWarning("session-proxy: sandbox unreachable (recycled, starting, or gone)", {
          sessionID,
          port,
          isWs,
        })
        if (isWs) {
          yield* rejectWebSocket(ctx.request, 1011, "sandbox unreachable").pipe(Effect.catch(() => Effect.void))
          return HttpServerResponse.empty()
        }
        return HttpServerResponse.jsonUnsafe({ error: "sandbox unreachable" }, { status: 502 })
      }

      if (isWs) {
        let targetQuery = ""
        try {
          targetQuery = new URL(ctx.request.url ?? "/", "http://localhost").search
        } catch {
          targetQuery = ""
        }
        return yield* bridgeWebSocket(ctx.request, proxyTarget.endpoint + subPath + targetQuery).pipe(
          Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 502 }))),
        )
      }

      return yield* proxyHttp({
        request: ctx.request,
        provider,
        sessionID,
        port,
        prefix,
        subPath,
        endpoint: proxyTarget.endpoint,
      })
    })

    return handlers
      .handleRaw("session.proxy.get", (ctx) => proxyHandler(ctx))
      .handleRaw("session.proxy.post", (ctx) => proxyHandler(ctx))
      .handleRaw("session.proxy.put", (ctx) => proxyHandler(ctx))
      .handleRaw("session.proxy.delete", (ctx) => proxyHandler(ctx))
      .handleRaw("session.proxy.patch", (ctx) => proxyHandler(ctx))
      .handleRaw("session.proxy.head", (ctx) => proxyHandler(ctx))
      .handleRaw("session.proxy.options", (ctx) => proxyHandler(ctx))
      .handle(
        "session.endpoint",
        Effect.fn(function* (ctx) {
          const provider = yield* SandboxProvider.Service
          const port = SandboxProxyRewrite.parsePort(ctx.params.port)
          if (!port) return yield* new InvalidRequestError({ message: `Invalid port: ${ctx.params.port}`, field: "port" })
          const { sessionID } = ctx.params
          const direct = yield* provider.endpoint(sessionID, port, false)
          const viaProxy = yield* provider.endpoint(sessionID, port, true)
          const directUrl = direct._tag === "resolved" ? `${config.protocol}://${direct.endpoint}` : null
          const proxyUrl = viaProxy._tag === "resolved" ? `${config.protocol}://${viaProxy.endpoint}` : null
          const sandboxId =
            direct._tag === "resolved"
              ? direct.sandboxId
              : viaProxy._tag === "resolved"
                ? viaProxy.sandboxId
                : yield* provider.sandboxId(sessionID)
          if (!sandboxId) {
            yield* Effect.logWarning("session-proxy endpoint: sandbox unreachable (recycled, starting, or gone)", {
              sessionID,
              port,
            })
            yield* logPreviewDown(bus, sessionID, port, "sandbox-unreachable", "sandbox unreachable (recycled, starting, or gone)")
            return yield* new SandboxUnreachableError({
              sessionID,
              message: "sandbox unreachable (recycled, starting, or gone)",
            })
          }
          const fallback = `/api/session/${sessionID}/proxy/${port}/`
          const degraded = !directUrl && !proxyUrl
          if (degraded)
            yield* Effect.logWarning("session-proxy endpoint: both resolutions failed; degrading to proxy fallback", {
              sessionID,
              port,
            })
          const mode = ctx.query.mode ?? (directUrl ? "direct" : "proxy")
          const url = mode === "proxy" ? (proxyUrl ?? fallback) : (directUrl ?? proxyUrl ?? fallback)
          // The browser-reachable preview address goes through this server's
          // proxy route; the public host is configurable for fronted deployments.
          const request = yield* HttpServerRequest.HttpServerRequest
          const forwardedHost = request.headers["x-forwarded-host"]
          const publicHost = config.publicDomain ?? (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers.host
          const previewUrl = publicHost ? `${config.protocol}://${publicHost}${fallback}` : null
          return {
            mode,
            url,
            directUrl,
            proxyUrl,
            previewUrl,
            port,
            sandboxId,
            fallback,
            ...(degraded ? { degraded } : {}),
          }
        }),
      )
      .handleRaw("session.proxyErrors", (ctx) =>
        Effect.gen(function* () {
          const result: Record<number, ProxyError[]> = {}
          for (const [key, list] of errors) {
            if (key.startsWith(ctx.params.sessionID + ":")) {
              const port = parseInt(key.split(":")[1] ?? "", 10)
              if (!isNaN(port) && list.length) result[port] = list.slice(-20)
            }
          }
          return HttpServerResponse.jsonUnsafe(result)
        }),
      )
  }),
)
