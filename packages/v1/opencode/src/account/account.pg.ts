import { pgTable, text, integer } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"

export const AccountTable = pgTable("account", {
  id: text().primaryKey(),
  email: text().notNull(),
  url: text().notNull(),
  access_token: text().notNull(),
  refresh_token: text().notNull(),
  token_expiry: integer(),
  time_created: Timestamps.time_created,
  time_updated: Timestamps.time_updated,
})

export const AccountStateTable = pgTable("account_state", {
  id: integer().primaryKey(),
  active_account_id: text().references(() => AccountTable.id, { onDelete: "set null" }),
  active_org_id: text(),
})
