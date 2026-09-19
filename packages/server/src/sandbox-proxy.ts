export * as SandboxProxy from "./sandbox-proxy.js"

import { Effect, Exit, Scope } from "effect"
import { HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Session } from "@opencode/core/session"
import { Workspace } from "@opencode/core/workspace"
import { SandboxOpenSandbox } from "@opencode/sandbox/opensandbox"
import { AbsolutePath } from "@opencode/core/schema"
import { SandboxRewrite } from "./sandbox-rewrite.js"

/**
 * Session-scoped sandbox HTTP proxy and endpoint lookup (v1 sandbox-proxy
 * parity, transport only): `/api/session/:id/proxy/:port/*` streams one HTTP
 * exchange with the sandbox's service on that port, and
 * `/api/session/:id/endpoint/:port` resolves the sandbox Pod address for
 * direct browser connections. v1's HTML injection and path rewriting are not
 * ported; responses pass through unmodified.
 */
interface ProxyError {
  readonly type: "runtime" | "network" | "compile"
  readonly message: string
  readonly url?: string
  readonly line?: number
  readonly col?: number
  readonly stack?: string
  readonly timestamp: number
}

const proxyErrors = new Map<string, ProxyError[]>()
const MAX_ERRORS = 100
const MAX_SESSIONS = 500

function pushError(sessionID: string, port: number, items: ReadonlyArray<ProxyError>) {
  const key = `${sessionID}:${port}`
  const buf = proxyErrors.get(key) ?? []
  buf.push(...items)
  if (buf.length > MAX_ERRORS) buf.splice(0, buf.length - MAX_ERRORS)
  proxyErrors.set(key, buf)
  if (proxyErrors.size > MAX_SESSIONS) {
    const oldest = proxyErrors.keys().next().value
    if (oldest) proxyErrors.delete(oldest)
  }
}

function getErrors(sessionID: string, port: number) {
  return proxyErrors.get(`${sessionID}:${port}`) ?? []
}

function sessionErrors(sessionID: string) {
  const result: Record<string, ProxyError[]> = {}
  for (const [key, errs] of proxyErrors) {
    if (key.startsWith(`${sessionID}:`)) result[key.split(":")[1]] = errs
  }
  return result
}

// ── proxy 502 port diagnostics (v1 parity) ──
interface PortDiagnostics {
  readonly portListening: boolean
  readonly oomKillCount: number | null
  readonly lastKilled: string | null
}

const DIAG_CACHE_MS = 5_000
const diagCache = new Map<string, { at: number; data: PortDiagnostics }>()

const DIAG_COMMAND = (port: number) => [
  `printf 'PORT='; curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:${port}/ 2>/dev/null || printf '000'; printf '\n'`,
  `printf 'OOM='; { awk '$1=="oom_kill"{print $2}' /sys/fs/cgroup/memory.events 2>/dev/null || awk '$1=="oom_kill"{print $2}' /sys/fs/cgroup/memory/memory.oom_control 2>/dev/null; } | head -1; printf '\n'`,
  `printf 'KILLED='; dmesg 2>/dev/null | grep -i 'killed process' | tail -1 | cut -c1-200`,
].join("\n")

function parseDiag(out: string): PortDiagnostics {
  const line = (key: string) => out.split("\n").find((l) => l.startsWith(key + "="))?.slice(key.length + 1) ?? ""
  const port = line("PORT").trim()
  const oom = line("OOM").trim()
  return {
    portListening: port !== "" && !port.startsWith("000"),
    oomKillCount: /^\d+$/.test(oom) ? Number(oom) : null,
    lastKilled: line("KILLED").trim() || null,
  }
}

function diagHint(d: PortDiagnostics, port: number) {
  if ((d.oomKillCount !== null && d.oomKillCount > 0) || d.lastKilled)
    return `port ${port} has no listener; sandbox memory OOM detected${d.oomKillCount ? ` (cgroup oom_kill=${d.oomKillCount})` : ""}. Increase the sandbox memory limit or restart the process.`
  return `port ${port} has no listener; no process is serving it. Start the dev server and check its output.`
}

export const handler = (services: { readonly sessions: Session.Interface; readonly workspace: Workspace.Interface }) => {
  const { sessions, workspace } = services

  const context = Effect.fn("server.sandbox-proxy.context")(function* (sessionID: string) {
    const info = yield* sessions.get(Session.ID.make(sessionID))
    const workspaceID = info.location.workspaceID
    if (workspaceID === undefined) return yield* Effect.fail({ status: 502, body: { error: "sandbox unreachable" } })
    const row = yield* workspace.rawBinding(workspaceID)
    if (row === null) return yield* Effect.fail({ status: 502, body: { error: "sandbox unreachable" } })
    const sandboxId = row.sandboxId
    if (typeof sandboxId !== "string") return yield* Effect.fail({ status: 502, body: { error: "sandbox unreachable" } })
    return { workspaceID, sandboxId, directory: info.location.directory }
  })

  const handle = (effect: Effect.Effect<HttpServerResponse.HttpServerResponse, { readonly status: number; readonly body: { readonly error: string } } | Error>) =>
    effect.pipe(
      Effect.catchIf(
        (error): error is { readonly status: number; readonly body: { readonly error: string } } =>
          typeof error === "object" && error !== null && "status" in error && "body" in error,
        (error) => Effect.succeed(HttpServerResponse.jsonUnsafe(error.body, { status: error.status })),
      ),
      Effect.catchCause(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "sandbox proxy failed" }, { status: 502 }))),
    )

  const pipeline = (api: App) =>
    api.pipe(
      Effect.catchIf(isRouteNotFound, () =>
        HttpServerRequest.HttpServerRequest.pipe(
          Effect.flatMap((request) => {
            const url = new URL(request.url, "http://localhost")
            // Error reporting routes must be checked before the generic proxy
            // wildcard (which would otherwise proxy /__errors to the sandbox).
            const perPort = /^\/api\/session\/(ses_[A-Za-z0-9]+)\/proxy\/(\d{1,5})\/__errors$/.exec(url.pathname)
            if (perPort !== null && request.method === "GET")
              return Effect.succeed(HttpServerResponse.jsonUnsafe(getErrors(perPort[1], Number(perPort[2]))))
            if (perPort !== null && request.method === "POST")
              return Effect.gen(function* () {
                const raw = new TextDecoder().decode(yield* request.arrayBuffer)
                let items: ReadonlyArray<ProxyError> = []
                try {
                  const parsed: unknown = JSON.parse(raw)
                  if (Array.isArray(parsed)) items = parsed as ReadonlyArray<ProxyError>
                } catch {
                  // Malformed body: accept nothing.
                }
                pushError(perPort[1], Number(perPort[2]), items)
                return HttpServerResponse.jsonUnsafe({ accepted: items.length })
              })
            const allErrors = /^\/api\/session\/(ses_[A-Za-z0-9]+)\/proxy-errors$/.exec(url.pathname)
            if (allErrors !== null)
              return Effect.succeed(HttpServerResponse.jsonUnsafe(sessionErrors(allErrors[1])))
            const proxy = /^\/api\/session\/(ses_[A-Za-z0-9]+)\/proxy\/(\d{1,5})(\/.*)?$/.exec(url.pathname)
            if (proxy !== null) return handle(forward(proxy[1], Number(proxy[2]), proxy[3] ?? "/", request))
            const endpoint = /^\/api\/session\/(ses_[A-Za-z0-9]+)\/endpoint\/(\d{1,5})$/.exec(url.pathname)
            if (endpoint !== null) return handle(resolve(Number(endpoint[2]), endpoint[1]))
            return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
          }),
        ),
      ),
    )

  const forward = Effect.fn("server.sandbox-proxy.forward")(function* (
    sessionID: string,
    port: number,
    subPath: string,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    if (port < 1 || port > 65535)
      return HttpServerResponse.jsonUnsafe({ error: "invalid port" }, { status: 400 })
    const ctx = yield* context(sessionID)
    // Resolve the sandbox endpoint (host:port) from the opensandbox manager,
    // then relay the request as a single fetch round-trip.
    const endpoint = yield* SandboxOpenSandbox.resolveEndpoint(ctx.sandboxId, port).pipe(
      Effect.mapError(() => ({ status: 502, body: { error: "sandbox unreachable" } })),
    )
    const target = `http://${endpoint}${subPath}${url_search(request.url)}`
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : yield* request.arrayBuffer
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string" && !["host", "connection", "transfer-encoding"].includes(key)) headers[key] = value
    }
    const upstream = yield* Effect.tryPromise({
      try: () =>
        fetch(target, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body: new Uint8Array(body) }),
          redirect: "manual",
        }),
      catch: () => ({ status: 502 as const, body: { error: "sandbox unreachable" } }),
    })
    if ("error" in upstream && upstream.error !== undefined) {
      return HttpServerResponse.jsonUnsafe({ error: upstream.error }, { status: 502 })
    }
    const resp = upstream as Response
    const respHeaders: Record<string, string> = {}
    resp.headers.forEach((value, key) => {
      if (!["transfer-encoding", "connection", "content-encoding", "content-length"].includes(key)) respHeaders[key] = value
    })
    respHeaders["access-control-allow-origin"] = "*"
    respHeaders["cross-origin-resource-policy"] = "cross-origin"
    const location = respHeaders["location"]
    if (location !== undefined) {
      if (location.startsWith("/")) respHeaders["location"] = `${proxyPrefix(sessionID, port)}${location}`
    }
    // Rewrite HTML/JS/CSS so the sandbox service is fully addressable under the
    // proxy prefix; other content types pass through untouched.
    const contentType = respHeaders["content-type"] ?? ""
    const kind = SandboxRewrite.rewriteKind(contentType, subPath)
    if (kind !== "binary" && resp.status < 500) {
      const text = yield* Effect.promise(() => resp.text())
      const prefix = proxyPrefix(sessionID, port)
      const rewritten =
        kind === "html"
          ? SandboxRewrite.rewriteHtml(prefix, text)
          : kind === "js"
            ? SandboxRewrite.rewriteJs(prefix, text, subPath === "/@vite/client" || subPath.endsWith("/@vite/client"))
            : SandboxRewrite.rewriteCss(prefix, text)
      return HttpServerResponse.raw(new TextEncoder().encode(rewritten), {
        status: resp.status,
        headers: respHeaders,
        contentType,
      })
    }
    if (resp.status >= 502) {
      // v1 parity: when the upstream service is down, collect port diagnostics
      // (listener check + cgroup OOM evidence) to explain the real reason.
      const ctx2 = yield* Effect.exit(context(sessionID))
      if (Exit.isFailure(ctx2)) {
        return HttpServerResponse.jsonUnsafe({ error: "sandbox unreachable" }, { status: 502 })
      }
      const key = `${sessionID}:${port}`
      const cached = diagCache.get(key)
      let diag: PortDiagnostics | undefined
      if (cached !== undefined && Date.now() - cached.at < DIAG_CACHE_MS) diag = cached.data
      else {
        const sampled = yield* workspace.sample(ctx2.value.workspaceID, DIAG_COMMAND(port), 8000)
        if (sampled !== undefined) {
          diag = parseDiag(sampled.stdout)
          diagCache.set(key, { at: Date.now(), data: diag })
        }
      }
      const hint = diag !== undefined ? diagHint(diag, port) : "port has no listener"
      return HttpServerResponse.jsonUnsafe({
        error: "sandbox process unreachable",
        port,
        ...(diag !== undefined ? { diagnostics: { ...diag, hint } } : { hint }),
      }, { status: 502 })
    }
    const respBody = new Uint8Array(yield* Effect.promise(() => resp.arrayBuffer()))
    return HttpServerResponse.raw(respBody, {
      status: resp.status,
      headers: respHeaders,
      contentType,
    })
  })

  const resolve = Effect.fn("server.sandbox-proxy.endpoint")(function* (port: number, sessionID: string) {
    if (port < 1 || port > 65535)
      return HttpServerResponse.jsonUnsafe({ error: "invalid port" }, { status: 400 })
    const ctx = yield* context(sessionID)
    const endpoint = yield* SandboxOpenSandbox.resolveEndpoint(ctx.sandboxId, port).pipe(
      Effect.mapError(() => ({ status: 502, body: { error: "sandbox unreachable" } })),
    )
    return HttpServerResponse.jsonUnsafe({
      mode: "direct",
      url: `http://${endpoint}`,
      port,
      sandboxId: ctx.sandboxId,
      fallback: `/api/session/${sessionID}/proxy/${port}`,
    })
  })

  function proxyPrefix(sessionID: string, port: number) {
    return `/api/session/${sessionID}/proxy/${port}`
  }

  function url_search(url: string) {
    const index = url.indexOf("?")
    return index === -1 ? "" : url.slice(index)
  }

  return (api: App) => pipeline(api)
}

type App = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>

function isRouteNotFound(error: unknown) {
  return error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound"
}
