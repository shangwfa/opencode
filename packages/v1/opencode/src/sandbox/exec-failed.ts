export * as ExecFailed from "./exec-failed"

import path from "path"
import { Effect, Schema } from "effect"
import type { Sandbox } from "@alibaba-group/opensandbox"
import { SANDBOX_WORKDIR } from "@/tool/sandbox-path"
import { GlobalBus } from "@/bus/global"
import type { SandboxProvider } from "@/tool/sandbox-provider"
import { SessionID } from "@/session/schema"

/**
 * Bus event emitted when a sandbox exec command fails (non-zero exit or matched
 * error pattern). Consumed by the exec-repair listener to drive the main session
 * agent into a self-repair loop.
 *
 * Published via GlobalBus so the global repair listener can route by `directory`
 * and re-enter the owning instance context.
 */
export const Event = Schema.Struct({
  sessionID: Schema.String,
  execId: Schema.String,
  command: Schema.String,
  workingDirectory: Schema.optional(Schema.String),
  /** Host directory owning the sandbox workspace. Used to route to the right instance. */
  directory: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
  status: Schema.Literals(["failed", "timed_out", "killed"]),
  /** Sandbox-internal absolute path of the saved full output log. */
  outputPath: Schema.String,
  /** Host absolute path of the saved full output log (workspace-mapped). */
  hostOutputPath: Schema.String,
  /** Tail of stdout/stderr used as a compact failure hint for the agent. */
  errorSummary: Schema.String,
})
export type Event = typeof Event.Type

export const EVENT_TYPE = "server.sandbox.exec.failed"
export const LOG_DIR_REL = ".opencode/exec-logs"
export const SANDBOX_LOG_DIR = path.posix.join(SANDBOX_WORKDIR, LOG_DIR_REL)

/** Host workspace dir -> host path of the exec log file. */
export function hostOutputPath(hostWorkdir: string, execId: string) {
  return path.join(hostWorkdir, LOG_DIR_REL, `${execId}.log`)
}

/** Sandbox-internal absolute path of the exec log file. */
export function sandboxOutputPath(execId: string) {
  return path.posix.join(SANDBOX_LOG_DIR, `${execId}.log`)
}

// Built-in error patterns. Case-insensitive substring match against combined
// stdout+stderr. Conservative: tuned for real runtime/compile failures while
// avoiding benign stderr noise.
const ERROR_PATTERNS: readonly RegExp[] = [
  /\berror\b/i,
  /\bexception\b/i,
  /\btraceback\b/i,
  /\bfailed\b/i,
  /\bfatal\b/i,
  /\bnot found\b/i,
  /\bno such file or directory\b/i,
  /\bcommand not found\b/i,
  /\bcannot find module\b/i,
  /\bout of memory\b/i,
  /\bsegmentation fault\b/i,
  /\bbus error\b/i,
  /\bpermission denied\b/i,
  /\bundefined is not/i,
  /\bis not defined\b/i,
  /\bpanic\b/i,
  /\btimeout\b/i,
  /\bexit code [1-9]/i,
  /\bE[A-Z]+\b/, // Node.js syscall errors: EADDRINUSE, EACCES, ENOENT, ...
]

export interface Detection {
  readonly failed: boolean
  readonly errorSummary: string
}

/** Builds the compact failure summary shown to the agent (last ~4KB of output). */
export function summarize(output: string): string {
  const MAX = 4096
  const trimmed = output.trimEnd()
  if (trimmed.length <= MAX) return trimmed
  return `...[truncated]...\n${trimmed.slice(-MAX)}`
}

/** Decides whether a finished exec is a repairable failure and extracts a summary. */
export function detect(input: {
  exitCode: number | null
  status: "failed" | "timed_out" | "killed" | "completed" | "running"
  stdout: string
  stderr: string
}): Detection {
  const combined = `${input.stdout}\n${input.stderr}`
  if (input.status === "completed" && input.exitCode === 0) {
    return { failed: false, errorSummary: "" }
  }
  // Non-zero / abnormal exit is necessary; error-pattern match avoids firing on
  // benign non-zero exits (e.g. grep no-match).
  const abnormalExit = input.exitCode !== null && input.exitCode !== 0
  const abnormalStatus = input.status !== "completed" && input.status !== "running"
  if (!abnormalExit && !abnormalStatus) return { failed: false, errorSummary: "" }

  const matched = ERROR_PATTERNS.some((re) => re.test(combined))
  if (!matched) return { failed: false, errorSummary: "" }
  return { failed: true, errorSummary: summarize(combined) }
}

/**
 * Publish the exec-failed event on the global bus. Pure side effect; safe to
 * call from any (global) server context such as the raw sandbox-proxy router.
 */
export function publish(event: Event) {
  GlobalBus.emit("event", {
    directory: event.directory,
    payload: {
      type: EVENT_TYPE,
      properties: event,
    },
  })
}

/**
 * Writes the full exec output (stdout + stderr) into a single log file inside
 * the sandbox workspace. Uses createDirectories + writeFiles so it works without
 * an append API. The host-mapped path is returned so the agent can grep/read it.
 */
export function writeLog(input: {
  sb: Sandbox
  execId: string
  stdout: string
  stderr: string
}): Effect.Effect<{ sandboxPath: string; hostPath: string } | null> {
  const sandboxPath = sandboxOutputPath(input.execId)
  const content = [
    "# exec output",
    "",
    "## stdout",
    input.stdout,
    "",
    "## stderr",
    input.stderr,
    "",
  ].join("\n")
  return Effect.gen(function* () {
    const written = yield* Effect.tryPromise({
      try: async () => {
        await input.sb.files.createDirectories([{ path: SANDBOX_LOG_DIR }])
        await input.sb.files.writeFiles([{ path: sandboxPath, data: content, mode: 0o644 }])
      },
      catch: () => new Error("writeLog failed"),
    }).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    )
    if (!written) return null
    return { sandboxPath, hostPath: "" }
  })
}

export interface FailInput {
  provider: SandboxProvider.Interface
  rootID: string
  directory: string
  execId: string
  command: string
  workingDirectory?: string
  exitCode: number | null
  status: "failed" | "timed_out" | "killed" | "completed" | "running"
  stdout: string
  stderr: string
}

/**
 * Orchestrates the self-repair trigger for one finished exec: detects a
 * repairable failure, resolves the sandbox, writes the full output to it, and
 * publishes the global event. Never throws — repair is best-effort alongside
 * the exec result. Callers pass the provider; sb resolution stays internal.
 */
export function maybeTrigger(input: FailInput): Effect.Effect<void> {
  return Effect.gen(function* () {
    const detection = detect({
      exitCode: input.exitCode,
      status: input.status,
      stdout: input.stdout,
      stderr: input.stderr,
    })
    if (!detection.failed) return

    const sb = yield* input.provider.get(SessionID.make(input.rootID)).pipe(Effect.catch(() => Effect.succeed(null)))
    let sandboxPath = ""
    let hostPath = hostOutputPath(input.directory, input.execId)
    if (sb) {
      const written = yield* writeLog({
        sb,
        execId: input.execId,
        stdout: input.stdout,
        stderr: input.stderr,
      })
      if (written) {
        sandboxPath = written.sandboxPath
        hostPath = written.hostPath || hostPath
      }
    }

    publish({
      sessionID: input.rootID,
      execId: input.execId,
      command: input.command,
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
      directory: input.directory,
      exitCode: input.exitCode,
      status: input.status as "failed" | "timed_out" | "killed",
      outputPath: sandboxPath,
      hostOutputPath: hostPath,
      errorSummary: detection.errorSummary,
    })
  }).pipe(Effect.catch(() => Effect.void))
}
