import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Shell } from "@/shell/shell"
import { CorsConfig, isAllowedRequestOrigin, type CorsOptions } from "@/server/cors"
import { Pty } from "@opencode-ai/core/pty"
import { PtyProtocol } from "@opencode-ai/core/pty/protocol"
import { PtyID } from "@opencode-ai/core/pty/schema"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { PtyRuntime } from "@opencode-ai/server/pty-runtime"
import {
  PTY_CONNECT_TICKET_QUERY,
  PTY_CONNECT_TOKEN_HEADER,
  PTY_CONNECT_TOKEN_HEADER_VALUE,
} from "@/server/shared/pty-ticket"
import { Effect, Option, Queue, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { InstanceHttpApi } from "../api"
import * as ApiError from "../errors"
import { CursorQuery, PtyConnectApi } from "../groups/pty"
import { WebSocketTracker } from "../websocket-tracker"

function validOrigin(request: HttpServerRequest.HttpServerRequest, opts: CorsOptions | undefined) {
  return isAllowedRequestOrigin(request.headers.origin, request.headers.host, opts)
}

const ticketScope = Effect.gen(function* () {
  const instance = yield* InstanceRef
  const workspaceID = yield* WorkspaceRef
  return { directory: instance?.directory, workspaceID }
})

const notFound = (error: Pty.NotFoundError) =>
  new ApiError.PtyNotFoundError({
    ptyID: error.ptyID,
    message: `PTY session not found: ${error.ptyID}`,
  })

export const ptyHandlers = HttpApiBuilder.group(InstanceHttpApi, "pty", (handlers) =>
  Effect.gen(function* () {
    const pty = yield* PtyRuntime.Service
    const tickets = yield* PtyTicket.Service
    const cors = yield* CorsConfig

    return handlers
      .handle("shells", () => Effect.promise(() => Shell.list()))
      .handle("list", (ctx) => pty.list(ctx.query.sessionID ?? ""))
      .handle("create", (ctx) =>
        pty.create(ctx.query.sessionID ?? "", {
          ...ctx.payload,
          args: ctx.payload.args ? [...ctx.payload.args] : undefined,
          env: ctx.payload.env ? { ...ctx.payload.env } : undefined,
        }),
      )
      .handle("get", (ctx) => pty.get(ctx.query.sessionID ?? "", ctx.params.ptyID).pipe(Effect.catchTag("Pty.NotFoundError", notFound)))
      .handle("update", (ctx) =>
        pty
          .update(ctx.query.sessionID ?? "", ctx.params.ptyID, {
            ...ctx.payload,
            size: ctx.payload.size ? { ...ctx.payload.size } : undefined,
          })
          .pipe(Effect.catchTag("Pty.NotFoundError", notFound)),
      )
      .handle("remove", (ctx) =>
        pty
          .remove(ctx.query.sessionID ?? "", ctx.params.ptyID)
          .pipe(Effect.catchTag("Pty.NotFoundError", notFound), Effect.as(true)),
      )
      .handle("connectToken", (ctx) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (
            request.headers[PTY_CONNECT_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE ||
            !validOrigin(request, cors)
          )
            return yield* new ApiError.PtyForbiddenError({ message: "Invalid PTY connect token request" })
          const sessionID = ctx.query.sessionID ?? ""
          yield* pty
            .get(sessionID, ctx.params.ptyID)
            .pipe(Effect.catchTag("Pty.NotFoundError", notFound))
          return yield* tickets.issue({
            ptyID: ctx.params.ptyID,
            sessionID,
            ...(yield* ticketScope),
          })
        }),
      )
  }),
)

export const ptyConnectHandlers = HttpApiBuilder.group(PtyConnectApi, "pty-connect", (handlers) =>
  Effect.gen(function* () {
    const pty = yield* PtyRuntime.Service
    const tickets = yield* PtyTicket.Service
    const cors = yield* CorsConfig

    return handlers.handleRaw(
      "connect",
      Effect.fn("PtyHttpApi.connect")(function* (ctx: {
        params: { ptyID: PtyID }
        request: HttpServerRequest.HttpServerRequest
      }) {
        const sessionID = new URL(ctx.request.url, "http://localhost").searchParams.get("sessionID") ?? ""
        const ticket = new URL(ctx.request.url, "http://localhost").searchParams.get(PTY_CONNECT_TICKET_QUERY)
        if (pty.requiresSession && !sessionID) return HttpServerResponse.empty({ status: 400 })
        if (pty.requiresTicket && !ticket) return HttpServerResponse.empty({ status: 403 })
        if (ticket) {
          const valid = validOrigin(ctx.request, cors)
            ? yield* tickets.consume({
                ticket,
                ptyID: ctx.params.ptyID,
                sessionID,
                ...(yield* ticketScope),
              })
            : false
          if (!valid) return HttpServerResponse.empty({ status: 403 })
        }
        const exists = yield* pty.get(sessionID, ctx.params.ptyID).pipe(
          Effect.as(true),
          Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(false)),
        )
        if (!exists) return HttpServerResponse.empty({ status: 404 })

        const query = Schema.decodeUnknownOption(CursorQuery)(yield* HttpServerRequest.ParsedSearchParams)
        if (Option.isNone(query)) return HttpServerResponse.empty({ status: 400 })
        if ((query.value.sessionID ?? "") !== sessionID) return HttpServerResponse.empty({ status: 400 })

        const parsedCursor = query.value.cursor === undefined ? undefined : Number(query.value.cursor)
        const cursor =
          parsedCursor !== undefined && Number.isSafeInteger(parsedCursor) && parsedCursor >= -1
            ? parsedCursor
            : undefined
        const socket = yield* Effect.orDie(ctx.request.upgrade)
        const write = yield* socket.writer
        const closeAccepted = (event: Socket.CloseEvent) =>
          socket
            .runRaw(() => Effect.void, { onOpen: write(event).pipe(Effect.catch(() => Effect.void)) })
            .pipe(
              Effect.timeout("1 second"),
              Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
              Effect.catch(() => Effect.void),
            )
        const registered = yield* WebSocketTracker.register(write(WebSocketTracker.SERVER_CLOSING_EVENT()))
        if (!registered) {
          yield* closeAccepted(WebSocketTracker.SERVER_CLOSING_EVENT())
          return HttpServerResponse.empty()
        }

        type Outbound = string | Uint8Array | Socket.CloseEvent
        const outbox = yield* Queue.unbounded<{ item: Outbound; size: number }>()
        let queued = 0
        let overflowed = false
        const offer = (item: Outbound) => {
          if (overflowed) return
          const size = typeof item === "string" ? Buffer.byteLength(item) : item instanceof Uint8Array ? item.byteLength : 0
          if (queued + size > 2 * 1024 * 1024) {
            overflowed = true
            Queue.offerUnsafe(outbox, { item: new Socket.CloseEvent(1013, "client too slow"), size: 0 })
            return
          }
          queued += size
          Queue.offerUnsafe(outbox, { item, size })
        }
        const attachment = yield* pty
          .attach(sessionID, ctx.params.ptyID, {
            cursor,
            onData: offer,
            onEnd: () => offer(new Socket.CloseEvent(1000)),
          })
          .pipe(
            Effect.catchTags({
              "Pty.NotFoundError": () =>
                closeAccepted(new Socket.CloseEvent(4404, "session not found")).pipe(Effect.as(undefined)),
              "Pty.ExitedError": () =>
                closeAccepted(new Socket.CloseEvent(4404, "session exited")).pipe(Effect.as(undefined)),
            }),
          )
        if (!attachment) return HttpServerResponse.empty()

        for (const chunk of PtyProtocol.chunks(attachment.replay)) offer(chunk)
        offer(PtyProtocol.metaFrame(attachment.cursor))
        attachment.activate()
        const drain = Effect.gen(function* () {
          while (true) {
              const packet = yield* Queue.take(outbox)
              queued -= packet.size
              yield* write(packet.item)
              if (packet.item instanceof Socket.CloseEvent) return yield* Effect.never
              if ((yield* socket.bufferedAmount) <= 2 * 1024 * 1024) continue
              overflowed = true
              yield* write(new Socket.CloseEvent(1013, "client too slow"))
              return yield* Effect.never
            }
          })
        yield* Effect.race(
          drain,
          socket.runRaw((message) => {
            const decoded = PtyProtocol.decodeInput(message)
            if (decoded !== undefined) attachment.write(decoded)
          }),
        ).pipe(
          Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
          Effect.ensuring(Effect.sync(() => attachment.detach())),
          Effect.orDie,
        )
        return HttpServerResponse.empty()
      }),
    )
  }),
)
