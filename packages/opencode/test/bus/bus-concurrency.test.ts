import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Stream, Ref } from "effect"
import z from "zod"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const TestEvent = {
  Ping: BusEvent.define("test.concurrency.ping", z.object({ value: z.number() })),
}

const node = CrossSpawnSpawner.defaultLayer
const live = Layer.mergeAll(Bus.layer, node)
const it = testEffect(live)

describe("Bus concurrency", () => {
  it.live("concurrent subscribe deduplicates PubSub creation", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const received: number[] = []
        const done = yield* Deferred.make<void>()
        const N = 10

        yield* Effect.all(
          Array.from({ length: N }, () =>
            Stream.runForEach(bus.subscribe(TestEvent.Ping), (evt) =>
              Effect.sync(() => {
                received.push(evt.properties.value)
                if (received.length === N) Deferred.doneUnsafe(done, Effect.void)
              }),
            ).pipe(Effect.forkScoped),
          ),
          { concurrency: "unbounded" },
        )

        yield* Effect.sleep("10 millis")
        yield* bus.publish(TestEvent.Ping, { value: 42 })
        yield* Deferred.await(done).pipe(Effect.timeout("2 seconds"))

        expect(received).toEqual(Array(N).fill(42))
      }),
    ),
  )

  it.live("concurrent subscribe and publish does not lose events", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const received: number[] = []
        const done = yield* Deferred.make<void>()
        const N = 5

        yield* Effect.all(
          [
            ...Array.from({ length: N }, () =>
              Stream.runForEach(bus.subscribe(TestEvent.Ping), (evt) =>
                Effect.sync(() => {
                  received.push(evt.properties.value)
                  if (received.length === N * N) Deferred.doneUnsafe(done, Effect.void)
                }),
              ).pipe(Effect.forkScoped),
            ),
            Effect.gen(function* () {
              yield* Effect.sleep("5 millis")
              for (let i = 0; i < N; i++) {
                yield* bus.publish(TestEvent.Ping, { value: i })
                yield* Effect.sleep("5 millis")
              }
            }),
          ],
          { concurrency: "unbounded" },
        )

        yield* Deferred.await(done).pipe(Effect.timeout("2 seconds"))
        const expected = Array.from({ length: N }, (_, i) => i).flatMap((v) => Array(N).fill(v))
        expect(received.sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b))
      }),
    ),
  )

  it.live("no orphaned PubSub when creation completes between check and claim", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const counts = yield* Ref.make(0)
        const done = yield* Deferred.make<void>()
        const N = 20

        yield* Effect.all(
          Array.from({ length: N }, (_, i) =>
            Effect.gen(function* () {
              yield* Effect.sleep(`${i % 3} millis`)
              yield* Stream.runForEach(bus.subscribe(TestEvent.Ping), (evt) =>
                Ref.update(counts, (n) => {
                  const next = n + 1
                  if (next === N) Deferred.doneUnsafe(done, Effect.void)
                  return next
                }),
              ).pipe(Effect.forkScoped)
            }),
          ),
          { concurrency: "unbounded" },
        )

        yield* Effect.sleep("50 millis")
        yield* bus.publish(TestEvent.Ping, { value: 99 })
        yield* Deferred.await(done).pipe(Effect.timeout("3 seconds"))

        const total = yield* Ref.get(counts)
        expect(total).toBe(N)
      }),
    ),
  )
})
