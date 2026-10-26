export * as SandboxOomSample from "./oom-sample.js"

import { Effect } from "effect"

/**
 * Periodic OOM sampling for running session sandboxes (V2 port of the V1
 * sandbox-oom scan). A sampler executes this command inside each sandbox,
 * parses the cgroup counters, and classifies the delta against the previous
 * sample. Results are surfaced as durable session events
 * (`session.sandbox.oom` / `session.sandbox.pressure`) so operators can read
 * them from the session log instead of container logs.
 *
 * The command must stay cgroup v1/v2 compatible and must avoid passing two
 * files to one awk/cat invocation: busybox awk reads only the first file and
 * silently drops the second, so each fallback is a separate `||` probe.
 */
export const OOM_SAMPLE_COMMAND = [
  `printf 'OOM='; awk '$1=="oom_kill"{print $2; exit}' /sys/fs/cgroup/memory.events 2>/dev/null || awk '$1=="oom_kill"{print $2; exit}' /sys/fs/cgroup/memory/memory.oom_control 2>/dev/null || true`,
  `printf 'USAGE='; cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null || true`,
  `printf 'LIMIT='; cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true`,
].join("\n")

export type OomSample = {
  readonly oomKill: number | null
  readonly usageBytes: number | null
  readonly limitBytes: number | null
}

/**
 * Parse the `KEY=VALUE` markers from the sample command output. The command's
 * transport streams stdout as text chunks and may strip the newlines between
 * the printf segments, so the three markers can arrive concatenated on one
 * line ("OOM=0USAGE=9252864LIMIT=…"). Markers are therefore matched globally
 * instead of line-by-line; the first occurrence of each key wins (the command
 * itself already collapses per-key fallbacks with `||` chains). An absent or
 * non-numeric value stays `null`. A cgroup v2 unlimited limit (`max`) and a
 * cgroup v1 sentinel limit (a huge number) are both kept as raw numbers —
 * classification treats implausibly large limits as unlimited.
 */
export function parseOomSample(stdout: string): OomSample {
  const values = new Map<string, number>()
  for (const match of stdout.matchAll(/(?<![A-Z=])(OOM|USAGE|LIMIT)=(\d+)(?![\d.a-z])/g)) {
    const key = match[1]
    if (!values.has(key)) values.set(key, Number(match[2]))
  }
  return {
    oomKill: values.has("OOM") ? (values.get("OOM") as number) : null,
    usageBytes: values.has("USAGE") ? (values.get("USAGE") as number) : null,
    limitBytes: values.has("LIMIT") ? (values.get("LIMIT") as number) : null,
  }
}

const UNLIMITED_LIMIT_BYTES = 1 << 46

export type OomClassification =
  | { readonly kind: "none" }
  | {
      readonly kind: "oom"
      readonly oomKillDelta: number
      readonly oomKillTotal: number
      readonly usageBytes: number | null
      readonly limitBytes: number | null
    }
  | {
      readonly kind: "pressure"
      readonly pct: number
      readonly usageBytes: number
      readonly limitBytes: number
    }

export type ClassifyInput = {
  readonly sessionID: string
  readonly sandboxID: string
  readonly prev: OomSample | undefined
  readonly sample: OomSample
  readonly now: number
  readonly pressureRatio?: number
  readonly pressureWindowMs?: number
}

/**
 * Delta classification against the previous sample:
 * - first round (no baseline) only establishes the baseline, even if the
 *   counter already reflects historical kills;
 * - a positive `oom_kill` delta is an OOM attribution (`oom` wins over
 *   pressure when both hold);
 * - a negative delta means the sandbox was rebuilt with a fresh counter —
 *   silently reset the baseline;
 * - without an OOM, memory usage at or above the ratio threshold (default
 *   85% of the limit) is a pressure warning, deduplicated per window
 *   (default 5 minutes) by the caller's event throttling.
 */
export function classifyOomSample(input: ClassifyInput): OomClassification {
  const { prev, sample } = input
  if (prev === undefined) return { kind: "none" }
  if (sample.oomKill !== null && prev.oomKill !== null) {
    const delta = sample.oomKill - prev.oomKill
    if (delta > 0)
      return {
        kind: "oom",
        oomKillDelta: delta,
        oomKillTotal: sample.oomKill,
        usageBytes: sample.usageBytes,
        limitBytes: sample.limitBytes,
      }
    if (delta < 0) return { kind: "none" }
  }
  const ratio = input.pressureRatio ?? 0.85
  const usage = sample.usageBytes
  const limit = sample.limitBytes
  if (usage === null || limit === null || limit <= 0 || limit >= UNLIMITED_LIMIT_BYTES) return { kind: "none" }
  if (usage / limit >= ratio) {
    return {
      kind: "pressure",
      pct: Math.round((usage / limit) * 100),
      usageBytes: usage,
      limitBytes: limit,
    }
  }
  return { kind: "none" }
}

/** Minimal command-surface the sampler needs; satisfied by the SDK sandbox commands namespace. */
export type SamplerCommands = {
  createSession(options?: { workingDirectory?: string }): Promise<string>
  deleteSession(sessionId: string): Promise<void>
  runInSessionStream(
    sessionId: string,
    command: string,
    options?: { workingDirectory?: string; timeoutSeconds?: number },
    signal?: AbortSignal,
  ): AsyncIterable<{ type: string; text?: string }>
}

/**
 * Run the sample command in a throwaway command session and parse its stdout.
 * The ephemeral session is deleted even on failure and the execution never
 * touches the sandbox heartbeat, so sampling cannot keep an idle sandbox
 * alive past its reap window.
 */
export const sampleSandbox = (
  commands: SamplerCommands,
  timeoutSeconds = 8,
  workingDirectory = "/workspace",
): Effect.Effect<OomSample, Error> =>
  Effect.gen(function* () {
    const sessionID = yield* Effect.tryPromise({
      try: () => commands.createSession({ workingDirectory }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    })
    const stdout: string[] = []
    yield* Effect.tryPromise({
      try: async () => {
        for await (const event of commands.runInSessionStream(
          sessionID,
          OOM_SAMPLE_COMMAND,
          { workingDirectory, timeoutSeconds },
        )) {
          if (event.type === "stdout") stdout.push(event.text ?? "")
          // Drain until the session reports completion so the output is whole.
          if (event.type === "execution_complete" || event.type === "error") return
        }
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => commands.deleteSession(sessionID)).pipe(Effect.ignore, Effect.catch(() => Effect.void)),
      ),
    )
    return parseOomSample(stdout.join(""))
  })
