import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Semaphore } from "effect"
import {
  CommandSessionUnavailable,
  SandboxFilesTimeoutError,
  SandboxProvider,
  assembleStreamText,
  isCommandSessionGone,
  isSandboxGone,
  remoteSandboxGone,
  resolveSessionImage,
  rootSessionID,
  withCommandSessionRecovery,
  withOperationTimeout,
  withSandboxFilesTimeout,
  withSemaphoreWaitTimeout,
} from "@opencode/core/sandbox/provider"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Global } from "@opencode/util/global"
import { filesystem } from "@opencode/util/effect/app-node-platform"
import { FSUtil } from "@opencode/util/fs-util"
import { testEffect } from "./lib/effect"

// Without OPENCODE_SANDBOX_ENABLED the provider layer builds in disabled mode:
// tools keep their local path and lifecycle helpers stay safe no-ops.
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, FSUtil.node, filesystem, Global.node, SandboxProvider.node])),
)

describe("assembleStreamText", () => {
  // execd emits one stream event per output line with the newline stripped.
  test("restores line structure from per-line events", () => {
    expect(assembleStreamText(["/workspace/a.ts", "/workspace/b.ts", "/workspace/c.ts"])).toBe(
      "/workspace/a.ts\n/workspace/b.ts\n/workspace/c.ts",
    )
  })

  test("keeps a single line without a trailing newline", () => {
    expect(assembleStreamText(["done"])).toBe("done")
    expect(assembleStreamText(["1"])).toBe("1")
  })

  test("returns empty output for no events", () => {
    expect(assembleStreamText([])).toBe("")
  })

  test("never fuses lines into one string", () => {
    const fused = assembleStreamText(["line1", "line2"])
    expect(fused).toContain("\n")
    expect(fused.split("\n")).toEqual(["line1", "line2"])
  })

  test("round-trips through the line-oriented glob parser shape", () => {
    const lines = assembleStreamText(["f1.txt", "f2.txt", "f3.txt"])
      .split("\n")
      .filter((line) => line.length > 0)
    expect(lines).toEqual(["f1.txt", "f2.txt", "f3.txt"])
  })
})

describe("resolveSessionImage", () => {
  const fallback = "registry.example/default-sandbox:latest"

  test("a session image overrides the deployment default", () => {
    expect(resolveSessionImage({ image: "registry.example/java:21" }, fallback)).toBe("registry.example/java:21")
  })

  test("an absent sandbox or image falls back to the deployment default", () => {
    expect(resolveSessionImage(undefined, fallback)).toBe(fallback)
    expect(resolveSessionImage({ cpu: "2", memory: "4Gi" }, fallback)).toBe(fallback)
  })

  // A blank pin must not reach the control plane: OpenSandbox would try to pull
  // an image named "" and fail the create instead of using the default.
  test("a blank or whitespace-only image falls back instead of failing the create", () => {
    expect(resolveSessionImage({ image: "" }, fallback)).toBe(fallback)
    expect(resolveSessionImage({ image: "   " }, fallback)).toBe(fallback)
  })

  test("a pinned image is trimmed", () => {
    expect(resolveSessionImage({ image: "  registry.example/java:21  " }, fallback)).toBe("registry.example/java:21")
  })

  // The sandbox column is untyped JSON read through the PG bridge.
  test("a non-string image is ignored rather than forwarded", () => {
    expect(resolveSessionImage({ image: 42 }, fallback)).toBe(fallback)
    expect(resolveSessionImage({ image: null }, fallback)).toBe(fallback)
    expect(resolveSessionImage({ image: { uri: "x" } }, fallback)).toBe(fallback)
  })
})

describe("SandboxProvider disabled layer", () => {
  it.effect("reports disabled and keeps lifecycle as no-ops", () =>
    Effect.gen(function* () {
      const provider = yield* SandboxProvider.Service
      expect(provider.enabled).toBe(false)
      yield* provider.interrupt("ses_anything")
      yield* provider.destroy("ses_anything")
    }),
  )

  it.effect("refuses remote runs with a defect instead of silently executing locally", () =>
    Effect.gen(function* () {
      const provider = yield* SandboxProvider.Service
      const exit = yield* provider
        .run({ sessionID: "ses_x", command: "echo hi", hostWorkdir: "/workspace", timeoutMs: 1000 })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})

describe("rootSessionID", () => {
  const chain = (parents: Record<string, string | null>) => {
    const seen: string[] = []
    const lookup = (id: string) =>
      Effect.gen(function* () {
        seen.push(id)
        return { parentID: parents[id] ?? null }
      })
    return { lookup, seen }
  }

  it.effect("returns the session itself when it has no parent", () =>
    Effect.gen(function* () {
      const { lookup } = chain({})
      expect(yield* rootSessionID("ses_root", lookup)).toBe("ses_root")
    }),
  )

  it.effect("resolves a subagent child chain to the root session", () =>
    Effect.gen(function* () {
      const { lookup, seen } = chain({ ses_child: "ses_parent", ses_parent: "ses_root" })
      expect(yield* rootSessionID("ses_child", lookup)).toBe("ses_root")
      // Full chain walked once, root lookup confirms the end.
      expect(seen).toEqual(["ses_child", "ses_parent", "ses_root"])
    }),
  )

  it.effect("stops after ten hops even on a cyclic chain", () =>
    Effect.gen(function* () {
      // a -> b -> a ... would loop forever without the hop bound.
      const { lookup } = chain({ ses_a: "ses_b", ses_b: "ses_a" })
      const result = yield* rootSessionID("ses_a", lookup)
      expect(["ses_a", "ses_b"]).toContain(result)
    }),
  )

  it.effect("keeps the current id when the lookup misses the session row", () =>
    Effect.gen(function* () {
      const lookup = () => Effect.succeed(null)
      expect(yield* rootSessionID("ses_ghost", lookup)).toBe("ses_ghost")
    }),
  )
})

describe("SandboxProvider command resilience helpers", () => {
  test("classifies sandbox-gone errors precisely", () => {
    // Sandbox-level disappearance → rebuild and retry is safe.
    expect(isSandboxGone(new Error("Sandbox is no longer running: ses_x/sb_y"))).toBe(true)
    expect(isSandboxGone(new Error("runInSession failed: Execution exec_1 not found on sandbox sb_y"))).toBe(true)
    expect(isSandboxGone(new Error("Failed to create command session: APIError 404"))).toBe(true)
    expect(isSandboxGone(new Error("runDetached failed: sandbox not found"))).toBe(true)
    // Business-level not-found / other errors → never retry (side effects).
    expect(isSandboxGone(new Error("File not found: /workspace/app.py"))).toBe(false)
    expect(isSandboxGone(new Error("command not found: pnpm"))).toBe(false)
    expect(isSandboxGone(new Error("get or create sandbox timed out after 90s"))).toBe(false)
  })

  test("keeps missing command contexts distinct from a missing sandbox", () => {
    expect(isCommandSessionGone(new Error("SandboxApiException: error running in session. context not found"))).toBe(
      true,
    )
    expect(
      isCommandSessionGone(new Error("runInSession failed: command session cmd_1 not found (empty execution stream)")),
    ).toBe(true)
    expect(isCommandSessionGone(new Error("File not found: /workspace/app.py"))).toBe(false)
    expect(isCommandSessionGone(new Error("Sandbox is no longer running: ses_x/sb_y"))).toBe(false)
  })

  describe("remoteSandboxGone", () => {
    // The verdict that lets a delete settle its durable row: the runtime says
    // the sandbox no longer exists, so `running` must not outlive it.
    const apiException = (statusCode: number | undefined, message: string) =>
      Object.assign(new Error(message), { statusCode })

    test("recognizes a wrapped 404 from the reconnect path", () => {
      const wrapped = new Error("Sandbox reconnect failed: SandboxApiException: Sandbox abc not found.", {
        cause: apiException(404, "Sandbox abc not found."),
      })
      expect(remoteSandboxGone(wrapped)).toBe(true)
    })

    test("recognizes an explicit not-found message without a status code", () => {
      expect(remoteSandboxGone(new Error("Sandbox b200f678 not found."))).toBe(true)
    })

    test("treats transport and server failures as no verdict", () => {
      // No status, no not-found message: the sandbox may still exist remotely.
      expect(remoteSandboxGone(new Error("fetch failed"))).toBe(false)
      expect(remoteSandboxGone(apiException(500, "internal error"))).toBe(false)
      expect(remoteSandboxGone(apiException(503, "service unavailable"))).toBe(false)
      const wrappedTransport = new Error("Sandbox reconnect failed: ECONNREFUSED", {
        cause: apiException(undefined, "connect ECONNREFUSED 127.0.0.1:8080"),
      })
      expect(remoteSandboxGone(wrappedTransport)).toBe(false)
    })

    test("ignores unrelated 404-shaped messages that are not about a sandbox", () => {
      expect(remoteSandboxGone(new Error("File not found: /workspace/app.py"))).toBe(false)
    })
  })

  // The replay policy is the safety property: a side-effecting command must never run twice, so
  // only an explicitly declared safe read may be retried after the command context is repaired.
  const replay = (retryPolicy: "safe-read" | undefined, failures: number) => {
    let executes = 0
    let repairs = 0
    let rebuilds = 0
    const execute = () => {
      executes++
      return executes <= failures
        ? Effect.fail(new CommandSessionUnavailable("cmd_1", new Error("context not found")))
        : Effect.succeed(`ok-${executes}`)
    }
    return withCommandSessionRecovery(
      retryPolicy,
      {
        repair: () => Effect.sync(() => void repairs++),
        rebuild: () => Effect.sync(() => void rebuilds++),
      },
      execute,
    ).pipe(
      Effect.exit,
      Effect.map((exit) => ({ exit, executes, repairs, rebuilds })),
    )
  }

  test("repairs a general command's missing context but never replays it", async () => {
    const outcome = await Effect.runPromise(replay(undefined, 1))
    expect(outcome.executes).toBe(1)
    expect(outcome.repairs).toBe(1)
    expect(outcome.rebuilds).toBe(0)
    expect(Exit.isFailure(outcome.exit)).toBe(true)

    // A command that succeeded was never repaired.
    const ok = await Effect.runPromise(replay(undefined, 0))
    expect(ok.executes).toBe(1)
    expect(ok.repairs).toBe(0)
    expect(Exit.isSuccess(ok.exit)).toBe(true)
  })

  test("replays a safe read once after repairing the command context", async () => {
    const outcome = await Effect.runPromise(replay("safe-read", 1))
    expect(outcome.executes).toBe(2)
    expect(outcome.repairs).toBe(1)
    expect(outcome.rebuilds).toBe(0)
    expect(Exit.isSuccess(outcome.exit)).toBe(true)
    if (Exit.isSuccess(outcome.exit)) expect(outcome.exit.value).toBe("ok-2")
  })

  test("rebuilds the sandbox for a safe read only after two fresh contexts fail", async () => {
    const outcome = await Effect.runPromise(replay("safe-read", 2))
    expect(outcome.executes).toBe(3)
    expect(outcome.repairs).toBe(1)
    expect(outcome.rebuilds).toBe(1)
    expect(Exit.isSuccess(outcome.exit)).toBe(true)
    if (Exit.isSuccess(outcome.exit)) expect(outcome.exit.value).toBe("ok-3")

    // A third failure is surfaced; the rebuild budget is not retried forever.
    const exhausted = await Effect.runPromise(replay("safe-read", 3))
    expect(exhausted.executes).toBe(3)
    expect(exhausted.repairs).toBe(1)
    expect(exhausted.rebuilds).toBe(1)
    expect(Exit.isFailure(exhausted.exit)).toBe(true)
  })

  test("does not repair or replay a failure that is not a vanished command context", async () => {
    let repairs = 0
    let executes = 0
    const exit = await Effect.runPromise(
      withCommandSessionRecovery(
        "safe-read",
        { repair: () => Effect.sync(() => void repairs++), rebuild: () => Effect.void },
        () => {
          executes++
          return Effect.fail(new Error("File not found: /workspace/app.py"))
        },
      ).pipe(Effect.exit),
    )
    expect(executes).toBe(1)
    expect(repairs).toBe(0)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it.live("fails an operation that exceeds its budget, naming the operation", () =>
    Effect.gen(function* () {
      const exit = yield* withOperationTimeout(Effect.never, 0.02, "get or create sandbox").pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("get or create sandbox timed out after 0.02s")
      }
    }),
  )

  it.live("returns a completed operation before the timeout", () =>
    Effect.gen(function* () {
      const value = yield* withOperationTimeout(Effect.succeed("ok"), 1, "op")
      expect(value).toBe("ok")
    }),
  )

  // The outer budget is timeoutSeconds + grace, so the permit wait must outlast a
  // permit held for the caller's own exec timeout.
  it.live(
    "times out while waiting for a command semaphore permit",
    () =>
      Effect.gen(function* () {
        const semaphore = yield* Semaphore.make(1)
        const acquired = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const holder = yield* semaphore
          .withPermits(1)(
            Effect.gen(function* () {
              yield* Deferred.succeed(acquired, undefined)
              yield* Deferred.await(release)
            }),
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(acquired)

        const exit = yield* withSemaphoreWaitTimeout(
          semaphore,
          Effect.succeed("ready"),
          0.05,
          "command queue wait",
        ).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("command queue wait timed out after 5.05s")
        }

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holder)
      }),
    15000,
  )
})

describe("SandboxProvider files API timeout", () => {
  it.live("aborts a timed-out request and retries it once", () =>
    Effect.gen(function* () {
      let attempts = 0
      let aborted = 0
      const result = yield* withSandboxFilesTimeout({
        operation: "readFile",
        path: "/workspace/slow.txt",
        timeoutSeconds: 0.02,
        retries: 1,
        run: (signal) => {
          attempts++
          if (attempts === 2) return Promise.resolve("recovered")
          return new Promise<string>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted++
                reject(new Error("request aborted"))
              },
              { once: true },
            )
          })
        },
      })
      expect(result).toBe("recovered")
      expect(attempts).toBe(2)
      expect(aborted).toBe(1)
    }),
  )

  it.live("returns a typed timeout after the configured retry budget without destroying the Sandbox", () =>
    Effect.gen(function* () {
      let attempts = 0
      let aborted = 0
      const exit = yield* withSandboxFilesTimeout({
        operation: "readBytes",
        path: "/workspace/slow.png",
        timeoutSeconds: 0.01,
        retries: 1,
        run: (signal) => {
          attempts++
          return new Promise<Uint8Array>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted++
                reject(new Error("request aborted"))
              },
              { once: true },
            )
          })
        },
      }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Sandbox.FilesTimeout")
        expect(Cause.pretty(exit.cause)).toContain("/workspace/slow.png")
      }
      expect(attempts).toBe(2)
      expect(aborted).toBe(2)
    }),
  )

  test("does not retry missing files or other ordinary API failures", async () => {
    let attempts = 0
    const missing = await Effect.runPromise(
      withSandboxFilesTimeout({
        operation: "readFile",
        path: "/workspace/missing.txt",
        timeoutSeconds: 1,
        retries: 1,
        run: async () => {
          attempts++
          return null
        },
      }),
    )
    expect(missing).toBeNull()
    expect(attempts).toBe(1)

    const failure = await Effect.runPromise(
      withSandboxFilesTimeout({
        operation: "readFile",
        path: "/workspace/error.txt",
        timeoutSeconds: 1,
        retries: 1,
        run: async () => {
          attempts++
          throw new Error("permission denied")
        },
      }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(failure)).toBe(true)
    expect(attempts).toBe(2)
  })
})
