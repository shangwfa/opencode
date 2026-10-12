import { Connector, ConnectorEngine } from "@opencode/connector/adapter"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { HttpServerResponse } from "effect/unstable/http"
import {
  ConflictError,
  ConnectorNotFoundError,
  InvalidRequestError,
  ServiceUnavailableError,
  UnknownError,
} from "@opencode/protocol/errors"
import { Api } from "../api"

const failure = (error: ConnectorEngine.EngineError | Connector.ConflictError | Connector.NotFoundError) => {
  if (error instanceof Connector.NotFoundError) return new ConnectorNotFoundError({ connectionID: error.connectionID })
  if (error instanceof Connector.ConflictError)
    return error.code === "persist_failed"
      ? new ConflictError({ message: error.message })
      : new InvalidRequestError({ message: error.message })
  return error.code === "engine_disabled" || error.code === "engine_unavailable"
    ? new ServiceUnavailableError({ message: error.message })
    : new InvalidRequestError({ message: error.message })
}

/** Webhook failures answer 500 so the provider redelivers; only an unknown schedule stays a 404. */
const webhookFailure = (error: ConnectorEngine.EngineError | Connector.ConflictError | Connector.NotFoundError) =>
  error instanceof Connector.NotFoundError
    ? new ConnectorNotFoundError({ connectionID: error.connectionID })
    : new UnknownError({ message: error.message })

export const ConnectorHandler = HttpApiBuilder.group(Api, "server.connector", (handlers) =>
  handlers
    .handle(
      "connector.connection.create",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        return yield* connector.associate(ctx.params.sessionID, ctx.payload).pipe(Effect.mapError(failure))
      }),
    )
    .handle(
      "connector.connection.list",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        return { connections: yield* connector.list(ctx.params.sessionID) }
      }),
    )
    .handle(
      "connector.connection.remove",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        yield* connector.remove(ctx.params.sessionID, ctx.params.connectionID).pipe(Effect.mapError(failure))
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle(
      "connector.mcp.attach",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        return yield* connector.attachMcp(ctx.params.sessionID).pipe(Effect.mapError(failure))
      }),
    )
    .handle(
      "connector.mcp.call",
      Effect.fn(function* (ctx) {
        const engine = yield* ConnectorEngine.Service
        const result = yield* engine
          .handleMcp({ authorization: ctx.headers.authorization, body: ctx.payload })
          .pipe(Effect.mapError(failure))
        return { status: result.status, body: result.body as never }
      }),
    )
    .handle(
      "connector.oauth.start",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        return yield* connector
          .startOAuth(ctx.params.sessionID, {
            service: ctx.payload.service,
            alias: ctx.payload.alias,
            authorizationOptionIds: ctx.payload.authorizationOptionIds,
          })
          .pipe(Effect.mapError(failure))
      }),
    )
    .handle(
      "connector.oauth.complete",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        return yield* connector
          .completeOAuth(ctx.params.sessionID, { connectionRequestID: ctx.params.connectionRequestID, alias: ctx.payload.alias })
          .pipe(Effect.mapError(failure))
      }),
    )
    .handle(
      "connector.oauth.client",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        yield* connector
          .configureOAuthClient({ service: ctx.params.service, ...ctx.payload })
          .pipe(Effect.mapError(failure))
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle(
      "connector.connection.reconnect",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        return yield* connector.reconnectOAuth(ctx.params.sessionID, ctx.params.connectionID).pipe(Effect.mapError(failure))
      }),
    )
    .handle(
      "connector.runs",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        const page = yield* connector
          .runs({ cursor: ctx.query.cursor, limit: ctx.query.limit })
          .pipe(Effect.mapError(failure))
        return { items: page.items as never, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }
      }),
    )
    .handle(
      "connector.providers",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        return yield* connector
          .catalog({ service: ctx.query.service, authType: ctx.query.authType })
          .pipe(Effect.mapError(failure))
      }),
    )
    .handle(
      "connector.proxy",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        return (yield* connector
          .proxy(ctx.payload.sessionID, {
            service: ctx.params.service,
            method: ctx.payload.method,
            path: ctx.payload.endpoint,
            ...(ctx.payload.query ? { query: ctx.payload.query } : {}),
            ...(ctx.payload.headers ? { headers: ctx.payload.headers } : {}),
            ...(ctx.payload.body === undefined ? {} : { body: ctx.payload.body }),
            ...(ctx.payload.connectionID ? { connectionID: ctx.payload.connectionID } : {}),
          })
          .pipe(Effect.mapError(failure))) as never
      }),
    )
    .handle(
      "connector.file.upload",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        return yield* connector
          .uploadFile(ctx.payload.sessionID, {
            name: ctx.payload.name,
            ...(ctx.payload.mimeType ? { mimeType: ctx.payload.mimeType } : {}),
            data: Buffer.from(ctx.payload.data, "base64"),
          })
          .pipe(Effect.mapError(failure))
      }),
    )
    .handle(
      "connector.file.download",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        const file = yield* connector.downloadFile(ctx.params.fileID).pipe(
          Effect.mapError((error) =>
            error.code === "file_not_found" ? new ConnectorNotFoundError({ connectionID: ctx.params.fileID, message: "Transit file not found." }) : failure(error),
          ),
        )
        return file.data
      }),
    )
    .handle(
      "connector.trigger.create",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        return yield* connector
          .createTrigger(ctx.params.sessionID, {
            service: ctx.payload.service,
            triggerId: ctx.payload.triggerId,
            ...(ctx.payload.config === undefined ? {} : { config: ctx.payload.config as Record<string, unknown> }),
            ...(ctx.payload.connectionID ? { connectionID: ctx.payload.connectionID } : {}),
          })
          .pipe(Effect.mapError(failure))
      }),
    )
    .handle(
      "connector.trigger.list",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        return { triggers: yield* connector.listTriggers(ctx.params.sessionID) }
      }),
    )
    .handle(
      "connector.trigger.cancel",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        yield* connector.cancelTrigger(ctx.params.sessionID, ctx.params.triggerID).pipe(Effect.mapError(failure))
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle(
      "connector.trigger.webhook",
      Effect.fn(function* (ctx) {
        const connector = yield* Connector.Service
        // Raw body + headers + query forward verbatim; the engine validates nonce/signature.
        const raw = yield* ctx.request.arrayBuffer.pipe(Effect.orDie)
        const url = new URL(ctx.request.url, "http://localhost")
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(ctx.request.headers)) {
          headers[key.toLowerCase()] = value
        }
        const query: Record<string, string> = {}
        url.searchParams.forEach((value, key) => {
          query[key] = value
        })
        const result = (yield* connector
          .handleWebhook(ctx.params.scheduleID, {
            method: ctx.request.method,
            headers,
            query,
            rawBody: Buffer.from(raw).toString("base64"),
          })
          .pipe(Effect.mapError(webhookFailure))) as { result?: { outcome?: string; status?: number; body?: string; contentType?: string } }
        // Provider challenge/status responses pass through unchanged; everything else is a JSON receipt.
        const respond = result?.result
        if (respond?.outcome === "respond") {
          return HttpServerResponse.text(respond.body ?? "", {
            status: respond.status ?? 200,
            ...(respond.contentType ? { headers: { "content-type": respond.contentType } } : {}),
          })
        }
        return HttpServerResponse.jsonUnsafe(result)
      }),
    )
    .handle(
      "connector.reconcile",
      Effect.fn(function* () {
        const connector = yield* Connector.Service
        return yield* connector.reconcileOrphans().pipe(Effect.mapError(failure))
      }),
    )
    .handle(
      "connector.oauth.callback",
      Effect.fn(function* (ctx) {
        const engine = yield* ConnectorEngine.Service
        const result = yield* engine
          .oauthPassthrough(new URL(ctx.request.url, "http://localhost").toString())
          .pipe(Effect.mapError(failure))
        return HttpServerResponse.text(result.body, {
          status: result.status,
          headers: {
            ...(result.location ? { location: result.location } : {}),
            "content-type": result.contentType,
          },
        })
      }),
    ),
)
