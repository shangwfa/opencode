export * as SandboxProvider from "./provider.js"

import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"
import { Context, Deferred, Duration, Effect, Layer, Ref } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { SandboxConfig } from "./config.js"
import { SandboxPath } from "./path.js"

const CREATE_TIMEOUT_SECONDS = 60

export interface ExecutionResult {
  readonly exitCode: number | null
  readonly output: string
  readonly timedOut: boolean
}

export interface RunInput {
  readonly sessionID: string
  readonly command: string
  /** Host working directory; mapped onto the sandbox `/workspace` mount. */
  readonly cwd?: string
  readonly hostWorkdir: string
  /** Milliseconds; 0 disables the timeout. */
  readonly timeoutMs?: number
}

export interface Interface {
  /** False keeps every tool on its local path; the layer is always present. */
  readonly enabled: boolean
  readonly run: (input: RunInput) => Effect.Effect<ExecutionResult, Error>
  readonly interrupt: (sessionID: string) => Effect.Effect<void>
  readonly destroy: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SandboxProvider") {}

type Entry = {
  sb: Sandbox
  commandSessionID: string
}

// The 0.1.x SDK types `commands` with a promise-based run API; the SSE stream
// method exists at runtime with the same event protocol. Consuming the stream
// directly returns as soon as execution_complete arrives instead of waiting
// for intermediary proxies to close the held-open connection.
type StreamEvent = {
  type: string
  text?: string
  error?: { ename?: string; evalue?: string; name?: string; value?: string }
}

type ExecCommands = {
  run(command: string): Promise<unknown>
  createSession(options?: { workingDirectory?: string }): Promise<string>
  deleteSession(sessionId: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  runInSessionStream(
    sessionId: string,
    command: string,
    options?: { workingDirectory?: string; timeoutSeconds?: number },
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>
}

const commandsOf = (sb: Sandbox): ExecCommands => sb.commands as unknown as ExecCommands

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = SandboxConfig.load()
    if (!config.enabled)
      return Service.of({
        enabled: false,
        run: () => Effect.die(new Error("Sandbox provider is disabled")),
        interrupt: () => Effect.void,
        destroy: () => Effect.void,
      })

    const entries = yield* Ref.make(new Map<string, Entry>())
    const creates = yield* Ref.make(new Map<string, Deferred.Deferred<Sandbox, Error>>())

    const connectionConfig = new ConnectionConfig({
      domain: config.domain,
      protocol: config.protocol,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      useServerProxy: config.useServerProxy,
      requestTimeoutSeconds: 120,
    })

    const drop = (sessionID: string) =>
      Ref.modify(entries, (map) => {
        const found = map.get(sessionID) ?? null
        if (found) map.delete(sessionID)
        return [found, map] as const
      })

    const destroySandbox = (sessionID: string) =>
      Effect.gen(function* () {
        const entry = yield* drop(sessionID)
        if (!entry) return
        yield* Effect.promise(() => entry.sb.commands.deleteSession(entry.commandSessionID)).pipe(
          Effect.ignore,
        )
        yield* Effect.promise(() => entry.sb.kill()).pipe(Effect.ignore)
        yield* Effect.promise(() => entry.sb.close()).pipe(Effect.ignore)
      })

    const createSandbox = (sessionID: string) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("sandbox creating", { sessionID })
        const sb = yield* Effect.tryPromise({
          try: () =>
            Sandbox.create({
              connectionConfig,
              image: config.image,
              timeoutSeconds: config.timeoutSeconds,
              resource: config.resource,
            }),
          catch: (cause) =>
            new Error(`Sandbox.create failed: ${cause instanceof Error ? cause.message : String(cause)}`),
        })
        // No volume is attached, so the workspace directory must exist before
        // the first command can cd into it.
        yield* Effect.promise(() => commandsOf(sb).run("mkdir -p /workspace")).pipe(Effect.ignore)
        yield* Effect.logInfo("sandbox created", { sessionID, sandboxID: sb.id })
        return sb
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(CREATE_TIMEOUT_SECONDS),
          orElse: () =>
            Effect.fail(new Error(`Sandbox create timed out after ${CREATE_TIMEOUT_SECONDS}s: ${sessionID}`)),
        }),
        Effect.withSpan("SandboxProvider.createSandbox"),
      )

    const getOrCreate = (sessionID: string) =>
      Effect.gen(function* () {
        const myToken = yield* Deferred.make<Sandbox, Error>()
        const winner = yield* Ref.modify(creates, (map) => {
          const existing = map.get(sessionID)
          if (existing) return [existing, map] as const
          return [myToken, map.set(sessionID, myToken)] as const
        })
        if (winner !== myToken) return yield* Deferred.await(winner).pipe(Effect.orDie)

        const sb = yield* Effect.gen(function* () {
          const entry = yield* Ref.modify(entries, (map) => [map.get(sessionID) ?? null, map] as const)
          if (!entry) return yield* createSandbox(sessionID)
          const healthy = yield* Effect.promise(() => entry.sb.isHealthy()).pipe(
            Effect.catchCause(() => Effect.succeed(false)),
          )
          if (healthy) return entry.sb
          yield* Effect.logWarning("sandbox unhealthy, rebuilding", { sessionID })
          yield* destroySandbox(sessionID)
          return yield* createSandbox(sessionID)
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Ref.modify(creates, (map) => {
                map.delete(sessionID)
                return [undefined, map] as const
              })
              yield* Deferred.fail(myToken, new Error("Sandbox creation failed")).pipe(
                Effect.ignore,
              )
              return yield* Effect.failCause(cause)
            }),
          ),
        )

        yield* Ref.modify(creates, (map) => {
          map.delete(sessionID)
          return [undefined, map] as const
        })
        yield* Deferred.succeed(myToken, sb)
        return sb
      }).pipe(Effect.orDie)

    const commandSession = (sessionID: string, sb: Sandbox) =>
      Effect.gen(function* () {
        const existing = yield* Ref.modify(entries, (map) => [map.get(sessionID)?.commandSessionID ?? "", map] as const)
        if (existing) return existing
        const id = yield* Effect.tryPromise({
          try: () => commandsOf(sb).createSession({ workingDirectory: SandboxPath.WORKDIR }),
          catch: (cause) => new Error(`Sandbox command session failed: ${String(cause)}`),
        })
        yield* Ref.modify(entries, (map) => {
          const current = map.get(sessionID)
          if (current && !current.commandSessionID) map.set(sessionID, { ...current, commandSessionID: id })
          return [undefined, map] as const
        })
        return id
      })

    return Service.of({
      enabled: true,

      run: (input) =>
        Effect.gen(function* () {
          const sb = yield* getOrCreate(input.sessionID)
          const commands = commandsOf(sb)
          const commandSessionID = yield* commandSession(input.sessionID, sb)
          const workingDirectory = input.cwd
            ? SandboxPath.toSandboxCwd(input.cwd, input.hostWorkdir)
            : SandboxPath.WORKDIR
          const timeoutMs = input.timeoutMs ?? 0
          const timeoutSeconds = timeoutMs > 0 ? Math.ceil(timeoutMs / 1000) : 0

          const controller = new AbortController()
          const stdout: string[] = []
          const stderr: string[] = []
          let errorValue: string | undefined
          let exitCode: number | null = null
          let completed = false

          const consume = Effect.promise(async () => {
            for await (const event of commands.runInSessionStream(
              commandSessionID,
              input.command,
              { workingDirectory, ...(timeoutSeconds > 0 ? { timeoutSeconds } : {}) },
              controller.signal,
            )) {
              switch (event.type) {
                case "stdout":
                  stdout.push(event.text ?? "")
                  break
                case "stderr":
                  stderr.push(event.text ?? "")
                  break
                case "error":
                  errorValue = String(event.error?.evalue ?? event.error?.value ?? "")
                  return
                case "execution_complete":
                  if (errorValue === undefined) exitCode = 0
                  completed = true
                  return
              }
            }
          })

          let timedOut = false
          const guarded =
            timeoutSeconds > 0
              ? consume.pipe(
                  Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
                  Effect.timeoutOrElse({
                    duration: Duration.seconds(timeoutSeconds + 15),
                    orElse: () =>
                      Effect.gen(function* () {
                        timedOut = true
                        yield* Effect.promise(() => commands.interrupt(commandSessionID)).pipe(Effect.ignore)
                      }),
                  }),
                )
              : consume.pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
          yield* guarded

          if (timedOut) {
            const partial = [stdout.join(""), stderr.join("")].filter((part) => part.length > 0).join("\n")
            return {
              exitCode: null,
              output: `${partial}\n\nCommand exceeded timeout of ${timeoutMs} ms.`,
              timedOut: true,
            } satisfies ExecutionResult
          }
          if (errorValue !== undefined && /^-?\d+$/.test(errorValue.trim())) exitCode = Number(errorValue.trim())
          void completed
          return {
            exitCode,
            output: [stdout.join(""), stderr.join("")].filter((part) => part.length > 0).join("\n"),
            timedOut: false,
          } satisfies ExecutionResult
        }).pipe(Effect.withSpan("SandboxProvider.run")),

      interrupt: (sessionID) =>
        Effect.gen(function* () {
          const entry = yield* Ref.modify(entries, (map) => [map.get(sessionID) ?? null, map] as const)
          if (!entry?.commandSessionID) return
          yield* Effect.promise(() => commandsOf(entry.sb).interrupt(entry.commandSessionID)).pipe(Effect.ignore)
        }),

      destroy: (sessionID) => destroySandbox(sessionID),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
