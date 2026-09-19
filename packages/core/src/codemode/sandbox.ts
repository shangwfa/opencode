export * as CodeModeSandbox from "./sandbox.js"

import type { CodeMode } from "@opencode/codemode"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { EnvironmentService } from "../environment/environment.js"
import type { Files } from "../environment/files.js"

/** One tool the sandboxed program may call, routed back to the host over the bridge. */
export interface CatalogEntry {
  readonly path: string
  readonly description: string
}

/** Host-side handlers for one sandboxed execution. */
export interface Bridge {
  /** Invoked when the program starts a tool call, with the decoded request input. */
  readonly onStart?: ((tool: string, input: unknown) => Effect.Effect<void>) | undefined
  /** Invoked after the host answered a tool call; `ok` is false when the call failed. */
  readonly onEnd?: ((tool: string, ok: boolean) => Effect.Effect<void>) | undefined
  /** Executes the named tool host-side; the returned value crosses back as JSON. */
  readonly call: (tool: string, input: unknown) => Effect.Effect<unknown, unknown>
}

export class SandboxError extends Schema.TaggedError<SandboxError>()("CodeModeSandbox.Error", {
  message: Schema.String,
}) {}

export interface Interface {
  /** Runs one Code Mode program inside this location's sandbox workspace. */
  readonly run: (input: {
    readonly code: string
    readonly limits?: CodeMode.ExecutionLimits
    readonly tools: ReadonlyArray<CatalogEntry>
    readonly bridge: Bridge
  }) => Effect.Effect<CodeMode.Result, SandboxError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodeModeSandbox") {}

// Install path of the bundled agent (see `@opencode/codemode`'s build script output).
const AGENT_PATH = process.env["OPENCODE_CODEMODE_AGENT"] ?? "/opt/opencode-codemode/agent.mjs"

const textBytes = new TextEncoder()
const toSandboxError = (cause: unknown): SandboxError =>
  cause instanceof SandboxError
    ? cause
    : new SandboxError({
        message: cause instanceof Error ? cause.message : `Code Mode sandbox failure: ${String(cause)}`,
      })
const notify = (effect: Effect.Effect<void> | undefined) => effect ?? Effect.void

const removeDir = (files: Files, dir: string) =>
  Effect.gen(function* () {
    const entries = yield* Effect.orElseSucceed(files.list(dir), () => [])
    for (const entry of entries) yield* Effect.ignore(files.remove(`${dir}/${entry.name}`))
    yield* Effect.ignore(files.remove(dir))
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const environment = yield* EnvironmentService.Service
    const files = environment.files

    const run = (input: Parameters<Interface["run"]>[0]): Effect.Effect<CodeMode.Result, SandboxError> =>
      Effect.gen(function* () {
        const dir = `/tmp/opencode-codemode-${globalThis.crypto.randomUUID()}`
        return yield* Effect.acquireUseRelease(
          Effect.gen(function* () {
            yield* files.mkdir(dir)
            yield* files.write(
              `${dir}/options.json`,
              textBytes.encode(JSON.stringify({ code: input.code, limits: input.limits, tools: input.tools })),
            )
            return yield* environment.spawner.spawn(
              ChildProcess.make("node", [AGENT_PATH], {
                env: { OPENCODE_CODEMODE_DIR: dir },
                extendEnv: false,
              }),
            )
          }),
          (shell) => supervise(shell, files, dir, input),
          (shell) => Effect.ignore(shell.kill()).pipe(Effect.andThen(removeDir(files, dir))),
        ).pipe(Effect.scoped)
      }).pipe(Effect.catch((cause) => Effect.fail(toSandboxError(cause))))

    return Service.of({ run })
  }),
)

interface AgentHandle {
  readonly stdout: Stream.Stream<Uint8Array, unknown>
  readonly exitCode: Effect.Effect<number, unknown>
}

/** Consumes the agent's stdout protocol until it reports done or the stream ends. */
const supervise = (
  shell: AgentHandle,
  files: Files,
  dir: string,
  input: Parameters<Interface["run"]>[0],
): Effect.Effect<CodeMode.Result, unknown> =>
  Effect.gen(function* () {
    let buffer = ""
    let final: Option.Option<CodeMode.Result> = Option.none()
    yield* Stream.decodeText(shell.stdout).pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          buffer += chunk
          let index = buffer.indexOf("\n")
          while (index !== -1) {
            const line = buffer.slice(0, index).trim()
            buffer = buffer.slice(index + 1)
            index = buffer.indexOf("\n")
            if (line.startsWith("@req ")) {
              const request = JSON.parse(line.slice("@req ".length)) as { id: number; tool: string; input: unknown }
              yield* notify(input.bridge.onStart?.(request.tool, request.input))
              const outcome = yield* input.bridge.call(request.tool, request.input).pipe(
                Effect.map((value) => ({ value })),
                Effect.catch((error) =>
                  Effect.succeed({ __error: error instanceof Error ? error.message : String(error) }),
                ),
              )
              // The rename makes the response atomic for the agent's poll loop.
              const temp = `${dir}/resp-${request.id}.tmp`
              yield* files.write(temp, textBytes.encode(JSON.stringify(outcome)))
              yield* files.move(temp, `${dir}/resp-${request.id}.json`)
              yield* notify(input.bridge.onEnd?.(request.tool, !("__error" in outcome)))
            } else if (line.startsWith("@done ")) {
              final = Option.some(JSON.parse(line.slice("@done ".length)) as CodeMode.Result)
            }
          }
        }),
      ),
    )
    const exit = yield* shell.exitCode
    if (Option.isNone(final)) {
      return yield* new SandboxError({
        message: `Code Mode agent exited with code ${exit} without producing a result.`,
      })
    }
    return final.value
  })

export const node = makeLocationNode({ service: Service, layer, deps: [EnvironmentService.node] })
