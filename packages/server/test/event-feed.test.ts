import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/schema/credential"
import { Event } from "@opencode/schema/event"
import { IntegrationID } from "@opencode/schema/integration-id"
import { SessionEvent } from "@opencode/schema/session-event"
import { Session } from "@opencode/schema/session"
import { Deferred, Effect, Exit, Fiber, Option, Schema, Stream } from "effect"
import { it } from "../../core/test/lib/effect"
import { EventFeed } from "../src/event-feed"

const Internal = Bus.ephemeral({ type: "test.internal", schema: { value: Schema.String } })

const event = (id: string): Event.Payload<typeof Agent.Event.Updated> => ({
  id: Event.ID.make(`evt_${id}`),
  created: Date.now(),
  type: Agent.Event.Updated.type,
  data: {},
})

const internal = (value: string): Event.Payload<typeof Internal> => ({
  id: Event.ID.create(),
  created: Date.now(),
  type: Internal.type,
  data: { value },
})

function makeSource() {
  let subscriber: Bus.Subscriber | undefined
  return {
    observe: (next: Bus.Subscriber) =>
      Effect.sync(() => {
        subscriber = next
        return Effect.sync(() => {
          if (subscriber === next) subscriber = undefined
        })
      }),
    publish: (event: Event.Payload) => Effect.suspend(() => (subscriber ? subscriber(event) : Effect.void)),
  }
}

describe("EventFeed", () => {
  test("preserves the public SSE frame encoding", () => {
    const payload = event("wire")
    expect(EventFeed.frame(payload)).toBe(`data: ${JSON.stringify(payload)}\n\n`)
  })

  it.effect("encodes once and delivers the same frame to every subscriber", () =>
    Effect.gen(function* () {
      let encodes = 0
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        encode: (event) => {
          encodes += 1
          return event.type
        },
      })
      const first = yield* feed.subscribe
      const second = yield* feed.subscribe
      const left = yield* first.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const right = yield* second.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)

      yield* source.publish(event("example"))

      expect([Array.from(yield* Fiber.join(left)), Array.from(yield* Fiber.join(right))]).toEqual([
        [Agent.Event.Updated.type],
        [Agent.Event.Updated.type],
      ])
      expect(encodes).toBe(1)
    }),
  )

  it.effect("fails only the subscriber that exceeds its lag capacity", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        capacity: 1,
        encode: (event) => event.id,
      })
      const slow = yield* feed.subscribe
      const fast = yield* feed.subscribe
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const received = new Array<string>()
      const fastFiber = yield* fast.pipe(
        Stream.take(3),
        Stream.runForEach((frame) =>
          Effect.sync(() => received.push(frame)).pipe(
            Effect.andThen(
              frame === "evt_one"
                ? Deferred.succeed(first, undefined)
                : frame === "evt_two"
                  ? Deferred.succeed(second, undefined)
                  : Effect.void,
            ),
          ),
        ),
        Effect.forkScoped,
      )

      yield* source.publish(event("one"))
      yield* Deferred.await(first)
      yield* source.publish(event("two"))
      yield* Deferred.await(second)
      yield* source.publish(event("three"))

      yield* Fiber.join(fastFiber)

      const result = yield* slow.pipe(Stream.runCollect, Effect.exit)
      expect(received).toEqual(["evt_one", "evt_two", "evt_three"])
      expect(Exit.isFailure(result)).toBeTrue()
      if (Exit.isSuccess(result)) return
      expect(Option.getOrUndefined(Exit.findErrorOption(result))).toBeInstanceOf(EventFeed.SubscriberOverflowError)
    }),
  )

  it.effect("delivers global credential events to public subscribers", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, { encode: (event) => event.type })
      const stream = yield* feed.subscribe
      const received = yield* stream.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)

      yield* source.publish({
        id: Event.ID.create(),
        created: Date.now(),
        type: Credential.Event.Switched.type,
        data: {
          credentialID: Credential.ID.make("cred_test"),
          integrationID: IntegrationID.make("openai"),
        },
      })

      expect(Array.from(yield* Fiber.join(received))).toEqual([Credential.Event.Switched.type])
    }),
  )

  it.effect("filters public events per subscriber without changing the global subscription", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, { encode: (event) => JSON.stringify(event) })
      const sessionID = Session.ID.make("ses_feed_first")
      const first = yield* feed.subscribeFiltered((event) =>
        "sessionID" in event.data && event.data.sessionID === sessionID,
      )
      const global = yield* feed.subscribe
      const firstFiber = yield* first.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const globalFiber = yield* global.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      const renamed = (id: string): Event.Payload<typeof SessionEvent.Renamed> => ({
        id: Event.ID.create(),
        created: Date.now(),
        type: SessionEvent.Renamed.type,
        durable: { aggregateID: id, seq: 0 as Event.Seq, version: 1 as Event.Version },
        data: { sessionID: Session.ID.make(id), title: "updated" },
      })

      yield* source.publish(renamed("ses_feed_other"))
      yield* source.publish(renamed(sessionID))

      const filtered = Array.from(yield* Fiber.join(firstFiber))
      const all = Array.from(yield* Fiber.join(globalFiber))
      expect(JSON.parse(filtered[0]!).data.sessionID).toBe(sessionID)
      expect(all).toHaveLength(2)
    }),
  )

  it.effect("does not encode events that no subscriber accepts", () =>
    Effect.gen(function* () {
      const source = makeSource()
      let encodes = 0
      const feed = yield* EventFeed.make(source.observe, {
        encode: (event) => {
          encodes += 1
          return event.type
        },
      })
      yield* feed.subscribeFiltered(() => false)

      yield* source.publish(event("ignored"))
      expect(encodes).toBe(0)

      const global = yield* feed.subscribe
      const received = yield* global.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* source.publish(event("accepted"))

      expect(Array.from(yield* Fiber.join(received))).toEqual([Agent.Event.Updated.type])
      expect(encodes).toBe(1)
    }),
  )

  it.effect("does not let filtered-out events overflow a filtered subscriber", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, { capacity: 1, encode: (event) => event.id })
      const sessionID = Session.ID.make("ses_feed_target")
      const renamed = (id: string): Event.Payload<typeof SessionEvent.Renamed> => ({
        id: Event.ID.create(),
        created: Date.now(),
        type: SessionEvent.Renamed.type,
        durable: { aggregateID: id, seq: 0 as Event.Seq, version: 1 as Event.Version },
        data: { sessionID: Session.ID.make(id), title: "updated" },
      })
      const filtered = yield* feed.subscribeFiltered(
        (event) => event.type === SessionEvent.Renamed.type && event.data.sessionID === sessionID,
      )
      const received = yield* filtered.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const target = renamed(sessionID)

      yield* source.publish(renamed("ses_feed_a"))
      yield* source.publish(renamed("ses_feed_b"))
      yield* source.publish(renamed("ses_feed_c"))
      yield* source.publish(target)

      const frames = Array.from(yield* Fiber.join(received))
      expect(frames).toEqual([target.id])
    }),
  )

  it.effect("filters internal events before they consume subscriber capacity", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, { capacity: 1, encode: (event) => event.type })
      const stream = yield* feed.subscribe

      yield* source.publish(internal("one"))
      yield* source.publish(internal("two"))
      yield* source.publish(event("public"))

      expect(Array.from(yield* stream.pipe(Stream.take(1), Stream.runCollect))).toEqual([Agent.Event.Updated.type])
    }),
  )

  it.effect("disconnects current subscribers after an encoding failure and continues for later subscribers", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        encode: (event) => {
          if (event.id === Event.ID.make("evt_bad")) throw new Error("invalid event")
          return event.id
        },
      })
      const current = yield* feed.subscribe
      const failed = yield* current.pipe(Stream.runCollect, Effect.exit, Effect.forkScoped)

      yield* source.publish(event("bad"))
      const exit = yield* Fiber.join(failed)

      const next = yield* feed.subscribe
      const received = yield* next.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* source.publish(event("good"))

      expect(Exit.isFailure(exit)).toBeTrue()
      if (Exit.isSuccess(exit)) return
      expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toBeInstanceOf(EventFeed.EncodingError)
      expect(Array.from(yield* Fiber.join(received))).toEqual(["evt_good"])
    }),
  )
})
