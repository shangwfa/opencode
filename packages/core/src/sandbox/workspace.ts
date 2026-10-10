export * as SandboxWorkspace from "./workspace.js"

import { randomUUID } from "node:crypto"
import { Effect } from "effect"

interface Sandbox {
  readonly commands: {
    readonly run: (command: string) => Promise<{ readonly exitCode?: number | null; readonly error?: unknown }>
  }
}

class ReadinessCommandError extends Error {
  constructor(cause: unknown) {
    super("Workspace readiness command failed", { cause })
    this.name = "ReadinessCommandError"
  }
}

/** Check the filesystem, not only whether execd or the directory is present. */
export const ensureWritable = Effect.fn("SandboxWorkspace.ensureWritable")(function* (
  sandbox: Sandbox,
  initialize: boolean,
) {
  const probe = `/workspace/.opencode-ready-${randomUUID()}`
  const command = [
    "set -eu",
    `probe='${probe}'`,
    `trap 'rm -f "$probe"' EXIT`,
    ...(initialize ? ["mkdir -p /workspace"] : []),
    "test -d /workspace",
    `printf WORKSPACE_READY > "$probe"`,
    `test "$(cat "$probe")" = WORKSPACE_READY`,
    `rm -f "$probe"`,
    "trap - EXIT",
  ].join("; ")
  let result: Awaited<ReturnType<Sandbox["commands"]["run"]>> | undefined
  for (let attempt = 0; attempt < 8; attempt++) {
    const checked = yield* Effect.tryPromise({
      try: () => sandbox.commands.run(command),
      catch: (cause) => new ReadinessCommandError(cause),
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(new Error("Workspace readiness timed out")),
      }),
      Effect.result,
    )
    if (checked._tag === "Success") {
      result = checked.success
      break
    }
    // Sandbox creation may return just before its command transport is ready. Retry
    // only transport failures; a successful command reporting a non-writable
    // filesystem remains a fail-closed readiness result below.
    if (!(checked.failure instanceof ReadinessCommandError) || attempt === 7)
      return yield* Effect.fail(checked.failure)
    yield* Effect.sleep("250 millis")
  }
  if (!result) return yield* Effect.fail(new Error("Workspace readiness command failed"))
  if (result.exitCode !== 0 || result.error)
    return yield* Effect.fail(
      new Error(`Workspace is not writable (exit: ${result.exitCode ?? "unknown"})`, { cause: result.error }),
    )
})
