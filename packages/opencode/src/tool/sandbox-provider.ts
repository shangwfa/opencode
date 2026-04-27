import { Effect, Context, Layer, Cause, Deferred, Ref, Semaphore } from "effect"
import { Sandbox, ConnectionConfig } from "@alibaba-group/opensandbox"
import type { CommandExecution } from "@alibaba-group/opensandbox"
import { Log } from "../util/log"
import { Flag } from "../flag/flag"
import type { SessionID } from "../session/schema"

export namespace SandboxConfig {
  export interface Interface {
    readonly domain: string
    readonly protocol: "http" | "https"
    readonly image: string
    readonly timeoutSeconds: number
    readonly resourceLimits: Record<string, string>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SandboxConfig") {}

  export const defaultConfig: Interface = {
    domain: Flag.OPENCODE_SANDBOX_DOMAIN,
    protocol: "http" as const,
    image: Flag.OPENCODE_SANDBOX_IMAGE,
    timeoutSeconds: Flag.OPENCODE_SANDBOX_TIMEOUT,
    resourceLimits: { cpu: "1", memory: "2Gi" },
  }

  export const layer = Layer.succeed(Service, Service.of(defaultConfig))

  export const defaultLayer = layer
}

export namespace SandboxProvider {
  const log = Log.create({ service: "sandbox-provider" })

  export interface Interface {
    readonly getOrCreate: (sessionID: SessionID) => Effect.Effect<Sandbox>
    readonly get: (sessionID: SessionID) => Effect.Effect<Sandbox | null>
    readonly destroy: (sessionID: SessionID) => Effect.Effect<void>
    readonly destroyAll: () => Effect.Effect<void>
    readonly runInSession: (
      sessionID: SessionID,
      command: string,
      options?: { workingDirectory?: string; timeoutSeconds?: number },
      handlers?: {
        onStdout?: (msg: { text: string }) => void | Promise<void>
        onStderr?: (msg: { text: string }) => void | Promise<void>
        onEvent?: (ev: unknown) => void | Promise<void>
        onResult?: (res: unknown) => void | Promise<void>
        onExecutionComplete?: (c: unknown) => void | Promise<void>
        onError?: (err: unknown) => void | Promise<void>
        onInit?: (init: unknown) => void | Promise<void>
      },
      signal?: AbortSignal,
    ) => Effect.Effect<CommandExecution, Error, never>
    readonly register: (sessionID: SessionID, sb: Sandbox) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SandboxProvider") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* SandboxConfig.Service
      const sandboxes = new Map<string, Sandbox>()
      const commandSessions = new Map<string, string>()
      const commandSemaphores = new Map<string, Semaphore.Semaphore>()
      // Race-free in-flight: Ref.modify atomically decides which fiber is the
      // "creator"; all others await via Deferred. Identity check on the token.
      const createRef = yield* Ref.make(new Map<string, Deferred.Deferred<Sandbox, Error>>())
      const sessionRef = yield* Ref.make(new Map<string, Deferred.Deferred<string, Error>>())

      const connectionConfig = new ConnectionConfig({
        domain: config.domain,
        protocol: config.protocol,
      })

      function createSandbox(sessionID: SessionID) {
        return Effect.gen(function* () {
          log.info("creating sandbox", { sessionID })
          const sb = yield* Effect.tryPromise(() =>
            Sandbox.create({
              connectionConfig,
              image: config.image,
              timeoutSeconds: config.timeoutSeconds,
              resource: config.resourceLimits,
            }),
          )
          yield* Effect.tryPromise(() => sb.commands.run("mkdir -p /workspace")).pipe(
            Effect.catchCause(() => Effect.void),
          )
          log.info("sandbox created", { sessionID, sandboxID: sb.id })
          return sb
        }).pipe(Effect.orDie, Effect.withSpan("SandboxProvider.createSandbox"))
      }

      function destroySandbox(sb: Sandbox, sessionID: string) {
        return Effect.gen(function* () {
          log.info("destroying sandbox", { sessionID, sandboxID: sb.id })
          const cmdSession = commandSessions.get(sessionID)
          if (cmdSession) {
            yield* Effect.tryPromise(() => sb.commands.deleteSession(cmdSession)).pipe(
              Effect.catchCause(() => Effect.void),
            )
          }
          yield* Effect.tryPromise(() => sb.kill()).pipe(
            Effect.catchCause(() => {
              log.error("sandbox kill failed", { sessionID })
              return Effect.void
            }),
          )
          yield* Effect.tryPromise(() => sb.close()).pipe(
            Effect.catchCause(() => {
              log.error("sandbox close failed", { sessionID })
              return Effect.void
            }),
          )
          log.info("sandbox destroyed", { sessionID })
        }).pipe(Effect.withSpan("SandboxProvider.destroySandbox"))
      }

      function claim<D, E>(ref: Ref.Ref<Map<string, Deferred.Deferred<D, E>>>, key: string, token: Deferred.Deferred<D, E>) {
        return Ref.modify(ref, (map) => {
          const existing = map.get(key)
          if (existing) return [existing, map] as const
          return [token, map.set(key, token)] as const
        })
      }

      const getOrCreate: Interface["getOrCreate"] = (sessionID) =>
        Effect.gen(function* () {
          const myToken = yield* Deferred.make<Sandbox, Error>()
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
                log.warn("sandbox unhealthy, rebuilding", { sessionID })
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
                      log.warn("sandbox ownership lost, cleaning up", { sessionID })
                      yield* destroySandbox(exit.value, sessionID).pipe(
                        Effect.catchCause(() => Effect.void),
                      )
                    }
                  }),
                ),
              ),
            ),
          )
        }).pipe(Effect.orDie, Effect.withSpan("SandboxProvider.getOrCreate"))

      const get: Interface["get"] = (sessionID) =>
        Effect.sync(() => sandboxes.get(sessionID) ?? null)

      const destroy: Interface["destroy"] = (sessionID) =>
        Effect.gen(function* () {
          const sb = sandboxes.get(sessionID)
          sandboxes.delete(sessionID)
          commandSessions.delete(sessionID)
          commandSemaphores.delete(sessionID)
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
          if (sb) {
            yield* destroySandbox(sb, sessionID)
          }
        }).pipe(Effect.withSpan("SandboxProvider.destroy"))

      const destroyAll: Interface["destroyAll"] = () =>
        Effect.gen(function* () {
          log.info("destroying all sandboxes", { count: sandboxes.size })
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
            commandSemaphores.delete(sessionID)
            yield* destroySandbox(sb, sessionID).pipe(
              Effect.catchCause((cause) => {
                log.error("failed to destroy sandbox during shutdown", { sessionID, cause: Cause.pretty(cause) })
                return Effect.void
              }),
            )
          }
        }).pipe(Effect.withSpan("SandboxProvider.destroyAll"))

      const runInSession: Interface["runInSession"] = (sessionID, command, options, handlers, signal) =>
        Effect.gen(function* () {
          const sb = sandboxes.get(sessionID)
          if (!sb) {
            return yield* Effect.fail(new Error(`Sandbox not found for session ${sessionID}`))
          }
          let sessionId = commandSessions.get(sessionID)
          if (!sessionId) {
            const myToken = yield* Deferred.make<string, Error>()
            const winner = yield* claim(sessionRef, sessionID, myToken)

            if (winner !== myToken) {
              sessionId = yield* Deferred.await(winner)
            } else {
              sessionId = yield* Effect.tryPromise({
                try: () => sb.commands.createSession({ workingDirectory: "/workspace" }),
                catch: (e) => new Error(`Failed to create command session: ${String(e)}`),
              }).pipe(
                Effect.onExit((exit) =>
                  Ref.modify(sessionRef, (m) => {
                    const ours = m.get(sessionID) === myToken
                    m.delete(sessionID)
                    return [ours, m] as const
                  }).pipe(
                    Effect.andThen((ours) => {
                      if (ours) {
                        if (exit._tag === "Success") commandSessions.set(sessionID, exit.value)
                        return Deferred.done(myToken, exit)
                      }
                      return Effect.void
                    }),
                  ),
                ),
              )
            }
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
        }).pipe(Effect.withSpan("SandboxProvider.runInSession"))

      const register: Interface["register"] = (sessionID, sb) =>
        Effect.sync(() => {
          commandSessions.delete(sessionID)
          commandSemaphores.delete(sessionID)
          sandboxes.set(sessionID, sb)
        })

      yield* Effect.addFinalizer(() =>
        destroyAll().pipe(
          Effect.catchCause((cause) => {
            log.error("sandbox cleanup on scope exit failed", { cause: Cause.pretty(cause) })
            return Effect.void
          }),
        ),
      )

      return Service.of({ getOrCreate, get, destroy, destroyAll, runInSession, register })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(SandboxConfig.defaultLayer))
}

export namespace NoopSandboxProvider {
  export const layer = Layer.succeed(
    SandboxProvider.Service,
    SandboxProvider.Service.of({
      getOrCreate: () => Effect.succeed(null as unknown as Sandbox),
      get: () => Effect.succeed(null),
      destroy: () => Effect.void,
      destroyAll: () => Effect.void,
      runInSession: () => Effect.fail(new Error("Sandbox is disabled")),
      register: () => Effect.void,
    }),
  )
}
