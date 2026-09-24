import { Session } from "@opencode/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, SandboxUnreachableError } from "../errors.js"

const PROXY_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"] as const
type ProxyMethodName = (typeof PROXY_METHODS)[number]

const METHOD_BY_NAME = {
  get: "GET",
  post: "POST",
  put: "PUT",
  delete: "DELETE",
  patch: "PATCH",
  head: "HEAD",
  options: "OPTIONS",
} as const satisfies Record<ProxyMethodName, "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS">

const ProxyParams = {
  sessionID: Session.ID,
  /** Validated in the handler so an out-of-range port answers 400, not 404. */
  port: Schema.String,
}

const ProxyErrorEntry = Schema.Struct({
  type: Schema.Literals(["runtime", "network", "compile"]),
  message: Schema.String,
  url: Schema.String.pipe(Schema.optional),
  line: Schema.Number.pipe(Schema.optional),
  col: Schema.Number.pipe(Schema.optional),
  stack: Schema.String.pipe(Schema.optional),
  timestamp: Schema.Number,
}).annotate({ identifier: "SessionProxyError" })

/** Dev-server methods forwarded through the session preview proxy. */
function proxyEndpoint<Name extends ProxyMethodName>(name: Name, sessionLocationMiddleware: Context.Key<any, any>) {
  return HttpApiEndpoint.make(METHOD_BY_NAME[name])(`session.proxy.${name}`, "/api/session/:sessionID/proxy/:port/*", {
    params: ProxyParams,
    success: HttpApiSchema.NoContent,
    error: [InvalidRequestError, SandboxUnreachableError],
  })
    .middleware(sessionLocationMiddleware)
    .annotateMerge(
      OpenApi.annotations({
        identifier: `session.proxy.${name}`,
        summary: `Proxy preview request (${METHOD_BY_NAME[name]})`,
        description:
          "Forward one request to a port inside the session sandbox. HTML responses are rewritten to the proxy prefix (runtime fetch/WebSocket/XHR patches plus static rewrites); JS/CSS get import/url rewrites; everything else streams through unchanged. WebSocket upgrades are bridged for HMR.",
      }),
    )
}

const EndpointResponse = Schema.Struct({
  mode: Schema.Literals(["direct", "proxy"]).annotate({
    description: "Resolved access mode; direct when the sandbox address is reachable, otherwise proxy.",
  }),
  url: Schema.String,
  directUrl: Schema.NullOr(Schema.String),
  proxyUrl: Schema.NullOr(Schema.String),
  previewUrl: Schema.NullOr(Schema.String),
  port: Schema.Number,
  sandboxId: Schema.String,
  fallback: Schema.String.annotate({
    description: "SaaS-owned proxy path to use when neither resolved address works.",
  }),
  degraded: Schema.optional(
    Schema.Boolean.annotate({
      description: "Both endpoint resolutions failed; url fell back to the proxy path.",
    }),
  ),
}).annotate({ identifier: "SessionEndpointResponse" })

/**
 * Session preview access: a SaaS-mediated proxy with response rewriting and a
 * direct-endpoint resolver. Every route resolves the session through the
 * session-location middleware (sandbox-scoped services) and never creates a
 * sandbox — an absent sandbox answers 502.
 */
export const makeSessionProxyGroup = <I extends HttpApiMiddleware.AnyId, S>(
  sessionLocationMiddleware: Context.Key<I, S>,
) =>
  HttpApiGroup.make("server.session-proxy")
    .add(
      proxyEndpoint("get", sessionLocationMiddleware),
      proxyEndpoint("post", sessionLocationMiddleware),
      proxyEndpoint("put", sessionLocationMiddleware),
      proxyEndpoint("delete", sessionLocationMiddleware),
      proxyEndpoint("patch", sessionLocationMiddleware),
      proxyEndpoint("head", sessionLocationMiddleware),
      proxyEndpoint("options", sessionLocationMiddleware),
    )
    .add(
      HttpApiEndpoint.get("session.endpoint", "/api/session/:sessionID/endpoint/:port", {
        params: ProxyParams,
        query: {
          mode: Schema.Literals(["direct", "proxy"]).pipe(Schema.optional).annotate({
            description: "Force the access mode instead of preferring direct when available.",
          }),
        },
        success: EndpointResponse,
        error: [InvalidRequestError, SandboxUnreachableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.endpoint",
            summary: "Resolve session preview endpoint",
            description:
              "Resolve the sandbox address for one preview port. Returns the direct address, the server-proxy address, and the SaaS proxy fallback; unreachable sandboxes answer 502 and record a throttled session.preview.down event.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.proxyErrors", "/api/session/:sessionID/proxy-errors", {
        params: { sessionID: Session.ID },
        success: Schema.Record(Schema.NumberFromString, Schema.Array(ProxyErrorEntry)).annotate({
          identifier: "SessionProxyErrorsResponse",
          description: "Recent proxy errors for the session keyed by sandbox port.",
        }),
        error: [],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.proxy.errors",
            summary: "List session proxy errors",
            description: "Recent runtime/network errors the preview proxy collected for the session, grouped by port.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "session preview proxy",
        description: "Session-scoped preview access to dev servers running inside the session sandbox.",
      }),
    )
