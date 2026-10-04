import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { persistCreatedSandbox } from "../src/sandbox/create-lease"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("sandbox create persistence compensation", () => {
  it.effect("a CAS miss reuses an already-owned running generation without cleanup", () => Effect.gen(function* () {
    const calls: string[] = []
    expect(yield* persistCreatedSandbox({
      complete: () => Effect.succeed(false), latest: () => Effect.succeed([{ id: "owned", state: "running" }]),
      release: () => Effect.sync(() => { calls.push("release") }),
    }, "session", "owner", {
      id: "owned", kill: async () => { calls.push("kill") }, close: async () => { calls.push("close") },
    })).toBe(true)
    expect(calls).toEqual([])
  }))
  it.effect("a CAS miss with unavailable ownership reconciliation retains the source", () => Effect.gen(function* () {
    const calls: string[] = []
    expect((yield* persistCreatedSandbox({
      complete: () => Effect.succeed(false), latest: () => Effect.fail(new Error("PG unavailable")),
      release: () => Effect.sync(() => { calls.push("release") }),
    }, "session", "owner", {
      id: "owned", kill: async () => { calls.push("kill") }, close: async () => { calls.push("close") },
    }).pipe(Effect.result))._tag).toBe("Failure")
    expect(calls).toEqual([])
  }))
  for (const state of ["snapshotting", "killed", "destroyed"] as const) {
    for (const response of ["lost", "cas-miss"] as const) {
      it.effect(`an owned ${state} generation survives a ${response} persistence result`, () => Effect.gen(function* () {
        const calls: string[] = []
        const result = yield* persistCreatedSandbox({
          complete: () => response === "lost" ? Effect.fail(new Error("reply lost")) : Effect.succeed(false),
          latest: () => Effect.succeed([{ id: "owned", state }]),
          release: () => Effect.sync(() => { calls.push("release") }),
        }, "session", "owner", {
          id: "owned", kill: async () => { calls.push("kill") }, close: async () => { calls.push("close") },
        }).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
        expect(calls).toEqual([])
      }))
    }
  }
  for (const scenario of ["success", "failed", "defect", "committed", "unknown", "read-defect", "takeover", "cleanup-failed"] as const) {
    it.effect(scenario, () => Effect.gen(function* () {
      const calls: string[] = []
      const error = new Error("database unavailable")
      const lease = {
        complete: () => scenario === "success" ? Effect.succeed(true)
          : scenario === "takeover" ? Effect.succeed(false)
            : scenario === "defect" ? Effect.die(error) : Effect.fail(error),
        latest: () => {
          calls.push("read")
          return scenario === "unknown" ? Effect.fail(error)
            : scenario === "read-defect" ? Effect.die(error) : Effect.succeed([
            scenario === "committed" ? { id: "sb", state: "running" }
              : { id: "creating-owner", state: "creating" },
          ])
        },
        release: (sessionID: string, owner: string) => Effect.sync(() => { calls.push(`release:${sessionID}:${owner}`) }),
      }
      const sandbox = {
        id: "sb",
        kill: async () => { calls.push("kill"); if (scenario === "cleanup-failed") throw new Error("kill failed") },
        close: async () => { calls.push("close") },
      }
      const result = yield* persistCreatedSandbox(lease, "session", "owner", sandbox).pipe(Effect.result)
      if (scenario === "success" || scenario === "committed") {
        expect(result._tag).toBe("Success")
        if (result._tag === "Success") expect(result.success).toBe(true)
        expect(calls).toEqual(scenario === "success" ? [] : ["read"])
      } else if (scenario === "unknown" || scenario === "read-defect") {
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure.message).toContain("could not be reconciled; source retained")
        expect(calls).toEqual(["read"])
      } else if (scenario === "cleanup-failed") {
        expect(result._tag).toBe("Failure")
        expect(calls).toEqual(["read", "kill"])
      } else {
        expect(calls).toEqual(["read", "kill", "close", "release:session:owner"])
        if (scenario === "failed" || scenario === "defect") {
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(result.failure).toBe(error)
        } else {
          expect(result._tag).toBe("Success")
          if (result._tag === "Success") expect(result.success).toBe(false)
        }
      }
    }))
  }
})
