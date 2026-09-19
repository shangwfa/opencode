export * as AntiLoop from "./anti-loop.js"

export type Signal = "repeat" | "fail" | "reblocked"

export type Verdict =
  | { action: "allow" }
  | {
      action: "block"
      fatal: boolean
      signal: Signal
      tool: string
      count: number
      threshold: number
      reason: string
    }

interface Entry {
  fp: string
  tool: string
  ok: boolean
}

export interface Detector {
  check(tool: string, args: Record<string, unknown>): Verdict
  record(tool: string, args: Record<string, unknown>, ok: boolean): void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }
  const json = JSON.stringify(value)
  return json === undefined ? "null" : json
}

const fingerprint = (tool: string, args: Record<string, unknown>) => `${tool}\u0000${stableStringify(args)}`

/**
 * Per-run doom-loop detector (v1 anti-loop parity): a sliding window of
 * `(tool, stableStringify(args))` fingerprints plus a per-tool consecutive
 * failure count. The third identical call within the window is blocked with a
 * guiding reason (the model can recover by changing arguments); re-issuing a
 * blocked call is fatal and stops the run. State is pure memory scoped to one
 * run, so legitimate repeated work in later prompts starts fresh.
 */
export function make(input?: {
  repeats?: number
  fails?: number
  window?: number
}): Detector {
  // Clamp so a bad value can never brick the agent (threshold 1 would block every call).
  const repeats = Math.max(2, Math.trunc(input?.repeats ?? 3))
  const fails = Math.max(2, Math.trunc(input?.fails ?? 3))
  const windowSize = Math.max(Math.max(repeats, fails), Math.trunc(input?.window ?? 10))
  let entries: Entry[] = []
  const blocked = new Set<string>()
  const consecutiveFails: Record<string, number> = {}

  return {
    check(tool, args) {
      const fp = fingerprint(tool, args)
      if (blocked.has(fp)) {
        return {
          action: "block",
          fatal: true,
          signal: "reblocked",
          tool,
          count: repeats + 1,
          threshold: repeats,
          reason:
            `This session run is aborted: you re-issued the exact "${tool}" call that was just blocked as a ` +
            `repeated no-progress loop. Re-issuing blocked calls is not allowed. When a call is blocked you must ` +
            `change your approach instead of repeating it.`,
        }
      }
      const seen = entries.filter((entry) => entry.fp === fp).length
      if (seen >= repeats - 1) {
        blocked.add(fp)
        return {
          action: "block",
          fatal: false,
          signal: "repeat",
          tool,
          count: seen + 1,
          threshold: repeats,
          reason:
            `This tool call was blocked because it is a repeated no-progress loop: the same "${tool}" call with ` +
            `identical arguments has already run ${seen} time${seen === 1 ? "" : "s"} within the last ${windowSize} ` +
            `tool calls. Repeating identical calls wastes tokens and will not change the result. Change your ` +
            `approach: use different arguments or a different tool, or explain what is blocking progress.`,
        }
      }
      const failCount = consecutiveFails[tool] ?? 0
      if (failCount >= fails) {
        // Blocked calls never execute, so the counter would stay frozen at the
        // threshold forever. Reset it: retrying with *changed* arguments after
        // the block reason is a legitimate recovery path; re-issuing the exact
        // same (tool, args) is still caught by the blocked-signature fatal above.
        consecutiveFails[tool] = 0
        blocked.add(fp)
        return {
          action: "block",
          fatal: false,
          signal: "fail",
          tool,
          count: failCount,
          threshold: fails,
          reason:
            `This tool call was blocked because "${tool}" has failed ${failCount} times in a row. Blindly retrying ` +
            `the same failing tool will not help. Read the previous error messages carefully, fix the root cause, ` +
            `or switch to a different approach.`,
        }
      }
      return { action: "allow" }
    },
    record(tool, args, ok) {
      entries.push({ fp: fingerprint(tool, args), tool, ok })
      if (entries.length > windowSize) entries = entries.slice(-windowSize)
      consecutiveFails[tool] = ok ? 0 : (consecutiveFails[tool] ?? 0) + 1
    },
  }
}

/** Marker metadata attached to blocked tool results, for diagnostics. */
export const blockedMetadata = (verdict: Extract<Verdict, { action: "block" }>) => ({
  antiLoop: { signal: verdict.signal, count: verdict.count, threshold: verdict.threshold },
})
