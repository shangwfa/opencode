export * as SessionExecAsync from "./exec-async.js"

import { Context, Effect, Layer, PubSub, Scope, Stream } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { ChildProcess } from "effect/unstable/process"
import type { Workspace as WorkspaceSchema } from "@opencode/schema/workspace"
import type { Session } from "@opencode/schema/session"
import { Database } from "../database/database.js"
import { Workspace } from "../workspace.js"
import { insert as insertExecLog } from "../exec-log/index.js"
import { ExecLogTable } from "../exec-log/sql.js"
import { and, eq, sql } from "drizzle-orm"
import type { PlatformError } from "effect/PlatformError"

const STDOUT_CAP = 256 * 1024
const LOG_CAP = 64 * 1024
const TRUNCATED = "...[truncated]"

export type ExecStatus = "running" | "completed" | "killed" | "timed_out" | "failed"

export interface ExecEvent {
  readonly event: "stdout" | "stderr" | "done"
  readonly text?: string
  readonly status?: ExecStatus
  readonly exitCode?: number
}

export interface ExecStatusSnapshot {
  readonly id: string
  readonly command: string
  readonly status: ExecStatus
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
  readonly workingDirectory?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

interface ExecEntry {
  readonly id: string
  readonly sessionID: Session.ID
  readonly command: string
  readonly workingDirectory?: string
  status: ExecStatus
  exitCode?: number
  stdout: string
  stderr: string
  readonly startedAt: number
  finishedAt?: number
  readonly events: PubSub.PubSub<ExecEvent>
  kill: () => Effect.Effect<boolean>
}

export interface Interface {
  /** Starts a detached command in the session's sandbox; returns immediately. */
  readonly start: (input: {
    readonly sessionID: Session.ID
    readonly workspaceID: WorkspaceSchema.ID
    readonly command: string
    readonly workingDirectory?: string
    readonly timeoutMs?: number
  }) => Effect.Effect<{ execId: string }>
  readonly get: (execId: string) => ExecStatusSnapshot | undefined
  readonly list: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<ExecStatusSnapshot>>
  readonly kill: (execId: string) => Effect.Effect<boolean>
  /**
   * Buffered replay followed by live output for one detached command.
   * Undefined when the execId is unknown.
   */
  readonly events: (execId: string) => Stream.Stream<ExecEvent> | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExecAsync") {}

interface ExecAuditRow {
  readonly id: string
  readonly command: string
  readonly status: string
  readonly exit_code: number | null
  readonly time_started: number
  readonly time_finished: number | null
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const workspace = yield* Workspace.Service
    // Detached commands and their collectors live as long as the service does.
    const lifetime = yield* Scope.Scope
    const entries = new Map<string, ExecEntry>()
    let counter = 0

    const append = (entry: ExecEntry, channel: "stdout" | "stderr", chunk: string) => {
      if (entry.status !== "running") return Effect.void
      if (channel === "stdout" && entry.stdout.length < STDOUT_CAP) entry.stdout += chunk
      if (channel === "stderr" && entry.stderr.length < STDOUT_CAP) entry.stderr += chunk
      return PubSub.publish(entry.events, { event: channel, text: chunk }).pipe(Effect.orDie)
    }

    const settle = (entry: ExecEntry, status: ExecStatus, exitCode: number | undefined) =>
      Effect.gen(function* () {
        if (entry.status !== "running") return
        entry.status = status
        entry.exitCode = exitCode
        entry.finishedAt = Date.now()
        yield* PubSub.publish(entry.events, { event: "done", status, exitCode }).pipe(Effect.orDie)
        // Persist the terminal state into the v1-compatible exec_log audit
        // table, truncating captured output the way the v1 fleet does.
        const truncate = (value: string) => (value.length > LOG_CAP ? value.slice(0, LOG_CAP) + TRUNCATED : value)
        yield* db
          .update(ExecLogTable)
          .set({
            status,
            exit_code: exitCode ?? undefined,
            stdout: truncate(entry.stdout),
            stderr: truncate(entry.stderr),
            time_finished: Date.now(),
            time_updated: Date.now(),
          })
          .where(and(eq(ExecLogTable.id, entry.id), eq(ExecLogTable.status, "running")))
          .run()
          .pipe(Effect.orDie)
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("exec log update failed", cause)))

    const snapshot = (entry: ExecEntry): ExecStatusSnapshot => ({
      id: entry.id,
      command: entry.command,
      status: entry.status,
      ...(entry.exitCode === null ? {} : { exitCode: entry.exitCode }),
      stdout: entry.stdout,
      stderr: entry.stderr,
      workingDirectory: entry.workingDirectory,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
    })

    const start: Interface["start"] = (input) =>
      Effect.scoped(
      Effect.gen(function* () {
        counter += 1
        const id = `exec-${counter}-${Date.now()}`
        const entry: ExecEntry = {
          id,
          sessionID: input.sessionID,
          command: input.command,
          workingDirectory: input.workingDirectory,
          status: "running",
          stdout: "",
          stderr: "",
          startedAt: Date.now(),
          events: yield* PubSub.unbounded<ExecEvent>(),
          kill: () => Effect.succeed(false),
        }
        entries.set(id, entry)
        yield* insertExecLog({
          id,
          session_id: input.sessionID,
          command: input.command,
          working_directory: input.workingDirectory,
          status: "running",
          source: "exec-async",
          time_started: entry.startedAt,
          time_created: entry.startedAt,
          time_updated: entry.startedAt,
        })

        yield* Effect.gen(function* () {
        const connection = yield* workspace.connect(input.workspaceID)
          const shell = yield* connection.spawner.spawn(
            ChildProcess.make("sh", ["-c", input.command], {
              cwd: input.workingDirectory,
            }),
          ).pipe(
            Effect.provideService(Scope.Scope, lifetime),
            Effect.orDie,
          )
          entry.kill = () => shell.kill().pipe(Effect.asVoid, Effect.map(() => true), Effect.orElseSucceed(() => false))
          const collect = (channel: "stdout" | "stderr", stream: Stream.Stream<Uint8Array, PlatformError>) =>
            Stream.runForEach(Stream.decodeText(stream), (text) =>
              append(entry, channel, text),
            ).pipe(Effect.orDie)
          const collectBoth = Effect.all([collect("stdout", shell.stdout), collect("stderr", shell.stderr)]).pipe(
            Effect.asVoid,
          )
          const exit = shell.exitCode
          const raced =
            input.timeoutMs === undefined
              ? Effect.all([collectBoth, exit], { discard: false }).pipe(Effect.map(([, code]) => code))
              : Effect.all([collectBoth, exit], { discard: false }).pipe(
                  Effect.map(([, code]) => code),
                  Effect.timeoutOption(`${input.timeoutMs} millis`),
                  Effect.map((option) => (option._tag === "Some" ? option.value : "timed-out")),
                )
          const result: number | "timed-out" | undefined = yield* raced
          if (result === "timed-out") {
            yield* shell.kill().pipe(Effect.orElseSucceed(() => false))
            yield* settle(entry, "timed_out", undefined)
          } else {
            yield* settle(entry, "completed", result)
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("async exec failed", cause).pipe(
              Effect.andThen(Effect.sync(() => settle(entry, "failed", undefined))),
            ),
          ),
          Effect.forkIn(lifetime),
        )

        return { execId: id }
      }))

    const get = (execId: string) => {
      const entry = entries.get(execId)
      return entry ? snapshot(entry) : undefined
    }

    const list = (sessionID: Session.ID) =>
      Effect.gen(function* () {
        const live = Array.from(entries.values())
          .filter((entry) => entry.sessionID === sessionID)
          .map(snapshot)
        // Durable audit rows (exec_log: async commands, watchdog-style scans,
        // sandbox-oom attribution) merge with the live list, deduped by id.
        const rows = (yield* db
          .all<ExecAuditRow>(sql`
            select id, command, status, exit_code, time_started, time_finished
            from exec_log
            where session_id = ${sessionID}
            order by time_created
          `)
          .pipe(Effect.orDie)) as ReadonlyArray<ExecAuditRow>
        const seen = new Set(live.map((item) => item.id))
        const audited: ReadonlyArray<ExecStatusSnapshot> = rows.map((row) => ({
          id: row.id,
          command: row.command,
          status: row.status as ExecStatus,
          ...(row.exit_code === null || row.exit_code === undefined ? {} : { exitCode: row.exit_code }),
          startedAt: row.time_started,
          ...(row.time_finished === null || row.time_finished === undefined ? {} : { finishedAt: row.time_finished }),
        }))
        return [...live, ...audited.filter((row) => !seen.has(row.id))]
      })

    const kill: Interface["kill"] = (execId) =>
      Effect.gen(function* () {
        const entry = entries.get(execId)
        if (entry === undefined || entry.status !== "running") return false
        const killed = yield* entry.kill()
        if (killed) yield* settle(entry, "killed", undefined)
        return killed
      })

    const events = (execId: string) => {
      const entry = entries.get(execId)
      if (entry === undefined) return undefined
      // Buffered replay followed by the live pub/sub until done.
      const replay: Array<ExecEvent> = []
      if (entry.stdout) replay.push({ event: "stdout", text: entry.stdout })
      if (entry.stderr) replay.push({ event: "stderr", text: entry.stderr })
      if (entry.status !== "running") replay.push({
          event: "done",
          status: entry.status,
          ...(entry.exitCode === null ? {} : { exitCode: entry.exitCode }),
        })
      return Stream.make(...replay).pipe(Stream.concat(Stream.fromPubSub(entry.events)))
    }

    return Service.of({ start, get, list, kill, events })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Workspace.node] })
