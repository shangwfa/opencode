import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer, Deferred, Ref } from "effect"
import { SandboxProvider, SandboxConfig } from "../../src/tool/sandbox-provider"
import type { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

let createCount = 0
let createSessionCount = 0
let createDelay = 0

function makeFakeSandbox() {
  createCount++
  const id = `sandbox-${createCount}`
  return {
    id,
    commands: {
      run: () => Promise.resolve(),
      createSession: () => {
        createSessionCount++
        return Promise.resolve(`session-${createSessionCount}`)
      },
      runInSession: () => Promise.resolve({} as any),
      deleteSession: () => Promise.resolve(),
    },
    kill: () => Promise.resolve(),
    close: () => Promise.resolve(),
    isHealthy: () => Promise.resolve(true),
  } as any
}

// Fake provider mirrors the real SandboxProvider layer but uses makeFakeSandbox()
const fakeProvider = Layer.effect(
  SandboxProvider.Service,
  Effect.gen(function* () {
    yield* SandboxConfig.Service
    const sandboxes = new Map<string, any>()
    const commandSessions = new Map<string, string>()
    const createRef = yield* Ref.make(new Map<string, Deferred.Deferred<any, Error>>())
    const sessionRef = yield* Ref.make(new Map<string, Deferred.Deferred<any, Error>>())

    function claim(ref: Ref.Ref<Map<string, Deferred.Deferred<any, Error>>>, key: string, token: Deferred.Deferred<any, Error>) {
      return Ref.modify(ref, (map) => {
        const existing = map.get(key)
        if (existing) return [existing, map] as const
        return [token, map.set(key, token)] as const
      })
    }

    function createSandbox(sessionID: string) {
      return Effect.gen(function* () {
        if (createDelay > 0) yield* Effect.sleep(`${createDelay} millis`)
        return makeFakeSandbox()
      }).pipe(Effect.orDie)
    }

    function destroySandbox(_sb: any, sessionID: string) {
      return Effect.gen(function* () {
        commandSessions.delete(sessionID)
        sandboxes.delete(sessionID)
      })
    }

    const getOrCreate = (sessionID: string) =>
      Effect.gen(function* () {
        const myToken = yield* Deferred.make<any, Error>()
        const winner = yield* claim(createRef, sessionID, myToken)
        if (winner !== myToken) {
          return yield* Deferred.await(winner).pipe(Effect.orDie)
        }
        const existing = sandboxes.get(sessionID)
        const work = existing
          ? Effect.gen(function* () {
              const healthy = yield* Effect.tryPromise(() => existing.isHealthy()).pipe(
                Effect.catch(() => Effect.succeed(false)),
              )
              if (healthy) return existing
              yield* destroySandbox(existing, sessionID)
              return yield* createSandbox(sessionID)
            })
          : createSandbox(sessionID)
        return yield* work.pipe(
          Effect.onExit((exit) =>
            Ref.modify(createRef, (m) => {
              const ours = m.get(sessionID) === myToken
              m.delete(sessionID)
              return [ours, m] as const
            }).pipe(
              Effect.andThen((ours) =>
                Effect.gen(function* () {
                  if (ours) {
                    if (exit._tag === "Success") sandboxes.set(sessionID, exit.value)
                    yield* Deferred.done(myToken, exit)
                    return
                  }
                  if (exit._tag === "Success") {
                    yield* destroySandbox(exit.value, sessionID)
                  }
                }),
              ),
            ),
          ),
        )
      }).pipe(Effect.orDie)

    const destroy = (sessionID: string) =>
      Effect.gen(function* () {
        const sb = sandboxes.get(sessionID)
        sandboxes.delete(sessionID)
        commandSessions.delete(sessionID)
        const inFlight = yield* Ref.modify(createRef, (m) => {
          const d = m.get(sessionID)
          if (d) m.delete(sessionID)
          return [d, m] as const
        })
        if (inFlight) {
          yield* Deferred.fail(inFlight, new Error(`Sandbox destroyed while creating: ${sessionID}`))
        }
        const inFlightSession = yield* Ref.modify(sessionRef, (m) => {
          const d = m.get(sessionID)
          if (d) m.delete(sessionID)
          return [d, m] as const
        })
        if (inFlightSession) {
          yield* Deferred.fail(inFlightSession, new Error(`Command session destroyed while creating: ${sessionID}`))
        }
        if (sb) yield* destroySandbox(sb, sessionID)
      })

    const destroyById = (_sandboxID: string) =>
      Effect.gen(function* () {
        for (const [sid, s] of sandboxes) {
          if (s.id === _sandboxID) {
            yield* destroy(sid)
            return
          }
        }
      })

    const runInSession = (sessionID: string) =>
      Effect.gen(function* () {
        const sb = sandboxes.get(sessionID)
        if (!sb) return yield* Effect.fail(new Error("Sandbox not found"))
        let sessionId: string | undefined = commandSessions.get(sessionID)
        if (!sessionId) {
          const myToken = yield* Deferred.make<any, Error>()
          const winner = yield* claim(sessionRef, sessionID, myToken)
          if (winner !== myToken) {
            sessionId = (yield* Deferred.await(winner)) as string
          } else {
            sessionId = (yield* Effect.tryPromise({
              try: () => sb.commands.createSession({ workingDirectory: "/workspace" }) as Promise<string>,
              catch: (e) => new Error(`Failed: ${String(e)}`),
            }).pipe(
              Effect.onExit((exit) =>
                Ref.modify(sessionRef, (m) => {
                  const ours = m.get(sessionID) === myToken
                  m.delete(sessionID)
                  return [ours, m] as const
                }).pipe(
                  Effect.andThen((ours) => {
                    if (ours) {
                      if (exit._tag === "Success") commandSessions.set(sessionID, exit.value as string)
                      return Deferred.done(myToken, exit)
                    }
                    return Effect.void
                  }),
                ),
              ),
            )) as string
          }
        }
        return { sessionId } as any
      })

    return SandboxProvider.Service.of({
      getOrCreate,
      get: (id: string) => Effect.sync(() => sandboxes.get(id) ?? null),
      destroy,
      destroyById,
      destroyAll: () =>
        Effect.gen(function* () {
          const inFlightCreates = yield* Ref.modify(createRef, (m) => {
            const entries = Array.from(m.entries())
            m.clear()
            return [entries, m] as const
          })
          for (const [, d] of inFlightCreates) {
            yield* Deferred.fail(d, new Error("Sandbox destroyed during shutdown"))
          }
          const inFlightSessions = yield* Ref.modify(sessionRef, (m) => {
            const entries = Array.from(m.entries())
            m.clear()
            return [entries, m] as const
          })
          for (const [, d] of inFlightSessions) {
            yield* Deferred.fail(d, new Error("Command session destroyed during shutdown"))
          }
          const entries = Array.from(sandboxes.entries())
          for (const [sessionID, sb] of entries) {
            sandboxes.delete(sessionID)
            commandSessions.delete(sessionID)
            yield* destroySandbox(sb, sessionID)
          }
        }),
      runInSession,
      register: () => Effect.void,
      keepAlive: () => Effect.void,
      release: () => Effect.void,
      isKeepAlive: () => Effect.succeed(false),
      getEndpoint: () => Effect.die(new Error("not implemented")),
      cleanupSessionVolume: () => Effect.void,
    })
  }),
)

const layer = fakeProvider.pipe(Layer.provide(SandboxConfig.layer))
const it = testEffect(layer)

const sid = (s: string) => s as SessionID

describe("SandboxProvider concurrency", () => {
  it.live("concurrent getOrCreate deduplicates sandbox creation", () =>
    Effect.gen(function* () {
      createCount = 0
      const svc = yield* SandboxProvider.Service
      const results = yield* Effect.all(
        Array.from({ length: 10 }, () => svc.getOrCreate(sid("ses_dedup"))),
        { concurrency: "unbounded" },
      )
      expect(createCount).toBe(1)
      expect(new Set(results.map((r: any) => r.id)).size).toBe(1)
    }),
  )

  it.live("concurrent runInSession deduplicates command session creation", () =>
    Effect.gen(function* () {
      createCount = 0
      createSessionCount = 0
      const svc = yield* SandboxProvider.Service
      yield* svc.getOrCreate(sid("ses_session_dedup"))
      const results = yield* Effect.all(
        Array.from({ length: 10 }, () => svc.runInSession(sid("ses_session_dedup"), "echo hi")),
        { concurrency: "unbounded" },
      )
      expect(createSessionCount).toBe(1)
      expect(new Set(results.map((r: any) => r.sessionId)).size).toBe(1)
    }),
  )

  it.live("destroy during getOrCreate does not create duplicate sandbox", () =>
    Effect.gen(function* () {
      createCount = 0
      const svc = yield* SandboxProvider.Service
      yield* svc.getOrCreate(sid("ses_destroy_race"))
      const results = yield* Effect.all(
        [
          svc.getOrCreate(sid("ses_destroy_race")),
          svc.destroy(sid("ses_destroy_race")),
          svc.getOrCreate(sid("ses_destroy_race")),
        ],
        { concurrency: "unbounded" },
      )
      expect(createCount).toBe(2)
      const last = results[2] as any
      expect(last.id).toBe("sandbox-2")
    }),
  )

  it.live("TOCTOU stress: rapid concurrent getOrCreate with yields between claims", () =>
    Effect.gen(function* () {
      createCount = 0
      const svc = yield* SandboxProvider.Service
      // Force interleaving by adding a yield before each getOrCreate
      const results = yield* Effect.all(
        Array.from({ length: 50 }, (_, i) =>
          Effect.gen(function* () {
            yield* Effect.sleep(`${i} millis`)
            return yield* svc.getOrCreate(sid("ses_toctou_stress"))
          }),
        ),
        { concurrency: "unbounded" },
      )
      expect(createCount).toBe(1)
      expect(new Set(results.map((r: any) => r.id)).size).toBe(1)
    }),
  )

  it.live("destroy fails in-flight getOrCreate Deferreds", () =>
    Effect.gen(function* () {
      createCount = 0
      createDelay = 200
      const svc = yield* SandboxProvider.Service
      // Fork the creator — it claims the Deferred and starts creating
      yield* Effect.forkScoped(svc.getOrCreate(sid("ses_destroy_inflight")))
      yield* Effect.sleep("10 millis")
      // Fork an awaiter — it gets the creator's Deferred and awaits it
      const awaiter = yield* Effect.forkScoped(svc.getOrCreate(sid("ses_destroy_inflight")))
      yield* Effect.sleep("10 millis")
      // Destroy while creation is in-flight — fails the Deferred
      yield* svc.destroy(sid("ses_destroy_inflight"))
      const exit = yield* Fiber.await(awaiter)
      expect(Exit.isFailure(exit)).toBe(true)
      createDelay = 0
    }),
  )

  it.live("concurrent awaiters receive error when destroy cancels creator", () =>
    Effect.gen(function* () {
      createCount = 0
      createDelay = 200
      const svc = yield* SandboxProvider.Service
      const fibers = yield* Effect.all(
        Array.from({ length: 5 }, () => Effect.forkScoped(svc.getOrCreate(sid("ses_awaiters_destroy")))),
        { concurrency: "unbounded" },
      )
      yield* Effect.sleep("20 millis")
      yield* svc.destroy(sid("ses_awaiters_destroy"))
      let failures = 0
      for (const fiber of fibers) {
        const exit = yield* Fiber.await(fiber)
        if (Exit.isFailure(exit)) failures++
      }
      // Creator succeeds (runs work directly), awaiters fail (Deferred.await)
      expect(failures).toBeGreaterThanOrEqual(4)
      createDelay = 0
    }),
  )

  it.live("destroyAll fails all in-flight getOrCreate Deferreds", () =>
    Effect.gen(function* () {
      createCount = 0
      createDelay = 200
      const svc = yield* SandboxProvider.Service
      // For each of 3 sessions: fork 2 concurrent getOrCreate
      // (1 creator + 1 awaiter per session)
      const fibers = yield* Effect.all(
        Array.from({ length: 3 }, (_, i) =>
          Effect.gen(function* () {
            yield* Effect.forkScoped(svc.getOrCreate(sid(`ses_destroyall_${i}`)))
            yield* Effect.sleep("5 millis")
            return yield* Effect.forkScoped(svc.getOrCreate(sid(`ses_destroyall_${i}`)))
          })
        ),
        { concurrency: "unbounded" },
      )
      yield* Effect.sleep("20 millis")
      yield* svc.destroyAll()
      let failures = 0
      for (const fiber of fibers) {
        const exit = yield* Fiber.await(fiber)
        if (Exit.isFailure(exit)) failures++
      }
      // All 3 awaiters should fail
      expect(failures).toBe(3)
      createDelay = 0
    }),
  )

  it.live("new getOrCreate works after destroy during in-flight creation", () =>
    Effect.gen(function* () {
      createCount = 0
      createDelay = 50
      const svc = yield* SandboxProvider.Service
      yield* Effect.forkScoped(svc.getOrCreate(sid("ses_recreate")))
      yield* Effect.sleep("10 millis")
      yield* svc.destroy(sid("ses_recreate"))
      createDelay = 0
      const sb = yield* svc.getOrCreate(sid("ses_recreate"))
      expect(sb).toBeDefined()
      expect((sb as any).id).toBeDefined()
    }),
  )

  it.live("destroy during in-flight getOrCreate does not leave zombie sandbox", () =>
    Effect.gen(function* () {
      createCount = 0
      createDelay = 100
      const svc = yield* SandboxProvider.Service

      // Fork creator — it wins claim and starts slow creation
      yield* Effect.forkScoped(svc.getOrCreate(sid("ses_zombie")))
      yield* Effect.sleep("20 millis")

      // Destroy while creation is in-flight — removes our token from createRef
      yield* svc.destroy(sid("ses_zombie"))
      yield* Effect.sleep("200 millis") // Wait for creator to finish

      // The zombie fix: creator's onExit should detect ownership loss
      // and NOT store the sandbox in the map
      const sb = yield* svc.get(sid("ses_zombie"))
      expect(sb).toBeNull() // No zombie in the map!

      createDelay = 0
    }),
  )
})
