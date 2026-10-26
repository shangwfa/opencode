import { describe, expect } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import { ensureSandboxLifetime, reconnectSandbox, requireReadySnapshot, withSnapshotLease } from "../src/sandbox/opensandbox/snapshot/safety"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("snapshot safety", () => {
  for (const state of ["failed", "timeout"] as const) {
    it.effect(`${state} retains dirty writes and the old recovery point on every retry`, () =>
      Effect.gen(function* () {
        const source = { writes: "v2", destroyed: false }
        const oldSnapshot = { id: "s1", writes: "v1", state: "stale" }
        let readyEvents = 0
        for (let attempts = 1; attempts <= 6; attempts++) {
          const result = yield* Effect.gen(function* () {
            yield* requireReadySnapshot(state)
            readyEvents++
            source.destroyed = true
          }).pipe(Effect.result)
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(result.failure.message).toContain("source sandbox retained")
          expect(source).toEqual({ writes: "v2", destroyed: false })
          expect(oldSnapshot).toEqual({ id: "s1", writes: "v1", state: "stale" })
        }
        expect(readyEvents).toBe(0)
      }),
    )
  }

  it.effect("a create or marker error never reaches destroy", () =>
    Effect.gen(function* () {
      const error = new Error("snapshot create failed")
      let destroyed = false
      const result = yield* Effect.gen(function* () {
        const state = yield* Effect.fail(error)
        yield* requireReadySnapshot(state)
        destroyed = true
      }).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure).toBe(error)
      expect(destroyed).toBe(false)
    }),
  )

  it.effect("a Ready checkpoint allows destroy after failed attempts", () =>
    Effect.gen(function* () {
      for (const state of ["failed", "timeout", "ready"] as const) {
        let destroyed = false
        const result = yield* Effect.gen(function* () {
          yield* requireReadySnapshot(state)
          destroyed = true
        }).pipe(Effect.result)
        expect(result._tag).toBe(state === "ready" ? "Success" : "Failure")
        expect(destroyed).toBe(state === "ready")
      }
    }),
  )

  it.effect("renews an absolute expiry before checkpoint work", () =>
    Effect.gen(function* () {
      const renewed: number[] = []
      const sandbox = {
        getInfo: async () => ({ id: "test", status: { state: "Running" }, createdAt: new Date(), expiresAt: new Date(Date.now() + 10_000), metadata: {} }),
        renew: async (seconds: number) => { renewed.push(seconds); return { expiresAt: new Date(Date.now() + seconds * 1000) } },
      }
      yield* ensureSandboxLifetime(sandbox, 600, 1020)
      expect(renewed).toEqual([1080])
    }),
  )

  it.effect("does not renew a sandbox with sufficient remaining lifetime", () =>
    Effect.gen(function* () {
      let renewed = false
      const sandbox = {
        getInfo: async () => ({ id: "test", status: { state: "Running" }, createdAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000), metadata: {} }),
        renew: async () => { renewed = true; return { expiresAt: new Date() } },
      }
      yield* ensureSandboxLifetime(sandbox, 600)
      expect(renewed).toBe(false)
    }),
  )
  it.effect("does not start work without a live lease", () =>
    Effect.gen(function* () {
      let started = false
      const result = yield* withSnapshotLease(
        Effect.succeed(false),
        Effect.sync(() => { started = true }),
      ).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(started).toBe(false)
    }),
  )

  it.live("lease loss interrupts work and runs its finalizer", () =>
    Effect.gen(function* () {
      let renewals = 0
      let stopped = false
      let destroyed = false
      const result = yield* withSnapshotLease(
        Effect.sync(() => ++renewals === 1),
        Effect.sleep(Duration.seconds(1)).pipe(
          Effect.andThen(Effect.sync(() => { destroyed = true })),
          Effect.ensuring(Effect.sync(() => { stopped = true })),
        ),
        Duration.millis(5),
      ).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(stopped).toBe(true)
      expect(destroyed).toBe(false)
    }),
  )

  it.live("a failed renewal also stops work", () =>
    Effect.gen(function* () {
      let renewals = 0
      let stopped = false
      const renew = Effect.suspend(() => ++renewals === 1
        ? Effect.succeed(true)
        : Effect.fail(new Error("database unavailable")))
      const result = yield* withSnapshotLease(
        renew,
        Effect.never.pipe(Effect.ensuring(Effect.sync(() => { stopped = true }))),
        Duration.millis(5),
      ).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(stopped).toBe(true)
    }),
  )

  it.effect("successful work returns without waiting for a heartbeat", () =>
    Effect.gen(function* () {
      expect(yield* withSnapshotLease(Effect.succeed(true), Effect.succeed("ready"))).toBe("ready")
    }),
  )

  it.live("transport failures do not report disappearance", () =>
    Effect.gen(function* () {
      let attempts = 0
      const result = yield* reconnectSandbox(
        Effect.suspend(() => { attempts++; return Effect.fail(new Error("ECONNREFUSED")) }),
        () => false,
        Duration.millis(1),
      ).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(attempts).toBe(3)
    }),
  )

  it.live("a retry joins the same sandbox after transient failure", () =>
    Effect.gen(function* () {
      let attempts = 0
      const connected = yield* reconnectSandbox(
        Effect.suspend(() => ++attempts === 1 ? Effect.fail(new Error("timeout")) : Effect.succeed("original")),
        () => false,
        Duration.millis(1),
      )
      expect(connected).toBe("original")
      expect(attempts).toBe(2)
    }),
  )

  it.effect("only explicit disappearance allows rebuilding", () =>
    Effect.gen(function* () {
      expect(yield* reconnectSandbox(Effect.fail(new Error("404")), (error) => error.message === "404")).toBeNull()
    }),
  )
})
