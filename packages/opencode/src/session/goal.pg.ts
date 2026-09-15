import { pgTable, text, integer } from "drizzle-orm/pg-core"
import { Timestamps, pgJsonb } from "../storage/schema.pg"
import { SessionTable } from "./session.pg"
import type { SessionID } from "./schema"

export const SessionGoalTable = pgTable("session_goal", {
  session_id: text()
    .primaryKey()
    .$type<SessionID>()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  condition: text().notNull(),
  react: integer().notNull().default(0),
  status: text().notNull().default("active"),
  last_verdict: pgJsonb<{
    ok: boolean
    impossible?: boolean
    reason: string
    attempt: number
    messageID?: string
    error?: boolean
  }>(),
  ...Timestamps,
})

export * as GoalPG from "./goal.pg"
