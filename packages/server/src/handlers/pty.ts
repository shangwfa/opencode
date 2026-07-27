import { Pty } from "@opencode-ai/core/pty"
import { PtyProtocol } from "@opencode-ai/core/pty/protocol"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { Location } from "@opencode-ai/core/location"
import { Effect, Queue } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { Api } from "../api"
import { CorsConfig, isAllowedRequestOrigin } from "../cors"
import { ForbiddenError, PtyNotFoundError } from "@opencode-ai/protocol/errors"
import {
  PTY_CONNECT_TICKET_QUERY,
  PTY_CONNECT_TOKEN_HEADER,
  PTY_CONNECT_TOKEN_HEADER_VALUE,
} from "@opencode-ai/protocol/groups/pty"
import { response } from "../location"
import { PtyRuntime } from "../pty-runtime"

const ticketScope = Effect.gen(function* () {
  const location = yield* Location.Service
  return { directory: location.directory as string, workspaceID: location.workspaceID }
})

export const PtyHandler = HttpApiBuilder.group(Api, "server.pty", (handlers) =>
  Effect.gen(function* () {
    const tickets = yield* PtyTicket.Service
    const cors = yield* CorsConfig
    const pty = yield* PtyRuntime.Service

    return handlers
      .handle(
        "pty.list",
        Effect.fn(function* (ctx) {
           return yield* response(pty.list(ctx.query.sessionID ?? ""))
        }),
      )
      .handle(
        "pty.create",
        Effect.fn(function* (ctx) {
          return yield* response(
             pty.create(ctx.query.sessionID ?? "", {
              ...ctx.payload,
              args: ctx.payload.args ? [...ctx.payload.args] : undefined,
              env: ctx.payload.env ? { ...ctx.payload.env } : undefined,
            }),
          )
        }),
      )
      .handle(
        "pty.get",
        Effect.fn(function* (ctx) {
          return yield* response(
             pty.get(ctx.query.sessionID ?? "", ctx.params.ptyID).pipe(
              Effect.catchTag(
                "Pty.NotFoundError",
                () =>
                  new PtyNotFoundError({
                    ptyID: ctx.params.ptyID,
                    message: `PTY session not found: ${ctx.params.ptyID}`,
                  }),
              ),
            ),
          )
        }),
      )
      .handle(
        "pty.update",
        Effect.fn(function* (ctx) {
          return yield* response(
            pty
               .update(ctx.query.sessionID ?? "", ctx.params.ptyID, {
                ...ctx.payload,
                size: ctx.payload.size ? { ...ctx.payload.size } : undefined,
              })
              .pipe(
                Effect.catchTag(
                  "Pty.NotFoundError",
                  () =>
                    new PtyNotFoundError({
                      ptyID: ctx.params.ptyID,
                      message: `PTY session not found: ${ctx.params.ptyID}`,
                    }),
                ),
              ),
          )
        }),
      )
      .handle(
        "pty.remove",
        Effect.fn(function* (ctx) {
           yield* pty.remove(ctx.query.sessionID ?? "", ctx.params.ptyID).pipe(
            Effect.catchTag(
              "Pty.NotFoundError",
              () =>
                new PtyNotFoundError({
                  ptyID: ctx.params.ptyID,
                  message: `PTY session not found: ${ctx.params.ptyID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "pty.connectToken",
        Effect.fn(function* (ctx) {
          const request = yield* HttpServerRequest.HttpServerRequest
          // The custom header forces a CORS preflight, so cross-origin browser pages cannot
          // mint tickets without passing the server's origin policy.
          if (
            request.headers[PTY_CONNECT_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE ||
            !isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors)
          )
            return yield* new ForbiddenError({ message: "Invalid PTY connect token request" })
           const sessionID = ctx.query.sessionID ?? ""
           yield* pty.get(sessionID, ctx.params.ptyID).pipe(
            Effect.catchTag(
              "Pty.NotFoundError",
              () =>
                new PtyNotFoundError({
                  ptyID: ctx.params.ptyID,
                  message: `PTY session not found: ${ctx.params.ptyID}`,
                }),
            ),
          )
          return yield* response(
             tickets.issue({ ptyID: ctx.params.ptyID, sessionID, ...(yield* ticketScope) }),
          )
        }),
      )
      .handleRaw(
        "pty.connect",
        Effect.fn("PtyHandler.connect")(function* (ctx) {
           const url = new URL(ctx.request.url, "http://localhost")
           const sessionID = url.searchParams.get("sessionID") ?? ""
           const ticket = url.searchParams.get(PTY_CONNECT_TICKET_QUERY)
           if (pty.requiresSession && !sessionID) return HttpServerResponse.empty({ status: 400 })
           if (pty.requiresTicket && !ticket) return HttpServerResponse.empty({ status: 403 })
           if (ticket) {
            const valid = isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors)
              ? yield* tickets.consume({ ticket, ptyID: ctx.params.ptyID, sessionID, ...(yield* ticketScope) })
              : false
            if (!valid) return HttpServerResponse.empty({ status: 403 })
          }
          const exists = yield* pty.get(sessionID, ctx.params.ptyID).pipe(
            Effect.as(true),
            Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(false)),
          )
          if (!exists) return HttpServerResponse.empty({ status: 404 })

          const parsedCursor = url.searchParams.get("cursor")
          const cursorNumber = parsedCursor === null ? undefined : Number(parsedCursor)
          const cursor =
            cursorNumber !== undefined && Number.isSafeInteger(cursorNumber) && cursorNumber >= -1
              ? cursorNumber
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

          // Outbound frames flow through one queue drained by a single writer so replay, live
          // output, and the close frame keep their order.
          // TODO: Integrate graceful-shutdown socket tracking before clients migrate to this route.
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
