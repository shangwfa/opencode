import { pgTable, text } from "drizzle-orm/pg-core"
import { pgJsonb, Timestamps } from "../storage/schema.pg"

export const AuthTable = pgTable("auth", {
  provider_id: text().primaryKey(),
  user_id: text().notNull().default(""),
  type: text().notNull(),
  data: pgJsonb<Record<string, unknown>>().notNull(),
  ...Timestamps,
})
