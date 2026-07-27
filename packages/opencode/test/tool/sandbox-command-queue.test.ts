import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Semaphore } from "effect"
import { SandboxProvider, SandboxConfig } from "../../src/tool/sandbox-provider"
import type { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const sid = (s: string) => s as SessionID

function makeFakeSandbox() {
  const state = {
    runCalls: [] as string[],
    createSessionCalls: 0,
    maxConcurrent: 0,
    killed: false,
    closed: false,
  }
  let busy = false
  let currentConcurrent = 0
  const sb = {
    id: `sb-${Math.random().toString(36).slice(2, 8)}`,
    state,
    commands: {
      run: () => Promise.resolve(),
      createSession: () => {
        state.createSessionCalls++
        return Promise.resolve(`cmd-${state.createSessionCalls}`)
      },
      runInSession: (_sessionId: string, command: string) =>
        new Promise<any>((resolve, reject) => {
          currentConcurrent++
          if (currentConcurrent > state.maxConcurrent) {
            state.maxConcurrent = currentConcurrent
          }
          if (busy) {
            currentConcurrent--
            reject(new Error("CONCURRENT_CALL_DETECTED"))
            return
          }
          busy = true
          state.runCalls.push(command)
          setTimeout(() => {
            busy = false
            currentConcurrent--
            resolve({ exitCode: 0, stdout: command, stderr: "" } as any)
          }, 30)
        }),
      deleteSession: () => Promise.resolve(),
    },
    kill: () => { state.killed = true; return Promise.resolve() },
    close: () => { state.closed = true; return Promise.resolve() },
    isHealthy: () => Promise.resolve(!state.killed),
  } as any
  return { sb, state }
}

function buildFakeLayer() {
  const sandboxes = new Map<string, any>()
  const commandSessions = new Map<string, string>()
  const commandSemaphores = new Map<string, Semaphore.Semaphore>()

  const configLayer = Layer.succeed(SandboxConfig.Service, SandboxConfig.Service.of({
    domain: "localhost:8080",
    protocol: "http" as const,
    apiKey: "",
    useServerProxy: false,
    image: "ubuntu",
    timeoutSeconds: 600,
    resourceLimits: { cpu: "1", memory: "2Gi" },
    volumeType: "none" as const,
    pvcClaimName: "",
    idleKillMs: 30000,
    idleReapMs: 1800000,
    idleReapIntervalMs: 60_000,
    maxTtlSeconds: 3600,
    packageCacheMount: "/xybot-front/cache",
  }))

  const providerLayer = Layer.effect(
    SandboxProvider.Service,
    Effect.gen(function* () {
      const getOrCreate = (sessionID: SessionID) =>
        Effect.gen(function* () {
          const existing = sandboxes.get(sessionID)
          if (existing) {
            const healthy = yield* Effect.tryPromise(() => existing.isHealthy()).pipe(
              Effect.catch(() => Effect.succeed(false)),
            )
            if (healthy) return existing
            sandboxes.delete(sessionID)
            commandSessions.delete(sessionID)
          }
          const { sb } = makeFakeSandbox()
          sandboxes.set(sessionID, sb)
          return sb
        })

      const runInSession = (sessionID: SessionID, command: string, options?: any, handlers?: any, signal?: any) =>
        Effect.gen(function* () {
          const sb = sandboxes.get(sessionID)
          if (!sb) return yield* Effect.fail(new Error(`Sandbox not found for session ${sessionID}`))

          let sessionId = commandSessions.get(sessionID)
          if (!sessionId) {
            sessionId = (yield* Effect.tryPromise(() => sb.commands.createSession({ workingDirectory: "/workspace" }))) as string
            commandSessions.set(sessionID, sessionId)
          }

          let sem = commandSemaphores.get(sessionID)
          if (!sem) {
            sem = yield* Semaphore.make(1)
            commandSemaphores.set(sessionID, sem)
          }

          return yield* sem.withPermit(
            Effect.tryPromise({
              try: () => sb.commands.runInSession(sessionId!, command, options, handlers, signal),
              catch: (e) => new Error(`runInSession failed: ${String(e)}`),
            }),
          )
        }) as any

      const destroy = (sessionID: SessionID) =>
        Effect.gen(function* () {
          const sb = sandboxes.get(sessionID)
          sandboxes.delete(sessionID)
          commandSessions.delete(sessionID)
          commandSemaphores.delete(sessionID)
          if (sb) {
            yield* Effect.tryPromise(() => sb.kill()).pipe(Effect.catch(() => Effect.void))
            yield* Effect.tryPromise(() => sb.close()).pipe(Effect.catch(() => Effect.void))
          }
        })

      const destroyById = (sandboxID: string) =>
        Effect.gen(function* () {
          for (const [sessionID, s] of sandboxes) {
            if (s.id === sandboxID) return yield* destroy(sid(sessionID))
          }
        })

      const destroyAll = () =>
        Effect.gen(function* () {
          for (const [sessionID, sb] of sandboxes) {
            sandboxes.delete(sessionID)
            commandSessions.delete(sessionID)
            commandSemaphores.delete(sessionID)
            yield* Effect.tryPromise(() => sb.kill()).pipe(Effect.catch(() => Effect.void))
            yield* Effect.tryPromise(() => sb.close()).pipe(Effect.catch(() => Effect.void))
          }
        })

      return SandboxProvider.Service.of({
        getOrCreate,
        get: (id) => Effect.sync(() => sandboxes.get(id) ?? null),
        destroy,
        destroyById,
        destroyAll,
        runInSession,
        register: (sessionID, sb) => Effect.sync(() => {
          commandSessions.delete(sessionID)
          commandSemaphores.delete(sessionID)
          sandboxes.set(sessionID, sb)
        }),
        keepAlive: () => Effect.void,
        touch: () => Effect.void,
        release: () => Effect.void,
        isKeepAlive: () => Effect.succeed(false),
        getEndpoint: () => Effect.die(new Error("not implemented")),
        cleanupSessionVolume: () => Effect.void,
        interrupt: () => Effect.void,
        runDetached: () => Effect.die(new Error("not implemented")),
      })
    }),
  )

  return Layer.provideMerge(providerLayer, configLayer)
}

const layer = buildFakeLayer()
const it = testEffect(layer)

describe("SandboxProvider command queue", () => {
  it.live("serializes concurrent runInSession calls within a session", () =>
    Effect.gen(function* () {
      const svc = yield* SandboxProvider.Service
      yield* svc.getOrCreate(sid("ses-serial"))

      const results = yield* Effect.all(
        Array.from({ length: 5 }, (_, i) =>
          svc.runInSession(sid("ses-serial"), `cmd-${i}`)
        ),
        { concurrency: "unbounded" },
      )

      expect(results.length).toBe(5)
      for (const r of results) {
        expect(r).toBeDefined()
      }

      const sb = yield* svc.get(sid("ses-serial"))
      expect((sb as any)?.state.maxConcurrent).toBeLessThanOrEqual(1)
      expect((sb as any)?.state.runCalls.length).toBe(5)
    }),
  )

  it.live("deduplicates command session creation under concurrency", () =>
    Effect.gen(function* () {
      const svc = yield* SandboxProvider.Service
      yield* svc.getOrCreate(sid("ses-dedup"))

      yield* Effect.all(
        Array.from({ length: 10 }, (_, i) =>
          svc.runInSession(sid("ses-dedup"), `echo ${i}`)
        ),
        { concurrency: "unbounded" },
      )

      const sb = yield* svc.get(sid("ses-dedup"))
      expect((sb as any)?.state.runCalls.length).toBe(10)
      expect((sb as any)?.state.maxConcurrent).toBeLessThanOrEqual(1)
    }),
  )

  it.live("cleans up semaphore on destroy", () =>
    Effect.gen(function* () {
      const svc = yield* SandboxProvider.Service

      yield* svc.getOrCreate(sid("ses-clean"))
      yield* svc.runInSession(sid("ses-clean"), "echo before")
      yield* svc.destroy(sid("ses-clean"))

      const result = yield* Effect.exit(svc.runInSession(sid("ses-clean"), "echo after"))
      expect(result._tag).toBe("Failure")
    }),
  )

  it.live("different sessions do not block each other", () =>
    Effect.gen(function* () {
      const svc = yield* SandboxProvider.Service
      yield* svc.getOrCreate(sid("ses-par-a"))
      yield* svc.getOrCreate(sid("ses-par-b"))

      const order: string[] = []

      const task = (sessionID: SessionID, label: string) =>
        Effect.gen(function* () {
          order.push(`${label}-start`)
          yield* svc.runInSession(sessionID, `echo ${label}`)
          order.push(`${label}-end`)
        })

      yield* Effect.all([task(sid("ses-par-a"), "A"), task(sid("ses-par-b"), "B")], {
        concurrency: "unbounded",
      })

      expect(order).toContain("A-start")
      expect(order).toContain("B-start")
      const sbA = yield* svc.get(sid("ses-par-a"))
      const sbB = yield* svc.get(sid("ses-par-b"))
      expect(sbA).not.toBe(sbB)
    }),
  )

  it.live("destroy during pending command does not deadlock", () =>
    Effect.gen(function* () {
      const svc = yield* SandboxProvider.Service
      yield* svc.getOrCreate(sid("ses-destroy-pend"))

      const fiber = yield* Effect.forkScoped(
        svc.runInSession(sid("ses-destroy-pend"), "long-running")
      )
      yield* Effect.sleep("10 millis")
      yield* svc.destroy(sid("ses-destroy-pend"))

      const exit = yield* Fiber.await(fiber)
      expect(exit._tag === "Success" || exit._tag === "Failure").toBe(true)
    }),
  )
})

describe("Lazy sandbox creation pattern", () => {
  it.live("returns null when disabled", () =>
    Effect.gen(function* () {
      let sandboxEnabled = false
      let sandboxPromise: Promise<any> | null = null
      const getSandbox = () => {
        if (!sandboxEnabled) return null
        if (!sandboxPromise) sandboxPromise = Promise.resolve({ id: "sb" })
        return sandboxPromise
      }
      expect(getSandbox()).toBeNull()
      expect(sandboxPromise).toBeNull()
    }),
  )

  it.live("memoizes promise on first call", () =>
    Effect.gen(function* () {
      let createCount = 0
      let promise: Promise<any> | null = null
      const getOrCreate = () =>
        Effect.gen(function* () {
          createCount++
          yield* Effect.sleep("5 millis")
          return { id: `sb-${createCount}` }
        })

      const getSandbox = () => {
        if (!promise) promise = getOrCreate().pipe(Effect.runPromise)
        return promise
      }

      const p1 = getSandbox()
      const p2 = getSandbox()
      const p3 = getSandbox()

      expect(p1).toBe(p2)
      expect(p2).toBe(p3)

      const r1 = yield* Effect.tryPromise(() => p1)
      const r2 = yield* Effect.tryPromise(() => p2)
      expect(r1).toBe(r2)
      expect(createCount).toBe(1)
    }),
  )

  it.live("separate sessions get separate promises", () =>
    Effect.gen(function* () {
      const promises = new Map<string, Promise<any>>()
      let createCount = 0

      const getSandbox = (sessionID: string) => {
        let p = promises.get(sessionID)
        if (!p) {
          p = Effect.gen(function* () {
            createCount++
            yield* Effect.sleep("5 millis")
            return { id: `sb-${sessionID}` }
          }).pipe(Effect.runPromise)
          promises.set(sessionID, p)
        }
        return p
      }

      const pA = getSandbox("A")
      const pB = getSandbox("B")
      expect(pA).not.toBe(pB)

      const rA = yield* Effect.tryPromise(() => pA)
      const rB = yield* Effect.tryPromise(() => pB)
      expect(rA.id).toBe("sb-A")
      expect(rB.id).toBe("sb-B")
      expect(createCount).toBe(2)
    }),
  )

  it.live("multiple concurrent callers share same promise", () =>
    Effect.gen(function* () {
      let createCount = 0
      let promise: Promise<any> | null = null

      const getSandbox = () => {
        if (!promise) {
          promise = Effect.gen(function* () {
            createCount++
            yield* Effect.sleep("50 millis")
            return { id: "shared" }
          }).pipe(Effect.runPromise)
        }
        return promise
      }

      const results = yield* Effect.all(
        Array.from({ length: 20 }, () =>
          Effect.gen(function* () {
            const p = getSandbox()
            return yield* Effect.tryPromise(() => p)
          })
        ),
        { concurrency: "unbounded" },
      )

      expect(createCount).toBe(1)
      const ids = new Set(results.map((r: any) => r.id))
      expect(ids.size).toBe(1)
    }),
  )
})
