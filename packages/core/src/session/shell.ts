export * as SessionShell from "./shell.js"

import type { Session } from "@opencode/schema/session"
import { Shell as ShellSchema } from "@opencode/schema/shell"
import { Deferred, Effect } from "effect"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import { SandboxProvider } from "../sandbox/provider.js"
import { Shell } from "../shell.js"
import { ShellResult } from "../shell/result.js"

const sandboxed = Effect.fn("SessionShell.sandboxed")(function* (input: {
  session: Session.Info
  command: string
  timeoutSeconds?: number
}) {
  const provider = yield* SandboxProvider.Service
  if (!provider.enabled) return null
  const id = ShellSchema.ID.create()
  const info: ShellSchema.Info = {
    id,
    status: "running",
    command: input.command,
    cwd: input.session.location.directory,
    shell: "bash",
    file: `sandbox://${id}`,
    metadata: { sessionID: input.session.id, background: true },
    time: { started: Date.now() },
  }
  const settled = yield* Deferred.make<ShellResult.Result>()
  const execution = provider
    .run({
      sessionID: input.session.id,
      command: input.command,
      hostWorkdir: input.session.location.directory,
      // The deadline covers queueing plus execution; the provider reports
      // timeouts as a distinct result and recycles the command session.
      timeoutMs: input.timeoutSeconds !== undefined ? input.timeoutSeconds * 1000 : undefined,
    })
    .pipe(
      Effect.map(
        (result): ShellResult.Result => ({
          info: {
            ...info,
            status: result.timedOut ? "timeout" : "exited",
            ...(result.exitCode !== null ? { exit: result.exitCode } : {}),
            time: { ...info.time, completed: Date.now() },
          },
          capture: { output: result.output, truncated: false },
        }),
      ),
      // Mirrors the V1 exec contract: a failed sandbox run still completes the
      // shell lifecycle with the failure text so the durable message and the
      // user notification close out instead of hanging on `running`.
      Effect.catch((error): Effect.Effect<ShellResult.Result> =>
        Effect.succeed({
          info: { ...info, status: "exited", time: { ...info.time, completed: Date.now() } },
          capture: { output: `Sandbox execution failed: ${error.message}`, truncated: false },
        }),
      ),
      Effect.tap((result) => Deferred.succeed(settled, result)),
    )
  Effect.runForkWith(yield* Effect.context<never>())(execution)
  const bytes = (result: ShellResult.Result) => {
    const size = Buffer.byteLength(result.capture?.output ?? "")
    return { output: result.capture?.output ?? "", cursor: size, size, truncated: false }
  }
  return {
    info,
    result: Deferred.await(settled),
    output: Deferred.await(settled).pipe(Effect.map(bytes)),
  }
})

export const start = Effect.fn("SessionShell.start")(function* (input: {
  session: Session.Info
  command: string
  timeoutSeconds?: number
}) {
  const instances = yield* Instance.Service
  // Sandboxed deployments must run user shell commands inside the session
  // sandbox; the local process path would write outside the /workspace view
  // the agent tools see and would leak host paths into the session.
  const viaSandbox = yield* Plugin.awaitActivation.pipe(
    Effect.andThen(sandboxed(input)),
    instances.provide(input.session),
  )
  if (viaSandbox) return viaSandbox
  const shell = yield* Plugin.awaitActivation.pipe(Effect.andThen(Shell.Service), instances.provide(input.session))
  const info = yield* shell.create({
    command: input.command,
    cwd: input.session.location.directory,
    timeout: input.timeoutSeconds !== undefined ? input.timeoutSeconds * 1000 : 0,
    metadata: { sessionID: input.session.id, background: true },
  })
  // Keep completion tied to the original shell even if the Session moves.
  return {
    info,
    result: shell.result(info),
    output: shell
      .output(info.id, { limit: 1024 * 1024 })
      .pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(ShellResult.unavailable))),
  }
})
