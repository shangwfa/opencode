import { pgTable, text, integer, bigint, index } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"
import { SessionTable } from "./session.pg"
import type { SessionID } from "./schema"
import * as Database from "../storage/db"
import { Log } from "@opencode-ai/core/util/log"
import { trace } from "@opentelemetry/api"
import { and, eq, desc, lt } from "drizzle-orm"

const log = Log.create({ service: "exec-log" })

export type ExecLogSource =
  | "exec"
  | "exec-async"
  | "preview"
  | "keep-alive"
  | "kill-sandbox"
  | "patch"
  | "agent-create"
  | "agent-delete"
  | "agent-clear"
  | "session-create"
  | "session-delete"
  | "session-fork"
  | "session-abort"
  | "session-init"
  | "session-share"
  | "session-unshare"
  | "session-summarize"
  | "session-prompt"
  | "session-prompt-async"
  | "session-prompt-stream"
  | "session-command"
  | "session-shell"
  | "session-revert"
  | "session-unrevert"
  | "permission-respond"
  | "message-delete"
  | "part-delete"
  | "part-update"
  | "skill-create"
  | "skill-load"
  | "skill-delete"
  | "skill-clear"
  | "mcp-create"
  | "mcp-delete"
  | "mcp-clear"
  | "tool-create"
  | "tool-delete"
  | "tool-clear"
  | "command-create"
  | "command-delete"
  | "command-clear"
  | "agentsmd-create"
  | "agentsmd-clear"
  | "plugin-create"
  | "plugin-delete"
  | "plugin-clear"
  | "dotopencode-load"
  | "sandbox-create"
  | "sandbox-oom"
  | "snapshot-create"
  | "snapshot-reuse"
  | "snapshot-restore"
  | "snapshot-fallback"
  | "snapshot-delete"
  | "file-mkdir"
  | "file-create"
  | "file-download"
  | "file-upload"
  | "file-remove"
  | "permission-deny"
  | "tool-call"

export const ExecLogTable = pgTable(
  "exec_log",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    command: text().notNull(),
    working_directory: text(),
    status: text().$type<"running" | "completed" | "failed" | "killed" | "timed_out" | "denied">().notNull(),
    exit_code: integer(),
    stdout: text(),
    stderr: text(),
    error: text(),
    rule: text(),
    trace_id: text(),
    source: text().$type<ExecLogSource>().notNull(),
    time_started: bigint({ mode: "number" }).notNull(),
    time_finished: bigint({ mode: "number" }),
    ...Timestamps,
  },
  (table) => [index("exec_log_session_idx").on(table.session_id)],
)

export type ExecLog = typeof ExecLogTable.$inferSelect
export type NewExecLog = typeof ExecLogTable.$inferInsert

export async function insertExecLog(row: NewExecLog) {
  try {
    await Database.use((db) => db.insert(ExecLogTable).values({ ...row, trace_id: row.trace_id ?? currentTraceId() }))
  } catch (error) {
    log.error("failed to insert exec log", {
      id: row.id,
      sessionID: row.session_id,
      source: row.source,
      error,
    })
  }
}

// Correlates an audit row with the distributed trace it happened in. Empty when
// no OTLP exporter is configured or the write is outside a traced span.
export function currentTraceId() {
  return trace.getActiveSpan()?.spanContext().traceId
}

export async function updateExecLog(id: string, patch: Partial<NewExecLog>) {
  try {
    await Database.use((db) => db.update(ExecLogTable).set(patch).where(eq(ExecLogTable.id, id)))
  } catch (error) {
    log.error("failed to update exec log", { id, error })
  }
}

export async function queryExecLogsBySession(sessionID: string) {
  return Database.use((db) =>
    db
      .select()
      .from(ExecLogTable)
      .where(eq(ExecLogTable.session_id, sessionID as any))
      .orderBy(desc(ExecLogTable.time_started)),
  ) as Promise<ExecLog[]>
}

export async function queryExecLog(id: string) {
  const rows = await Database.use((db) => db.select().from(ExecLogTable).where(eq(ExecLogTable.id, id)).limit(1))
  return rows[0] ?? null
}

/** 24h：实例死亡后悬空的 running 行最迟收口阈值。
 * 沙箱命令最长 ~10h（keepAlive 10x maxTtl），24h 仍 running 必然是执行实例已死。 */
export const STALE_RUNNING_MS = 24 * 60 * 60 * 1000

/** 把超期仍 running 的 exec_log 行终态化（实例死亡后无人写终态的兜底清扫）。
 * 挂在 sandbox idle reap 周期调用；返回清理行数。 */
export async function reapStaleRunning(now = Date.now()) {
  try {
    const rows = await Database.use((db) =>
      db
        .update(ExecLogTable)
        .set({
          status: "failed",
          rule: "instance lost (stale running exec)",
          time_finished: now,
          time_updated: now,
        })
        .where(and(eq(ExecLogTable.status, "running"), lt(ExecLogTable.time_started, now - STALE_RUNNING_MS)))
        .returning({ id: ExecLogTable.id }),
    )
    const count = rows.length
    if (count > 0) log.warn("reaped stale running exec logs", { count })
    return count
  } catch (error) {
    log.error("failed to reap stale running exec logs", { error: String(error) })
    return 0
  }
}
