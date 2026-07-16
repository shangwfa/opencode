import { pgTable, text, integer, bigint, index } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"
import { SessionTable } from "./session.pg"
import type { SessionID } from "./schema"
import * as Database from "../storage/db"
import { eq, desc } from "drizzle-orm"

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
    status: text().$type<"running" | "completed" | "failed" | "killed" | "timed_out">().notNull(),
    exit_code: integer(),
    stdout: text(),
    stderr: text(),
    error: text(),
    source: text().$type<"exec" | "exec-async" | "keep-alive" | "kill-sandbox" | "patch">().notNull(),
    time_started: bigint({ mode: "number" }).notNull(),
    time_finished: bigint({ mode: "number" }),
    ...Timestamps,
  },
  (table) => [index("exec_log_session_idx").on(table.session_id)],
)

export type ExecLog = typeof ExecLogTable.$inferSelect
export type NewExecLog = typeof ExecLogTable.$inferInsert

export async function insertExecLog(row: NewExecLog) {
  try { await Database.use((db) => db.insert(ExecLogTable).values(row)) } catch {}
}

export async function updateExecLog(id: string, patch: Partial<NewExecLog>) {
  try { await Database.use((db) => db.update(ExecLogTable).set(patch).where(eq(ExecLogTable.id, id))) } catch {}
}

export async function queryExecLogsBySession(sessionID: string) {
  return Database.use((db) =>
    db.select().from(ExecLogTable).where(eq(ExecLogTable.session_id, sessionID as any)).orderBy(desc(ExecLogTable.time_started))
  ) as Promise<ExecLog[]>
}

export async function queryExecLog(id: string) {
  const rows = await Database.use((db) => db.select().from(ExecLogTable).where(eq(ExecLogTable.id, id)).limit(1))
  return rows[0] ?? null
}
