import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
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

export interface EventResponseOptions {
  filter?: (event: EventV2.Payload) => boolean
  /** Terminate the stream (inclusive) after an event matching this predicate, e.g. session.idle for a prompt run. */
  endOn?: (event: { id: string; type: string; properties: unknown }) => boolean
  /** Durable events replayed before the live stream, e.g. the `?after=<seq>` catch-up. */
  prepend?: Stream.Stream<EventV2.Payload>
  /** Live durable events at or below this seq were already delivered via `prepend` and are dropped. */
  liveAfterSeq?: number
}

/** Events without a location are global (or replayed) and pass through; located events must match the instance. */
export const eventVisible =
  (instance: { directory: string; workspaceID?: string | undefined }, filter?: (event: EventV2.Payload) => boolean) =>
  (event: EventV2.Payload) =>
    (filter?.(event) ?? true) &&
    (!event.location || event.location.directory === instance.directory) &&
    (!event.location ||
      event.location.workspaceID === undefined ||
      event.location.workspaceID === instance.workspaceID)

export function eventResponse(events: EventV2.Interface, options?: EventResponseOptions) {
  const filter = options?.filter
  const liveAfterSeq = options?.liveAfterSeq
  const prepend = options?.prepend
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    // Listener registration is eager, so events published after this point cannot
    // be lost while the HTTP body fiber is starting or emitting server.connected.
    const queue = yield* Queue.unbounded<EventV2.Payload>()
    const unsubscribe = yield* events.listen((event) => Effect.sync(() => Queue.offerUnsafe(queue, event)))
    yield* Effect.addFinalizer(() => unsubscribe)
    const stream = Stream.fromQueue(queue).pipe(
      // With a prepend catch-up, live durable events at or below `liveAfterSeq`
      // were already replayed from the store — drop them to avoid duplicates.
      Stream.filter(
        (event) =>
          eventVisible({ directory: instance.directory, workspaceID }, filter)(event) &&
          (liveAfterSeq === undefined || (event.durable?.seq ?? Number.MAX_SAFE_INTEGER) > liveAfterSeq),
      ),
      Stream.map((event) => ({ id: event.id, type: event.type, properties: event.data, seq: event.durable?.seq })),
    )
    const disposed = Stream.callback<{ id: string; type: string; properties: unknown }>((queue) => {
      const listener = (event: {
        directory?: string
        payload: { id?: string; type?: string; properties?: unknown }
      }) => {
        if (event.directory !== instance.directory || event.payload.type !== "server.instance.disposed") return
        Queue.offerUnsafe(queue, {
          id: event.payload.id ?? eventID(),
          type: "server.instance.disposed",
          properties: event.payload.properties ?? {},
        })
      }
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listener)),
        () => Effect.sync(() => GlobalBus.off("event", listener)),
      )
    })
    const endOn = options?.endOn
    const output = stream.pipe(
      Stream.merge(disposed, { haltStrategy: "left" }),
      Stream.takeUntil(
        (event) => event.type === "server.instance.disposed" || (endOn?.(event) ?? false),
      ),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: eventID(), type: "server.heartbeat", properties: {} })),
    )

    yield* Effect.logInfo("event connected")
    const catchUp = prepend
      ? prepend.pipe(Stream.map((event) => ({ id: event.id, type: event.type, properties: event.data, seq: event.durable?.seq })))
      : Stream.empty
    return HttpServerResponse.stream(
      Stream.make({ id: eventID(), type: "server.connected", properties: {} }).pipe(
        Stream.concat(catchUp),
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
    const events = yield* EventV2Bridge.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse(events)
      }),
    )
  }),
)
