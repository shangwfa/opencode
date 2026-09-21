export * as SandboxOOM from "./sandbox-oom.js"

import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Schedule } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "./database/database.js"
import { Workspace } from "./workspace.js"
import { SessionID } from "@opencode/schema/session-id"
import { insert as insertExecLog } from "./exec-log/index.js"
import { recordSandboxEvent } from "./observability/metrics.js"
import { ChildProcess } from "effect/unstable/process"
import { Stream } from "effect"

const INTERVAL_SECONDS = Number(process.env.OPENCODE_SANDBOX_OOM_SCAN_INTERVAL_SEC) || 60
const ENABLED = !["0", "false", ""].includes(process.env.OPENCODE_SANDBOX_OOM_SCAN_ENABLED ?? "1")
const BATCH = 50
const PRESSURE_RATIO = 0.85
const PRESSURE_WINDOW_MS = 300_000
const SAMPLE_TIMEOUT_MS = 8_000

/**
 * Reads the sandbox cgroup OOM counter and memory watermark. cgroup v2 and v1
 * paths are probed per file (busybox awk stops at the first missing file, so
 * each metric uses its own cat/awk chain instead of multi-file arguments).
 */
export const SAMPLE_COMMAND = [
  `printf 'OOM='; awk '$1=="oom_kill"{print $2}' /sys/fs/cgroup/memory.events 2>/dev/null || awk '$1=="oom_kill"{print $2}' /sys/fs/cgroup/memory/memory.oom_control 2>/dev/null; true`,
  `printf 'USAGE='; cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null; true`,
  `printf 'LIMIT='; cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null; true`,
].join("\n")

export interface OomSample {
  readonly oom: number | null
  readonly usage: number | null
  readonly limit: number | null
}

const numberOr = (value: string | undefined): number | null => {
  if (value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseOomSample(stdout: string): OomSample {
  const oom = /^OOM=(\d+)$/m.exec(stdout)
  const usage = /^USAGE=(\d+)$/m.exec(stdout)
  const limit = /^LIMIT=(\d+)$/m.exec(stdout)
  return {
    oom: numberOr(oom?.[1]),
    usage: numberOr(usage?.[1]),
    limit: numberOr(limit?.[1]),
  }
}

export type OomVerdict =
  | { readonly action: "silent" }
  | { readonly action: "baseline" }
  | {
      readonly action: "oom"
      readonly delta: number
      readonly total: number
      readonly usage: number | null
      readonly limit: number | null
    }
  | {
      readonly action: "pressure"
      readonly pct: number
      readonly usage: number
      readonly limit: number
    }

/** A sane limit for the watermark check: "max" (v2 unlimited) parses to a huge number. */
const UNLIMITED_LIMIT = 1e15

export function classifyOomSample(input: {
  readonly sample: OomSample
  readonly previous: number | undefined
  readonly pressureWindowKey: number
}): OomVerdict {
  const { sample, previous } = input
  if (sample.oom === null) return { action: "silent" }
  if (previous === undefined) return { action: "baseline" }
  const delta = sample.oom - previous
  if (delta < 0) return { action: "baseline" }
  if (delta > 0)
    return {
      action: "oom",
      delta,
      total: sample.oom,
      usage: sample.usage,
      limit: sample.limit,
    }
  const usage = sample.usage ?? null
  const limit = sample.limit ?? null
  if (usage !== null && limit !== null && limit > 0 && limit < UNLIMITED_LIMIT && usage / limit >= PRESSURE_RATIO) {
    return { action: "pressure", pct: Math.round((usage / limit) * 100), usage, limit }
  }
  return { action: "silent" }
}

export interface Interface {
  readonly scanOnce: Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SandboxOOM") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const workspace = yield* Workspace.Service
    const baseline = new Map<string, number>()
    const pressureBucket = new Map<string, number>()
    const nowBucket = () => Math.floor(Date.now() / PRESSURE_WINDOW_MS)

    const scanOnce: Effect.Effect<number> = Effect.gen(function* () {
      const rows = (yield* db
        .all<{ readonly id: string; readonly sandbox_id: string; readonly session_id: string }>(sql`
          select w.id, w.binding::jsonb->>'sandboxId' as sandbox_id,
                 (select s.id from session s where s.workspace_id = w.id limit 1) as session_id
          from workspace w
          where w.binding is not null
          order by w.last_used_at desc
          limit ${BATCH}
        `)
        .pipe(Effect.orDie)) as ReadonlyArray<{
        readonly id: string
        readonly sandbox_id: string
        readonly session_id: string | null
      }>
      let attributable = 0
      yield* Effect.logInfo("oom scan cycle", { candidates: rows.length })
      for (const row of rows) {
        if (row.session_id === null) continue
        const sampled = yield* workspace.sample(
          Workspace.ID.make(row.id),
          SAMPLE_COMMAND,
          SAMPLE_TIMEOUT_MS,
        )
        if (sampled === undefined) {
          yield* Effect.logInfo("oom scan skip (no connection)", { workspaceID: row.id })
          continue
        }
        const stdout = sampled.stdout
        const sample = parseOomSample(stdout)
        if (sample.oom === null) {
          yield* Effect.logInfo("oom scan null sample", { workspaceID: row.id, stdout: stdout.slice(0, 100) })
          continue
        }
        yield* Effect.logInfo("oom scan sample", { workspaceID: row.id, oom: sample.oom, usage: sample.usage, limit: sample.limit })
        const key = `${row.id}\u0000${row.sandbox_id}`
        const verdict = classifyOomSample({
          sample,
          previous: baseline.get(key),
          pressureWindowKey: pressureBucket.get(key) ?? -1,
        })
        if (verdict.action === "baseline" || verdict.action === "oom") baseline.set(key, sample.oom)
        if (verdict.action === "oom") {
          attributable += 1
          yield* insertExecLog({
            id: `oom-${row.id}-${row.sandbox_id}-${verdict.total}`,
            session_id: SessionID.make(row.session_id),
            command: `sandbox-oom-scan oom_kill_total=${verdict.total} delta=${verdict.delta}`,
            status: "failed",
            error: JSON.stringify({
              name: "SandboxOOM",
              oomKillDelta: verdict.delta,
              oomKillTotal: verdict.total,
              usageBytes: verdict.usage,
              limitBytes: verdict.limit,
            }),
            source: "sandbox-oom",
            time_started: Date.now(),
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          yield* recordSandboxEvent("oom")
          yield* Effect.logWarning("sandbox OOM detected", {
            workspaceID: row.id,
            delta: verdict.delta,
            total: verdict.total,
          })
        }
        if (verdict.action === "pressure") {
          const bucket = nowBucket()
          if ((pressureBucket.get(key) ?? -1) === bucket) continue
          pressureBucket.set(key, bucket)
          yield* insertExecLog({
            id: `oom-pressure-${row.id}-${row.sandbox_id}-${bucket}`,
            session_id: SessionID.make(row.session_id),
            command: `memory-pressure pct=${verdict.pct}%`,
            status: "completed",
            error: JSON.stringify({
              name: "MemoryPressure",
              usageBytes: verdict.usage,
              limitBytes: verdict.limit,
              pct: verdict.pct,
            }),
            source: "sandbox-oom",
            time_started: Date.now(),
            time_created: Date.now(),
            time_updated: Date.now(),
          })
        }
      }
      return rows.length
    })

    if (ENABLED) {
      yield* scanOnce.pipe(
        Effect.repeat(Schedule.spaced(`${INTERVAL_SECONDS} seconds`)),
        Effect.catchCause((cause) => Effect.logWarning("oom scan failed", cause)),
        Effect.andThen(Effect.void),
        Effect.forkScoped,
      )
      yield* Effect.logInfo("oom scan task started", { intervalSeconds: INTERVAL_SECONDS })
    }
    return Service.of({ scanOnce })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Workspace.node] })
