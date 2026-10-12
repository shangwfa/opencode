export * as ConnectorEngine from "./engine.js"

import { Context, Effect, Layer } from "effect"

export interface EngineConnection {
  readonly id: string
  readonly engineConnectionName: string
  readonly service: string
  readonly authType: string
}

/** Managed connection detail: base fields plus the live engine status and provider account profile. */
export interface EngineConnectionDetail extends EngineConnection {
  /** Engine lifecycle state: `active` or `reauth_required`. */
  readonly status: string
  readonly profile: {
    readonly accountId: string
    readonly displayName: string
  }
}

export interface EngineRunsPage {
  readonly items: ReadonlyArray<unknown>
  readonly nextCursor?: string
}

export interface EngineFileUpload {
  readonly fileId: string
  readonly downloadUrl: string
  readonly sizeBytes: number
  readonly name: string
  readonly mimeType: string
}

export interface EngineRuntimeToken {
  readonly id: string
  readonly token: string
}

export interface EngineMcpResponse {
  readonly status: number
  readonly body: unknown
}

export class EngineError extends Error {
  override readonly name = "EngineError"
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface Interface {
  readonly createConnection: (input: {
    readonly service: string
    readonly authType: "api_key" | "custom_credential"
    readonly values: Record<string, string>
    readonly alias?: string
  }) => Effect.Effect<EngineConnection, EngineError>
  readonly deleteConnection: (input: {
    readonly service: string
    readonly engineConnectionName: string
  }) => Effect.Effect<void, EngineError>
  /** Creates a runtime token restricted to `allowedConnections` (stable engine connection IDs). */
  readonly createRuntimeToken: (input: {
    readonly name: string
    readonly allowedConnections: readonly string[]
    /** Empty means "deny all proxies" in engine policy; pass ["*"] to grant proxy use. */
    readonly allowedProxies: readonly string[]
  }) => Effect.Effect<EngineRuntimeToken, EngineError>
  readonly revokeRuntimeToken: (id: string) => Effect.Effect<void, EngineError>
  readonly listRuntimeTokens: () => Effect.Effect<ReadonlyArray<{ id: string; name: string }>, EngineError>
  /** Lists every engine-managed connection (id + connectionName + service). */
  readonly listConnections: () => Effect.Effect<ReadonlyArray<EngineConnection>, EngineError>
  /** Stateless JSON MCP transport against the embedded engine; forwards the caller's engine token. */
  readonly handleMcp: (input: {
    readonly authorization: string
    readonly body: unknown
  }) => Effect.Effect<EngineMcpResponse, EngineError>
  /** Runtime-scoped engine call (discovery or action execution) with a caller-supplied token. */
  readonly runtimeCall: (input: {
    readonly token: string
    readonly method: "GET" | "POST"
    readonly path: string
    readonly body?: unknown
    /** Extra request headers, e.g. `idempotency-key` for action retry deduplication. */
    readonly headers?: Record<string, string>
  }) => Effect.Effect<unknown, EngineError>
  /** Starts an OAuth connection request; the user visits the returned authorization URL. */
  readonly startOAuth: (input: {
    readonly service: string
    /** Pre-selected provider authorization options (e.g. workspace choice) forwarded verbatim. */
    readonly authorizationOptionIds?: ReadonlyArray<string>
  }) => Effect.Effect<{ authorizationUrl: string; connectionRequestId: string; expiresAt: string }, EngineError>
  /** Reads one OAuth connection request; a connected request carries the new connection id. */
  readonly connectionRequest: (
    id: string,
  ) => Effect.Effect<{ status: string; appId?: string; errorCode: string | null }, EngineError>
  /** Fetches one managed connection (id, connectionName, service, authType, status, profile). */
  readonly getConnection: (id: string) => Effect.Effect<EngineConnectionDetail, EngineError>
  /** Restarts authorization for an existing connection; the existing complete flow finishes it. */
  readonly reconnect: (
    id: string,
  ) => Effect.Effect<{ authorizationUrl: string; connectionRequestId: string; expiresAt: string }, EngineError>
  /** Lists recent action runs (admin scope). */
  readonly runs: (input: {
    readonly cursor?: string
    readonly limit?: number
  }) => Effect.Effect<EngineRunsPage, EngineError>
  /** Lists connectable providers (the engine's provider directory, admin scope). */
  readonly providers: () => Effect.Effect<ReadonlyArray<unknown>, EngineError>
  /** Service-scoped proxy passthrough with a runtime token; `path` is the relative provider endpoint. */
  readonly proxy: (input: {
    readonly token: string
    readonly service: string
    readonly method: string
    readonly path: string
    readonly query?: Record<string, string>
    readonly headers?: Record<string, string>
    readonly body?: unknown
    readonly connectionId?: string
  }) => Effect.Effect<unknown, EngineError>
  /** Uploads one transit file (admin scope, multipart upload). */
  readonly createFile: (input: {
    readonly name: string
    readonly mimeType?: string
    readonly data: Uint8Array
  }) => Effect.Effect<EngineFileUpload, EngineError>
  /** Downloads one transit file (public upstream route); returns raw bytes plus content type. */
  readonly readFile: (fileId: string) => Effect.Effect<{ readonly contentType: string; readonly data: Uint8Array }, EngineError>
  /** Executes one trigger operation (read/reconcile/receive/resource/options) with a runtime token. */
  readonly triggerExecute: (input: {
    readonly token: string
    readonly service: string
    readonly triggerId: string
    readonly operation: "read" | "reconcile" | "receive" | "resource" | "options"
    readonly body: unknown
    readonly connectionId?: string
  }) => Effect.Effect<unknown, EngineError>
  /** Stores the OAuth client configuration for a service (admin scope). */
  readonly putOAuthClient: (input: {
    readonly service: string
    readonly clientId: string
    readonly clientSecret: string
    readonly extra?: Record<string, string>
    readonly requestedScopes?: ReadonlyArray<string>
  }) => Effect.Effect<void, EngineError>
  /** Raw GET passthrough for public OAuth endpoints (callback/completion), preserving redirects. */
  readonly oauthPassthrough: (url: string) =>
    Effect.Effect<{ status: number; location?: string; contentType: string; body: string }, EngineError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ConnectorEngine") {}

/**
 * The engine's MCP endpoint answers Streamable HTTP with an SSE body even for `accept: application/json`;
 * extract the JSON-RPC messages from `data:` lines, falling back to plain JSON.
 */
const parseMcpBody = (contentType: string | null, text: string): unknown => {
  if (!text) return null
  if (contentType?.includes("text/event-stream")) {
    const messages = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .map((data) => JSON.parse(data) as { jsonrpc?: string; id?: unknown } & Record<string, unknown>)
    // Responses carry the request id; notifications do not. Prefer the last response message.
    return messages.findLast((message) => message.id !== undefined) ?? messages.at(-1) ?? null
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export interface Options {
  readonly enabled: boolean
  readonly dataDir: string
  readonly publicOrigin: string
  readonly encryptionKey: string
  readonly adminToken: string
  readonly postgres?: { readonly connectionString: string; readonly poolMax?: number }
}
const noop = (feature: string): Interface =>
  Object.fromEntries(
    [
      "createConnection",
      "deleteConnection",
      "createRuntimeToken",
      "revokeRuntimeToken",
      "listRuntimeTokens",
      "listConnections",
      "handleMcp",
      "runtimeCall",
      "startOAuth",
      "connectionRequest",
      "getConnection",
      "reconnect",
      "runs",
      "providers",
      "proxy",
      "createFile",
      "readFile",
      "triggerExecute",
      "putOAuthClient",
      "oauthPassthrough",
    ].map((method) => [
      method,
      () =>
        Effect.fail(
          new EngineError(
            "engine_disabled",
            `Connector engine is not enabled (${feature}); set OPENCODE_CONNECTOR_ENABLED and required configuration.`,
          ),
        ),
    ]),
  ) as unknown as Interface

/**
 * Live engine backed by the headless open-connector runtime. The runtime is a per-process
 * singleton and is created lazily on first use, then closed with the layer scope.
 */
/**
 * The engine's managed-connection list uses `connectionName` (not `alias`, which only the
 * create/detail responses use) and includes `virtual: true` no_auth placeholders that must
 * never be treated as orphan connections.
 */
export const parseManagedConnections = (body: unknown): ReadonlyArray<EngineConnection> => {
  const rows = (Array.isArray(body) ? body : (body as { data?: unknown[] })?.data) ?? []
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .filter((row) => row["virtual"] !== true)
    .map((row) => ({
      id: String(row["id"] ?? ""),
      engineConnectionName: String(row["connectionName"] ?? row["alias"] ?? ""),
      service: String(row["service"] ?? ""),
      authType: String(row["authType"] ?? "api_key"),
    }))
}

export const layer = (options: Options): Layer.Layer<Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      if (!options.enabled) return Service.of(noop("OPENCODE_CONNECTOR_ENABLED"))
      let acquire: Promise<{ fetch(request: Request): Promise<Response>; close(): Promise<void> }> | undefined
      // Per-boot static runtime token: the engine leaves /mcp unauthenticated while the stored
      // token table is empty (session cleanup can empty it), so a secret nobody holds closes that
      // hole without affecting per-session stored tokens.
      const bootRuntimeToken = `oct_boot_${crypto.randomUUID().replaceAll("-", "")}`
      const runtime = () => {
        // Lazy so the engine graph (catalog, providers, hono app) stays out of the default startup
        // path. The relative specifier resolves to the vendored engine source under src/engine/,
        // keeping the engine graph out of consumer programs.
        acquire ??= import("../engine/server/connector-runtime.js").then((module) =>
          module.createConnectorRuntime({
            dataDir: options.dataDir,
            publicOrigin: options.publicOrigin,
            encryptionKey: options.encryptionKey,
            adminToken: options.adminToken,
            runtimeToken: bootRuntimeToken,
            postgres: options.postgres,
          }),
        )
        return acquire
      }
      const base = options.publicOrigin.replace(/\/+$/, "")

      const call = (method: string, path: string, body?: unknown, token?: string, headers?: Record<string, string>) =>
        Effect.tryPromise({
          try: async () => {
            const engine = await runtime()
            const response = await engine.fetch(
              new Request(`${base}${path}`, {
                method,
                headers: {
                  authorization: `Bearer ${token ?? options.adminToken}`,
                  ...(body === undefined ? {} : { "content-type": "application/json" }),
                  ...headers,
                },
                body: body === undefined ? undefined : JSON.stringify(body),
              }),
            )
            const text = await response.text()
            const parsed = text ? (JSON.parse(text) as unknown) : undefined
            return { status: response.status, body: parsed }
          },
          catch: (error) => new EngineError("engine_unavailable", error instanceof Error ? error.message : String(error)),
        }).pipe(
          Effect.flatMap(({ status, body }) => {
            if (status >= 400) {
              const failure = body as { message?: string; errorCode?: string } | undefined
              return Effect.fail(
                new EngineError(failure?.errorCode ?? "engine_error", failure?.message ?? `Engine request failed (${status}).`, status),
              )
            }
            return Effect.succeed(body)
          }),
        )

      // Connection/token routes wrap payloads in a {success,data} envelope; token routes return raw JSON.
      const envelope = (body: unknown) => (body as { data?: unknown }).data ?? body

      return Service.of({
        createConnection: (input) => {
          const values = { ...input.values }
          // Connection routes mount under /v1 (connect-server: app.route("/v1", createConnectionRoutes)).
          const path =
            input.authType === "api_key"
              ? `/v1/connections/${encodeURIComponent(input.service)}/connect/api-key`
              : `/v1/connections/${encodeURIComponent(input.service)}/connect/custom-credential`
          const payload =
            input.authType === "api_key"
              ? { apiKey: values["apiKey"] ?? "", extra: Object.fromEntries(Object.entries(values).filter(([key]) => key !== "apiKey")) }
              : { values }
          return call("POST", path, payload).pipe(
            Effect.map((body) => {
              const data = envelope(body) as { id: string; alias?: string; authType?: string }
              return {
                id: data.id,
                engineConnectionName: data.alias ?? "",
                service: input.service,
                authType: data.authType ?? input.authType,
              }
            }),
          )
        },
        deleteConnection: (input) =>
          call("DELETE", `/api/connections/${encodeURIComponent(input.service)}`, {
            connectionName: input.engineConnectionName,
            revoke: true,
          }).pipe(Effect.asVoid),
        createRuntimeToken: (input) =>
          call("POST", "/api/runtime-tokens", {
            name: input.name,
            allowedActions: ["*"],
            blockedActions: [],
            allowedProxies: [...input.allowedProxies],
            allowedConnections: [...input.allowedConnections],
          }).pipe(
            Effect.map((body) => {
              const data = body as { token: string; record: { id: string } }
              return { id: data.record.id, token: data.token }
            }),
          ),
        revokeRuntimeToken: (id) => call("DELETE", `/api/runtime-tokens/${encodeURIComponent(id)}`).pipe(Effect.asVoid),
        listRuntimeTokens: () =>
          call("GET", "/api/runtime-tokens").pipe(
            Effect.map((body) => (envelope(body) as Array<{ id: string; name: string }>).map(({ id, name }) => ({ id, name }))),
          ),
        listConnections: () =>
          call("GET", "/api/connections").pipe(Effect.map((body) => parseManagedConnections(envelope(body) ?? body))),
        handleMcp: (input) =>
          Effect.tryPromise({
            try: async () => {
              const engine = await runtime()
              const response = await engine.fetch(
                new Request(`${base}/mcp`, {
                  method: "POST",
                  headers: {
                    authorization: input.authorization,
                    "content-type": "application/json",
                    accept: "application/json, text/event-stream",
                  },
                  body: JSON.stringify(input.body),
                }),
              )
              const text = await response.text()
              return { status: response.status, body: parseMcpBody(response.headers.get("content-type"), text) }
            },
            catch: (error) => new EngineError("engine_unavailable", error instanceof Error ? error.message : String(error)),
          }),
        runtimeCall: (input) =>
          call(input.method, input.path, input.body, input.token, input.headers).pipe(Effect.map((body) => envelope(body))),
        startOAuth: (input) =>
          call("POST", `/v1/connections/${encodeURIComponent(input.service)}/connect`, {
            ...(input.authorizationOptionIds ? { authorizationOptionIds: [...input.authorizationOptionIds] } : {}),
          }).pipe(
            Effect.map((body) => {
              const data = envelope(body) as { authorizationUrl: string; connectionRequestId: string; expiresAt: string }
              return {
                authorizationUrl: data.authorizationUrl,
                connectionRequestId: data.connectionRequestId,
                expiresAt: data.expiresAt,
              }
            }),
          ),
        connectionRequest: (id) =>
          call("GET", `/v1/connection-requests/${encodeURIComponent(id)}`).pipe(
            Effect.map((body) => {
              const data = envelope(body) as { status: string; appId?: string; errorCode?: string | null }
              return { status: data.status, appId: data.appId, errorCode: data.errorCode ?? null }
            }),
          ),
        getConnection: (id) =>
          call("GET", `/v1/connections/by-id/${encodeURIComponent(id)}`).pipe(
            Effect.map((body) => {
              const data = envelope(body) as {
                id: string
                alias?: string
                service?: string
                authType?: string
                status?: string
                providerAccountId?: string
                displayName?: string
                accountLabel?: string
              }
              return {
                id: data.id,
                engineConnectionName: data.alias ?? "",
                service: data.service ?? "",
                authType: data.authType ?? "oauth2",
                status: data.status ?? "active",
                profile: {
                  accountId: data.providerAccountId ?? "",
                  displayName: data.displayName ?? data.accountLabel ?? "",
                },
              }
            }),
          ),
        reconnect: (id) =>
          call("POST", `/v1/connections/by-id/${encodeURIComponent(id)}/connect`, {}).pipe(
            Effect.map((body) => {
              const data = envelope(body) as { authorizationUrl: string; connectionRequestId: string; expiresAt: string }
              return {
                authorizationUrl: data.authorizationUrl,
                connectionRequestId: data.connectionRequestId,
                expiresAt: data.expiresAt,
              }
            }),
          ),
        runs: (input) => {
          const query = new URLSearchParams()
          if (input.cursor) query.set("cursor", input.cursor)
          if (input.limit) query.set("limit", String(input.limit))
          return call("GET", `/api/runs?${query.toString()}`).pipe(
            Effect.map((body) => {
              const page = envelope(body) as { items?: ReadonlyArray<unknown>; nextCursor?: string }
              return { items: page.items ?? [], ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
            }),
          )
        },
        // The provider directory answers a bare JSON array (no {success,data} envelope).
        providers: () =>
          call("GET", "/api/providers").pipe(
            Effect.map((body): ReadonlyArray<unknown> => (Array.isArray(body) ? body : [])),
          ),
        proxy: (input) =>
          call(
            "POST",
            `/v1/proxy/${encodeURIComponent(input.service)}`,
            {
              endpoint: input.path,
              method: input.method,
              ...(input.query ? { query: input.query } : {}),
              ...(input.headers ? { headers: input.headers } : {}),
              ...(input.body === undefined ? {} : { body: input.body }),
            },
            input.token,
            input.connectionId ? { "x-oo-connector-app-id": input.connectionId } : undefined,
          ).pipe(Effect.map((body) => envelope(body))),
        createFile: (input) =>
          Effect.tryPromise({
            try: async () => {
              const engine = await runtime()
              // Multipart upload: fetch sets the multipart boundary itself, so no content-type header here.
              const form = new FormData()
              form.append(
                "file",
                new File([new Uint8Array(input.data)], input.name, { type: input.mimeType ?? "application/octet-stream" }),
              )
              const response = await engine.fetch(
                new Request(`${base}/api/files`, {
                  method: "POST",
                  headers: { authorization: `Bearer ${options.adminToken}` },
                  body: form,
                }),
              )
              const text = await response.text()
              const parsed = text ? (JSON.parse(text) as EngineFileUpload) : undefined
              if (!response.ok || !parsed) {
                const failure = parsed as { message?: string; errorCode?: string } | undefined
                throw new EngineError(
                  failure?.errorCode ?? "engine_error",
                  failure?.message ?? `Engine request failed (${response.status}).`,
                )
              }
              return parsed
            },
            catch: (error) =>
              error instanceof EngineError ? error : new EngineError("engine_unavailable", error instanceof Error ? error.message : String(error)),
          }),
        readFile: (fileId) =>
          Effect.tryPromise({
            try: async () => {
              const engine = await runtime()
              const response = await engine.fetch(
                new Request(`${base}/api/files/${encodeURIComponent(fileId)}`, {
                  method: "GET",
                  headers: { authorization: `Bearer ${options.adminToken}` },
                }),
              )
              if (!response.ok) {
                const text = await response.text()
                let failure: { message?: string; errorCode?: string } | undefined
                try {
                  failure = text ? (JSON.parse(text) as { message?: string; errorCode?: string }) : undefined
                } catch {
                  failure = undefined
                }
                throw new EngineError(
                  failure?.errorCode ?? (response.status === 404 ? "file_not_found" : "engine_error"),
                  failure?.message ?? `Engine request failed (${response.status}).`,
                )
              }
              return {
                contentType: response.headers.get("content-type") ?? "application/octet-stream",
                data: new Uint8Array(await response.arrayBuffer()),
              }
            },
            catch: (error) =>
              error instanceof EngineError ? error : new EngineError("engine_unavailable", error instanceof Error ? error.message : String(error)),
          }),
        triggerExecute: (input) =>
          call(
            "POST",
            `/v1/providers/${encodeURIComponent(input.service)}/triggers/${encodeURIComponent(input.triggerId)}/execute`,
            input.body,
            input.token,
            input.connectionId ? { "x-oo-connector-app-id": input.connectionId } : undefined,
          ).pipe(Effect.map((body) => envelope(body))),
        putOAuthClient: (input) =>
          call("PUT", `/api/oauth/configs/${encodeURIComponent(input.service)}`, {
            clientId: input.clientId,
            clientSecret: input.clientSecret,
            ...(input.extra ? { extra: input.extra } : {}),
            ...(input.requestedScopes ? { requestedScopes: [...input.requestedScopes] } : {}),
          }).pipe(Effect.asVoid),
        oauthPassthrough: (url) =>
          Effect.tryPromise({
            try: async () => {
              const engine = await runtime()
              const response = await engine.fetch(new Request(url, { method: "GET" }))
              return {
                status: response.status,
                location: response.headers.get("location") ?? undefined,
                contentType: response.headers.get("content-type") ?? "text/plain",
                body: await response.text(),
              }
            },
            catch: (error) => new EngineError("engine_unavailable", error instanceof Error ? error.message : String(error)),
          }),
      })
    }),
  )
