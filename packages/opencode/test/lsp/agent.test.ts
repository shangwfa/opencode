import { describe, expect, test } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { Agent as LspAgent } from "@/lsp/agent"
import { SessionID } from "@/session/schema"
import { awaitWithTimeout, it } from "../lib/effect"

// Counts how many times runDetached was invoked across the mock provider.
// Reset before each scenario via makeMockSandbox().
let runDetachedCount = 0

// Mock SandboxProvider whose runDetached either never resolves (simulating a
// long-lived daemon process that the SDK would otherwise block on) or returns
// immediately. Only runDetached + getEndpoint are exercised by LspAgent;
// Layer.mock leaves the rest as UnimplementedError so accidental calls surface.
function mockSandboxLayer(neverResolve: boolean) {
  runDetachedCount = 0
  return Layer.mock(SandboxProvider.Service, {
    runDetached: () => {
      runDetachedCount++
      // Effect.never models a daemon that never exits: the historical bug was
      // that awaiting this inline deadlocked ensureDaemon. forkDetach lets it
      // run in the background while probe polling determines readiness.
      return neverResolve ? Effect.never : Effect.succeed({} as never)
    },
    getEndpoint: () => Effect.succeed("http://mock-daemon:20877"),
  })
}

// Mock HttpClient: /lsp/status -> {servers:[]} (probe success), /lsp/touch ->
// {version:0}. This makes ensureDaemon's probe succeed on the first poll.
function mockHttpLayer() {
  const client = HttpClient.make((req) => {
    const url: string = (req as { url?: string }).url ?? ""
    const body = url.includes("/lsp/status")
      ? { servers: [] }
      : url.includes("/lsp/touch")
        ? { version: 0 }
        : {}
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        req as never,
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    )
  })
  return Layer.succeed(HttpClient.HttpClient, client)
}

function buildLayer(neverResolve: boolean) {
  return Layer.mergeAll(LspAgent.layer, mockSandboxLayer(neverResolve), mockHttpLayer())
}

// T27.17 — P0 regression: ensureDaemon must NOT block when runDetached never
// resolves. Before the fix, `yield* sandbox.runDetached(...)` deadlocked
// because the underlying runInSession Promise only settles once the command
// process exits, and a daemon never exits. The fix forks runDetached into the
// background (Effect.forkDetach) so ensureDaemon proceeds to probe polling.
describe("LspAgent ensureDaemon — T27.17 deadlock regression", () => {
  it.live(
    "ensureDaemon returns even when runDetached never resolves",
    () =>
      awaitWithTimeout(
        Effect.gen(function* () {
          const agent = yield* LspAgent.Service
          // If ensureDaemon deadlocks, touch hangs forever and the timeout
          // below flips this test from pass to fail.
          const result = yield* agent.touch(SessionID.make("ses-deadlock"), "/workspace/foo.ts", "/workspace")
          expect(result.version).toBe(0)
          // runDetached was actually invoked (daemon launch was attempted).
          yield* Effect.sync(() => expect(runDetachedCount).toBe(1))
        }).pipe(Effect.provide(buildLayer(true))) as any,
        "ensureDaemon deadlocked: touch never returned",
        "10 seconds",
      ),
    30000,
  )
})

// T27.18 — concurrent dedup: multiple concurrent LSP requests for the same
// session must trigger runDetached exactly once. The fix moves the
// `daemonStates.set("starting")` ahead of the first yield so the check-then-set
// is an atomic synchronous step (Effect only yields at yield*).
describe("LspAgent ensureDaemon — T27.18 concurrent dedup", () => {
  it.live(
    "5 concurrent requests spawn the daemon only once",
    () =>
      awaitWithTimeout(
        Effect.gen(function* () {
          const agent = yield* LspAgent.Service
          // Fire 5 concurrent touches. Some may fail with "LSP daemon is not
          // available" while the first is still in its starting->running window;
          // that is expected and unrelated to the dedup property under test.
          yield* Effect.all(
            Array.from({ length: 5 }, () =>
            agent.touch(SessionID.make("ses-dedup"), "/workspace/foo.ts", "/workspace").pipe(
              Effect.catchCause(() => Effect.void),
            ),
            ),
            { concurrency: "unbounded" },
          )
          // The key assertion: runDetached was called exactly once. Before the
          // fix, concurrent fibers could each pass the `state === undefined`
          // check and each invoke runDetached.
          yield* Effect.sync(() => expect(runDetachedCount).toBe(1))
        }).pipe(Effect.provide(buildLayer(true))) as any,
        "concurrent dedup test timed out",
        "15 seconds",
      ),
    30000,
  )
})

// T27.x — shutdown clears daemon cache entry so subsequent requests restart
// the daemon cleanly. This is the per-pod cleanup path that GC and idle
// reclamation rely on.
describe("LspAgent shutdown — cache entry reclamation", () => {
  it.live(
    "shutdown deletes the cache entry; next touch restarts daemon",
    () =>
      awaitWithTimeout(
        Effect.gen(function* () {
          const agent = yield* LspAgent.Service
          // First touch: starts daemon, creates cache entry.
          yield* agent.touch(SessionID.make("ses-gc"), "/workspace/foo.ts", "/workspace")
          expect(runDetachedCount).toBe(1)
          // Shutdown: clears cache entry (daemonStates delete-first).
          yield* agent.shutdown(SessionID.make("ses-gc"))
          // Second touch: cache entry was deleted, ensureDaemon runs again.
          yield* agent.touch(SessionID.make("ses-gc"), "/workspace/foo.ts", "/workspace")
          expect(runDetachedCount).toBe(2)
        }).pipe(Effect.provide(buildLayer(true))) as any,
        "shutdown reclamation test timed out",
        "15 seconds",
      ),
    30000,
  )
})
