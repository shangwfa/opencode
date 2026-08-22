import { pgTable, text, index } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"

export const SessionSnapshotTable = pgTable(
  "session_snapshot",
  {
    id: text().primaryKey(),
    session_id: text(),
    app_id: text(),
    scope: text().$type<"session" | "baseline">().notNull(),
    state: text().$type<"creating" | "ready" | "failed" | "stale" | "retired" | "deleting" | "deleted">().notNull(),
    reason: text(),
    ...Timestamps,
  },
  (t) => [index("session_snapshot_session_idx").on(t.session_id, t.state), index("session_snapshot_app_idx").on(t.app_id, t.scope)],
)
