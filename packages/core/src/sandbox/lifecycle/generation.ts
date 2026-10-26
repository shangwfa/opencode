import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../../database/database.js"
import { SandboxTable } from "../sql.js"

/** A healthy remote handle is reusable only while PG still owns that running generation. */
export const isCurrentSandbox = (
  row: Pick<typeof SandboxTable.$inferSelect, "id" | "state"> | null | undefined,
  sandboxID: string,
) => row?.id === sandboxID && row.state === "running"

/** V1 dbTouchSandbox semantics; late activity/session writes cannot mutate a replacement. */
export const touchCurrentSandbox = (
  db: Database.Interface["db"],
  sessionID: string,
  sandboxID: string,
  command?: { id: string | null },
) =>
  db.update(SandboxTable)
    .set({ time_updated: Date.now(), ...(command ? { command_session_id: command.id } : {}) })
    .where(and(eq(SandboxTable.session_id, sessionID), eq(SandboxTable.id, sandboxID), eq(SandboxTable.state, "running")))
    .returning({ id: SandboxTable.id })
    .all()
     .pipe(Effect.map((rows) => rows.length > 0))

/** Failed persistence retains this source and restores admission without faking activity. */
export const resumeRetainedSandbox = (db: Database.Interface["db"], sessionID: string, sandboxID: string) =>
  db.update(SandboxTable)
    .set({ state: "running", time_updated: sql`${SandboxTable.time_updated}` })
    .where(and(eq(SandboxTable.session_id, sessionID), eq(SandboxTable.id, sandboxID), eq(SandboxTable.state, "snapshotting")))
    .returning({ id: SandboxTable.id }).all()
    .pipe(Effect.map((rows) => rows.length > 0))
