import { ProxyUtil } from "@/server/proxy-util"
import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { WebSocketTracker } from "../websocket-tracker"

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  if (request.source instanceof Request && request.source.body === null) return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len ? Number(len) : undefined)
}

export function websocket(
  request: HttpServerRequest.HttpServerRequest,
  target: string | URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Socket.WebSocketConstructor> {
  return Effect.scoped(
    Effect.gen(function* () {
      const inbound = yield* Effect.orDie(request.upgrade)
      // Effect 的 Socket.makeWebSocket 在部分 raw route 场景下 outbound 握手不完成，
      // 改用原生 WebSocket 建立上游连接，双向桥接到 Effect inbound socket
      const outbound = yield* Effect.tryPromise({
        try: () => new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(ProxyUtil.websocketTargetURL(target), ProxyUtil.websocketProtocols(request.headers))
          socket.binaryType = "arraybuffer"
          socket.onopen = () => resolve(socket)
          socket.onerror = () => reject(new Error("outbound websocket connection failed"))
        }),
        catch: (error) => error,
      }).pipe(Effect.orDie)
      const writeInbound = yield* inbound.writer
      const registered = yield* WebSocketTracker.register(writeInbound(WebSocketTracker.SERVER_CLOSING_EVENT()))
      if (!registered) {
        outbound.close(1011, "proxy closed")
        return HttpServerResponse.empty()
      }

      outbound.onmessage = (event) => {
        const data = event.data
        if (data instanceof Blob) {
          void data.arrayBuffer().then((value) => Effect.runFork(writeInbound(new Uint8Array(value))))
          return
        }
        Effect.runFork(writeInbound(typeof data === "string" ? data : new Uint8Array(data)))
      }
      outbound.onclose = (event) => Effect.runFork(writeInbound(new Socket.CloseEvent(event.code, event.reason)))
      outbound.onerror = () => Effect.runFork(writeInbound(new Socket.CloseEvent(1011, "proxy error")))

      yield* inbound
        .runRaw((message) => {
          if (message instanceof Socket.CloseEvent) {
            outbound.close(message.code, message.reason)
            return Effect.void
          }
          if (outbound.readyState === WebSocket.OPEN) outbound.send(typeof message === "string" ? message : message.slice())
          return Effect.void
        })
        .pipe(
          Effect.catch(() => Effect.void),
          Effect.ensuring(Effect.sync(() => outbound.close())),
        )
      return HttpServerResponse.empty()
    }).pipe(Effect.orDie),
  )
}

function statusText(response: unknown) {
  return (response as { source?: Response }).source?.statusText
}

export function http(
  client: HttpClient.HttpClient,
  url: string | URL,
  extra: HeadersInit | undefined,
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return Effect.gen(function* () {
    const response = yield* client.execute(
      HttpClientRequest.make(request.method as never)(url, {
        headers: ProxyUtil.headers(request.headers as HeadersInit, extra),
        body: requestBody(request),
      }),
    )
    const headers = new Headers(response.headers as HeadersInit)
    headers.delete("content-encoding")
    headers.delete("content-length")

    // An upstream 5xx from a remote workspace sandbox arrives here as an opaque
    // status — its real cause (and log line) live only inside the sandbox. Buffer
    // the small error body, log it locally so it shows up in the host's log, and
    // forward it unchanged (preserving content-type so the client can still parse
    // the structured error, e.g. its `ref`).
    if (response.status >= 500) {
      const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")))
      const contentType = response.headers["content-type"] ?? "application/json"
      headers.delete("content-type")
      yield* Effect.logError("workspace proxy upstream error", {
        url: url.toString(),
        method: request.method,
        status: response.status,
        body: body.slice(0, 2000),
      })
      return HttpServerResponse.text(body, {
        status: response.status,
        statusText: statusText(response),
        headers,
        contentType,
      })
    }

    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      statusText: statusText(response),
      headers,
    })
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 500 }))))
}

export * as HttpApiProxy from "./proxy"
