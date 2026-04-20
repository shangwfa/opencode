import { Effect, Context, Layer, Cause } from "effect"
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
    /**
     * Get an existing sandbox for the session, or lazily create one.
     * If the existing sandbox is unhealthy, it will be destroyed and rebuilt.
     */
    readonly getOrCreate: (sessionID: SessionID) => Effect.Effect<Sandbox>
    /**
     * Get an existing sandbox for the session, or null if none exists.
     */
    readonly get: (sessionID: SessionID) => Effect.Effect<Sandbox | null>
    /**
     * Destroy the sandbox bound to the given session.
     * Calls kill() then close() on the sandbox instance.
     */
    readonly destroy: (sessionID: SessionID) => Effect.Effect<void>
    /**
     * Destroy all managed sandboxes. Intended for process shutdown.
     */
    readonly destroyAll: () => Effect.Effect<void>
    /**
     * Run a command inside a reusable bash session for the given sandbox.
     * Lazily creates the session on first use and reuses it across calls.
     */
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
    /**
     * Register an externally-created sandbox for a session (primarily for tests).
     */
    readonly register: (sessionID: SessionID, sb: Sandbox) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SandboxProvider") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* SandboxConfig.Service
      const sandboxes = new Map<string, Sandbox>()
      const commandSessions = new Map<string, string>()

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
          // Ensure the workspace directory exists inside the sandbox
          yield* Effect.tryPromise(() => sb.commands.run("mkdir -p /workspace")).pipe(
            Effect.catchCause(() => Effect.void),
          )
          sandboxes.set(sessionID, sb)
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
            commandSessions.delete(sessionID)
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
          sandboxes.delete(sessionID)
          log.info("sandbox destroyed", { sessionID })
        }).pipe(Effect.withSpan("SandboxProvider.destroySandbox"))
      }

      const getOrCreate: Interface["getOrCreate"] = (sessionID) =>
        Effect.gen(function* () {
          const existing = sandboxes.get(sessionID)
          if (existing) {
            const healthy = yield* Effect.tryPromise(() => existing.isHealthy()).pipe(
              Effect.catch(() => Effect.succeed(false)),
            )
            if (healthy) {
              return existing
            }
            log.warn("sandbox unhealthy, rebuilding", { sessionID })
            yield* destroySandbox(existing, sessionID)
          }
          return yield* createSandbox(sessionID)
        }).pipe(Effect.withSpan("SandboxProvider.getOrCreate"))

      const get: Interface["get"] = (sessionID) =>
        Effect.sync(() => sandboxes.get(sessionID) ?? null)

      const destroy: Interface["destroy"] = (sessionID) =>
        Effect.gen(function* () {
          const sb = sandboxes.get(sessionID)
          if (sb) {
            yield* destroySandbox(sb, sessionID)
          }
        }).pipe(Effect.withSpan("SandboxProvider.destroy"))

      const destroyAll: Interface["destroyAll"] = () =>
        Effect.gen(function* () {
          log.info("destroying all sandboxes", { count: sandboxes.size })
          const entries = Array.from(sandboxes.entries())
          for (const [sessionID, sb] of entries) {
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
            sessionId = yield* Effect.tryPromise({
              try: () => sb.commands.createSession({ workingDirectory: "/workspace" }),
              catch: (e) => new Error(`Failed to create command session: ${String(e)}`),
            })
            commandSessions.set(sessionID, sessionId)
          }
          return yield* Effect.tryPromise({
            try: () => sb.commands.runInSession(sessionId!, command, options, handlers, signal),
            catch: (e) => new Error(`runInSession failed: ${String(e)}`),
          })
        }).pipe(Effect.withSpan("SandboxProvider.runInSession"))

      const register: Interface["register"] = (sessionID, sb) =>
        Effect.sync(() => {
          commandSessions.delete(sessionID)
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
