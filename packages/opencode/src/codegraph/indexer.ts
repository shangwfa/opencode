import { Effect, Layer, Schedule, Context, Cause, Duration } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { eq } from "drizzle-orm"
import { gunzipSync } from "node:zlib"
import { readFile } from "node:fs/promises"
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

const EXTRACTOR_DIR = "/tmp/codegraph-extractor"
const EXTRACTOR_TAR = "/tmp/codegraph-extractor.tar.gz"
const INDEX_OUT = "/tmp/cg.ndjson.gz"
const STAT_OUT = "/tmp/cg-stats.ndjson"
const FILES_LIST = "/tmp/cg-files.json"
const PROGRESS = "/tmp/cg-progress.json"

const EXEC_TIMEOUT_SECONDS = 900
const LOOP_INTERVAL = Duration.seconds(30)
const HEARTBEAT_EVERY_MS = 5000

const ENGINE_VERSION = "codegraph-extractor-1"

// Runtime location of the prebuilt extractor tarballs (P6: baked into the image).
// Per-arch so K8s (amd64) and local Apple-Silicon (arm64) sandboxes both work.
const extractorTarPath = (arch: "x64" | "arm64") =>
  process.env.CODEGRAPH_EXTRACTOR_TAR ?? `build/codegraph-extractor-linux-${arch}.tar.gz`

// ---------------------------------------------------------------------------
// Sandbox I/O helpers
// ---------------------------------------------------------------------------

const ensureExtractor = async (sb: Sandbox) => {
  const info = await sb.files.getFileInfo([`${EXTRACTOR_DIR}/main.ts`]).catch(() => ({} as Record<string, unknown>))
  if ((info as any)[`${EXTRACTOR_DIR}/main.ts`]?.exists) return
  const archExec = await sb.commands.run("uname -m", { timeoutSeconds: 15 })
  const archOut = (archExec.logs?.stdout ?? []).map((m: any) => m.data ?? m.content ?? "").join("")
  const arch: "x64" | "arm64" = archOut.trim() === "aarch64" ? "arm64" : "x64"
  const tar = await readFile(extractorTarPath(arch))
  await sb.files.createDirectories([{ path: EXTRACTOR_DIR, mode: 755 }])
  await sb.files.writeFiles([{ path: EXTRACTOR_TAR, data: tar, mode: 644 }])
  await runCommand(sb, `mkdir -p ${EXTRACTOR_DIR} && tar xzf ${EXTRACTOR_TAR} -C ${EXTRACTOR_DIR} --strip-components=1 && rm ${EXTRACTOR_TAR}`)
}

const runCommand = async (sb: Sandbox, command: string) => {
  const execution = await sb.commands.run(command, { workingDirectory: "/workspace", timeoutSeconds: EXEC_TIMEOUT_SECONDS })
  if (execution.exitCode !== 0) {
    throw new Error(`extractor command failed (exit ${execution.exitCode}): ${command}`)
  }
  return execution
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

type IndexSnapshot = {
  nodes: any[]
  edges: any[]
  files: any[]
  refs: any[]
}

const extract = (scope: Scope, sb: Sandbox, filesArg: string | null, progressPath: string) =>
  Effect.gen(function* () {
    const filesFlag = filesArg ? ` --files ${filesArg}` : ""
    const cmd = `bun ${EXTRACTOR_DIR}/main.ts index --root /workspace --out ${INDEX_OUT} --progress ${progressPath}${filesFlag}`

    yield* Effect.gen(function* () {
      yield* Effect.repeat(
        Effect.gen(function* () {
          let filesDone: number | undefined
          const p = yield* Effect.tryPromise(() => readFile(progressPath, "utf-8")).pipe(
            Effect.catchCause(() => Effect.succeed("")),
          )
          if (p) {
            filesDone = (JSON.parse(p) as { files_done?: number }).files_done
          }
          yield* Effect.tryPromise(() => S.heartbeat(scope, filesDone)).pipe(Effect.catchCause(() => Effect.void))
        }),
        { schedule: Schedule.spaced(Duration.millis(HEARTBEAT_EVERY_MS)) },
      ).pipe(Effect.forkScoped)
    }).pipe(Effect.scoped) // release the heartbeat loop when the block ends

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
    yield* Effect.tryPromise(() => ensureExtractor(sb))
    const snap = yield* extract(scope, sb, null, PROGRESS)
    yield* Effect.tryPromise(() => S.replaceGraph(scope, snap))
    return Effect.void
  })

const runIncremental = (scope: Scope, sb: Sandbox) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => runCommand(sb, `bun ${EXTRACTOR_DIR}/main.ts stat --root /workspace --out ${STAT_OUT}`))
    const stats = yield* Effect.tryPromise(() => readNdjson<{ t: "stat"; path: string; size: number; mtime_ms: number }>(sb, STAT_OUT, false))
    const ledger = yield* Effect.tryPromise(() => S.listFileStats(scope))
    const byPath = new Map(ledger.map((f) => [f.path, f]))
    const live = new Set<string>()

    const changed: string[] = []
    for (const s of stats) {
      live.add(s.path)
      const old = byPath.get(s.path)
      if (!old || old.size !== s.size || old.mtime_ms !== s.mtime_ms) changed.push(s.path)
    }
    // Deleted files (in ledger, not live) must be dropped even when nothing
    // else changed — this must run BEFORE the early return below.
    yield* Effect.tryPromise(() => S.dropMissingFiles(scope, [...live]))
    if (changed.length === 0) return Effect.void

    log.info("incremental", { scope, changed: changed.length })
    // Publish the pending-change set BEFORE re-extracting so tools can tell the
    // agent "these files just changed, read them directly" during the sync gap.
    yield* Effect.tryPromise(() => S.setStaleFiles(scope, changed))
    yield* Effect.tryPromise(() => sb.files.writeFiles([{ path: FILES_LIST, data: Buffer.from(JSON.stringify(changed)), mode: 644 }]))
    const snap = yield* extract(scope, sb, FILES_LIST, PROGRESS)
    yield* Effect.tryPromise(() => S.replaceFiles(scope, changed, snap))
    yield* Effect.tryPromise(() => S.setStaleFiles(scope, []))
    return Effect.void
  })

const ensureIndexed = (scope: Scope, sb: Sandbox) =>
  Effect.gen(function* () {
    const state = yield* Effect.tryPromise(() => S.getIndex(scope))
    if (state?.state === "ready") {
      yield* runIncremental(scope, sb)
    } else {
      // Full index: claim first so a concurrent loop tick (or another pod)
      // never runs two replacements against the same scope — the winner
      // writes, the loser returns early.
      const claimed = yield* Effect.tryPromise(() => S.claimIndexing(scope, ENGINE_VERSION))
      if (!claimed) return Effect.void
      yield* runFullIndex(scope, sb)
    }
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
              d.select({ session_id: SandboxTable.session_id }).from(SandboxTable).where(eq(SandboxTable.state, "running")).all() as Promise<{ session_id: string }[]>,
            ),
          ).pipe(Effect.catchCause((cause) => {
            log.error("query running sandboxes failed", { cause: Cause.pretty(cause) })
            return Effect.succeed([] as { session_id: string }[])
          }))
          for (const row of running) {
            yield* Effect.gen(function* () {
              const opts = yield* Effect.promise(() => resolveSandboxOpts(row.session_id as any))
              if (!opts.appId) return
              const scope = S.scopeFor(opts.appId)
              const sb = yield* provider.get(row.session_id as any).pipe(Effect.orElseSucceed(() => null))
              if (!sb) return
              yield* ensureIndexed(scope, sb).pipe(
                Effect.catchCause((cause) => {
                  log.error("index failed", { scope, cause: Cause.pretty(cause) })
                  return Effect.void
                }),
              )
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