import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Session } from "@opencode/schema/session"
import { SessionTable as SessionSqlTable } from "../session/sql.js"
import { Timestamps } from "../database/schema.sql.js"

/**
 * Command/denial audit trail, schema-compatible with the v1 fleet's
 * `exec_log` table (packages/v1/opencode/src/session/exec-log.pg.ts):
 * identical table name, columns, enums, and index, so v2 writes rows the v1
 * tooling reads.
 */
export const ExecLogTable = sqliteTable(
  "exec_log",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionSqlTable.id, { onDelete: "cascade" }),
    command: text().notNull(),
    working_directory: text(),
    status: text().$type<"running" | "completed" | "failed" | "killed" | "timed_out" | "denied">().notNull(),
    exit_code: integer(),
    stdout: text(),
    stderr: text(),
    error: text(),
    rule: text(),
    trace_id: text(),
    source: text()
      .$type<
        | "bash"
        | "tool"
        | "file-read"
        | "file-write"
        | "file-create"
        | "file-mkdir"
        | "file-download"
        | "file-upload"
        | "file-remove"
        | "permission-deny"
        | "tool-call"
        | "sandbox-oom"
      >()
      .notNull(),
    time_started: integer().notNull(),
    time_finished: integer(),
    ...Timestamps,
  },
  (table) => [index("exec_log_session_idx").on(table.session_id)],
)

export type ExecLog = typeof ExecLogTable.$inferSelect
export type NewExecLog = typeof ExecLogTable.$inferInsert
