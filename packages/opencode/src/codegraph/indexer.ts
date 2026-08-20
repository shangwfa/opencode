import { Effect, Layer, Schedule, Context, Cause, Duration } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { eq } from "drizzle-orm"
import { gunzipSync } from "node:zlib"
import { Database, dialect } from "../storage/db"
import { SandboxTable } from "../tool/sandbox.pg"
import { resolveSandboxOpts } from "../session/sandbox-opts"
import { SandboxProvider } from "../tool/sandbox-provider"
import type { Sandbox } from "@alibaba-group/opensandbox"
import { CodegraphStore as S } from "./store"
import type { Scope } from "./store"

/**
 * Periodic indexer: every tick, scan running sandboxes, resolve each to an
 * appId scope (pvcMode is irrelevant — see codegraph.pg.ts), and either build
 * the full graph or apply the incremental diff.
 *
 * Runs inside the server pod; the sandbox only executes the extraction script
 * and hands back an ndjson snapshot over the files API — it never touches PG.
 *
 * State machine lives in codegraph_index (claim/heartbeat/zombie-reclaim are
 * store concerns); this service just picks up scopes that need work.
 */

const log = Log.create({ service: "codegraph-indexer" })

const EXEC_TIMEOUT_SECONDS = 900
const LOOP_INTERVAL = Duration.seconds(30)
const HEARTBEAT_EVERY_MS = 5000

// Extractors skip files over 1MB (MAX_FILE_SIZE) — they're never indexed, so
// they must not drive incremental changed/deleted decisions (a 23MB vendored
// parser.c would otherwise re-enter `changed` every cycle).
const MAX_INDEX_FILE_SIZE = 1024 * 1024

const ENGINE_VERSION = "codegraph-extractor-1"

// The extractor is baked into the sandbox image at /opt/codegraph-extractor
// (docker/Dockerfile COPY build/codegraph-extractor → /opt/codegraph-extractor),
// so no runtime injection is needed — every sandbox has it on boot.
const EXTRACTOR_DIR = "/opt/codegraph-extractor"
const INDEX_OUT = "/tmp/cg.ndjson.gz"
const STAT_OUT = "/tmp/cg-stats.ndjson"
const PROGRESS = "/tmp/cg-progress.json"

// ---------------------------------------------------------------------------
// Sandbox I/O helpers
// ---------------------------------------------------------------------------

const runCommand = async (sb: Sandbox, command: string) => {
  const execution = await sb.commands.run(command, { workingDirectory: "/workspace", timeoutSeconds: EXEC_TIMEOUT_SECONDS })
  if (execution.exitCode !== 0) {
    throw new Error(`extractor command failed (exit ${execution.exitCode}): ${command}`)
  }
  return execution
}

const readSandboxText = async (sb: Sandbox, path: string): Promise<string> => {
  try {
    const text = await (sb.files.readFile(path) as Promise<string>)
    return text ?? ""
  } catch {
    return ""
  }
}

const readNdjson = async <T extends { t: string }>(sb: Sandbox, path: string, gzipped: boolean): Promise<T[]> => {
  const chunks: Uint8Array[] = []
  for await (const c of sb.files.readBytesStream(path)) chunks.push(c)
  const buf = Buffer.concat(chunks)
  const text = gzipped ? new TextDecoder().decode(gunzipSync(buf)) : buf.toString("utf-8")
  const out: T[] = []
  for (const line of text.split("\n")) {
    if (line.trim()) out.push(JSON.parse(line) as T)
  }
  return out
}

// ---------------------------------------------------------------------------
// Snapshot parsing
// ---------------------------------------------------------------------------

const scopeRecords = (scope: Scope, rows: { t: string }[]): any[] => {
  const out: any[] = []
  for (const r of rows) {
    const { t: _t, ...rest } = r as any
    out.push({ ...rest, scope })
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-scope index run
// ---------------------------------------------------------------------------

const extract = (scope: Scope, sb: Sandbox, mode: "full" | "incremental", progressPath: string) =>
  Effect.gen(function* () {
    // Both full and incremental rebuilds run codegraph's OWN pipeline inside
    // the sandbox (node:sqlite + full resolver + framework resolvers) so ALL
    // edges — cross-file calls, route→handler, component usages, receiver-method
    // — are produced consistently with source available. node (not bun) is
    // required for node:sqlite.
    const cmd =
      mode === "incremental"
        ? `node ${EXTRACTOR_DIR}/main.ts full --root /workspace --out ${INDEX_OUT} --progress ${progressPath} --incremental`
        : `node ${EXTRACTOR_DIR}/main.ts full --root /workspace --out ${INDEX_OUT} --progress ${progressPath}`

    // Heartbeat must read progress FROM THE SANDBOX (not the server pod FS).
    yield* Effect.gen(function* () {
      yield* Effect.repeat(
        Effect.gen(function* () {
          const p = yield* Effect.tryPromise(() => readSandboxText(sb, progressPath)).pipe(
            Effect.catchCause(() => Effect.succeed("")),
          )
          let filesDone: number | undefined
          let filesTotal: number | undefined
          if (p) {
            try {
              const j = JSON.parse(p) as { files_done?: number; files_total?: number }
              filesDone = j.files_done
              filesTotal = j.files_total
            } catch {
              /* partial write */
            }
          }
          yield* Effect.tryPromise(() => S.heartbeat(scope, filesDone, filesTotal)).pipe(Effect.catchCause(() => Effect.void))
        }),
        { schedule: Schedule.spaced(Duration.millis(HEARTBEAT_EVERY_MS)) },
      ).pipe(Effect.forkScoped)
    }).pipe(Effect.scoped)

    yield* Effect.tryPromise(() => runCommand(sb, cmd))
    const rows = yield* Effect.tryPromise(() => readNdjson<any>(sb, INDEX_OUT, true))
    return {
      nodes: scopeRecords(scope, rows.filter((r) => r.t === "node")),
      edges: scopeRecords(scope, rows.filter((r) => r.t === "edge")),
      files: scopeRecords(scope, rows.filter((r) => r.t === "file")),
      refs: scopeRecords(scope, rows.filter((r) => r.t === "ref")),
    }
  })

const runFullIndex = (scope: Scope, sb: Sandbox) =>
  Effect.gen(function* () {
    const snap = yield* extract(scope, sb, "full", PROGRESS)
    yield* Effect.tryPromise(() => S.replaceGraph(scope, snap))
    return Effect.void
  })

type StatDiff = { changed: string[]; deleted: boolean; live: string[] }

const statDiff = (scope: Scope, sb: Sandbox) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => runCommand(sb, `bun ${EXTRACTOR_DIR}/main.ts stat --root /workspace --out ${STAT_OUT}`))
    const stats = yield* Effect.tryPromise(() =>
      readNdjson<{ t: "stat"; path: string; size: number; mtime_ms: number }>(sb, STAT_OUT, false),
    )
    const ledger = yield* Effect.tryPromise(() => S.listFileStats(scope))
    const byPath = new Map(ledger.map((f) => [f.path, f]))
    const live = new Set<string>()
    const changed: string[] = []
    let deleted = false
    for (const s of stats) {
      if (s.size > MAX_INDEX_FILE_SIZE) continue
      live.add(s.path)
      const old = byPath.get(s.path)
      if (!old || old.size !== s.size || old.mtime_ms !== s.mtime_ms) changed.push(s.path)
    }
    for (const f of ledger) {
      if (f.size > MAX_INDEX_FILE_SIZE) continue
      if (!live.has(f.path)) {
        deleted = true
        break
      }
    }
    return { changed, deleted, live: [...live] } satisfies StatDiff
  })

const runIncremental = (scope: Scope, sb: Sandbox, diff: StatDiff) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => S.dropMissingFiles(scope, diff.live))
    if (diff.changed.length === 0 && !diff.deleted) {
      // Restore ready if we claimed for a race that turned into a no-op.
      yield* Effect.tryPromise(() => S.finishIndexRecount(scope))
      return Effect.void
    }

    log.info("incremental", { scope, changed: diff.changed.length, deleted: diff.deleted })
    yield* Effect.tryPromise(() => S.setStaleFiles(scope, diff.changed.length ? diff.changed : []))

    // Prefer sandbox sync()'s changed set for replaceFiles; server stat is a
    // cheap prefilter. Empty snap.files → content-hash no-op (mtime noise).
    const snap = yield* extract(scope, sb, diff.deleted ? "full" : "incremental", PROGRESS)
    if (diff.deleted) {
      yield* Effect.tryPromise(() => S.replaceGraph(scope, snap))
    } else {
      const changedPaths = (snap.files ?? []).map((f) => f.path as string)
      if (changedPaths.length === 0) {
        log.info("incremental no-op (sync empty)", { scope, serverChanged: diff.changed.length })
        yield* Effect.tryPromise(() => S.setStaleFiles(scope, []))
        yield* Effect.tryPromise(() => S.finishIndexRecount(scope))
        return Effect.void
      }
      yield* Effect.tryPromise(() => S.replaceFiles(scope, changedPaths, snap))
    }
    yield* Effect.tryPromise(() => S.setStaleFiles(scope, []))
    return Effect.void
  })

/**
 * Claim scope → run work → on failure mark failed.
 * Full and incremental both claim so multi-pod never double-writes a scope.
 * Cheap stat precheck runs before claim on the ready path so idle ticks do
 * not flip ready→indexing every 30s.
 */
const ensureIndexed = (scope: Scope, sb: Sandbox) =>
  Effect.gen(function* () {
    const state = yield* Effect.tryPromise(() => S.getIndex(scope))
    const engineMismatch = !!state && state.state === "ready" && state.engine_version !== ENGINE_VERSION
    const needsFull =
      !state ||
      state.state === "failed" ||
      state.state === "pending" ||
      state.state === "indexing" ||
      engineMismatch

    if (!needsFull) {
      // ready + same engine: precheck without claim
      const diff = yield* statDiff(scope, sb)
      if (diff.changed.length === 0 && !diff.deleted) {
        // Still drop missing if any ledger drift (should be rare with empty changed)
        yield* Effect.tryPromise(() => S.dropMissingFiles(scope, diff.live))
        return Effect.void
      }
      const claimed = yield* Effect.tryPromise(() => S.claimIndexing(scope, ENGINE_VERSION))
      if (!claimed) return Effect.void
      yield* runIncremental(scope, sb, diff).pipe(
        Effect.catchCause((cause) => {
          const msg = Cause.pretty(cause)
          log.error("index failed", { scope, cause: msg })
          return Effect.tryPromise(() => S.failIndex(scope, msg)).pipe(Effect.catchCause(() => Effect.void))
        }),
      )
      return Effect.void
    }

    const claimed = yield* Effect.tryPromise(() => S.claimIndexing(scope, ENGINE_VERSION))
    if (!claimed) return Effect.void
    yield* runFullIndex(scope, sb).pipe(
      Effect.catchCause((cause) => {
        const msg = Cause.pretty(cause)
        log.error("index failed", { scope, cause: msg })
        return Effect.tryPromise(() => S.failIndex(scope, msg)).pipe(Effect.catchCause(() => Effect.void))
      }),
    )
    return Effect.void
  })

// ---------------------------------------------------------------------------
// Service + layer
// ---------------------------------------------------------------------------

export class Service extends Context.Service<Service, {}>()("@opencode/CodegraphIndexer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (dialect !== "pg") return Service.of({})

    const provider = yield* SandboxProvider.Service

    yield* Effect.gen(function* () {
      yield* Effect.repeat(
        Effect.gen(function* () {
          const running = yield* Effect.tryPromise(() =>
            Database.use((d: any) =>
              d.select({ session_id: SandboxTable.session_id }).from(SandboxTable).where(eq(SandboxTable.state, "running")).all() as Promise<
                { session_id: string }[]
              >,
            ),
          ).pipe(
            Effect.catchCause((cause) => {
              log.error("query running sandboxes failed", { cause: Cause.pretty(cause) })
              return Effect.succeed([] as { session_id: string }[])
            }),
          )
          for (const row of running) {
            yield* Effect.gen(function* () {
              const opts = yield* Effect.promise(() => resolveSandboxOpts(row.session_id as any))
              if (!opts.appId) return
              const scope = S.scopeFor(opts.appId)
              const sb = yield* provider.get(row.session_id as any).pipe(Effect.orElseSucceed(() => null))
              if (!sb) return
              yield* ensureIndexed(scope, sb)
            }).pipe(Effect.forkScoped)
          }
        }),
        { schedule: Schedule.spaced(LOOP_INTERVAL) },
      ).pipe(Effect.forkScoped, Effect.interruptible)
    })

    return Service.of({})
  }),
)

export * as CodegraphIndexer from "./indexer"
