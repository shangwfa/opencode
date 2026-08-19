import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventID() {
  return EventV2.ID.create()
}

function eventResponse() {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    // Stream from the GlobalBus rather than the in-memory EventV2 PubSub:
    // local events are mirrored onto the GlobalBus by EventV2Bridge, and
    // events produced on other pods (shared PG) are injected by the bus-bridge
    // — both reach SSE clients through a single subscription.
    // Register eagerly before server.connected is emitted, otherwise events
    // can be lost while the lazy response body fiber is starting.
    // Bound per-client memory. Under sustained backpressure the oldest events
    // are dropped; clients can resync durable state from the HTTP APIs.
    const queue = yield* Queue.sliding<{ id: string; type: string; properties: unknown }>(1024)
    const listener = (event: GlobalEvent) => {
      if (event.directory !== instance.directory) return
      if (event.workspace !== undefined && event.workspace !== workspaceID) return
      const payload = event.payload as { id?: string; type?: string; properties?: unknown }
      // sync is an internal durable-journal envelope and was not part of the
      // previous instance SSE contract.
      if (payload.type === undefined || payload.type === "sync") return
      Queue.offerUnsafe(queue, {
        id: payload.id ?? eventID(),
        type: payload.type,
        properties: payload.properties ?? {},
      })
    }
    GlobalBus.on("event", listener)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
    const output = Stream.fromQueue(queue).pipe(
      Stream.takeUntil((event) => event.type === "server.instance.disposed"),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: eventID(), type: "server.heartbeat", properties: {} })),
    )

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      Stream.make({ id: eventID(), type: "server.connected", properties: {} }).pipe(
        Stream.concat(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    yield* EventV2Bridge.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse()
      }),
    )
  }),
)
