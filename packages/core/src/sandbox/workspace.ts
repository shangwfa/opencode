export * as SandboxWorkspace from "./workspace.js"

import { randomUUID } from "node:crypto"
import { Effect } from "effect"

interface Sandbox {
  readonly commands: {
    readonly run: (command: string) => Promise<{ readonly exitCode?: number | null; readonly error?: unknown }>
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
  const result = yield* Effect.tryPromise({
    try: () => sandbox.commands.run(command),
    catch: (cause) => new Error("Workspace readiness command failed", { cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () => Effect.fail(new Error("Workspace readiness timed out")),
    }),
  )
  if (result.exitCode !== 0 || result.error)
    return yield* Effect.fail(
      new Error(`Workspace is not writable (exit: ${result.exitCode ?? "unknown"})`, { cause: result.error }),
    )
})
