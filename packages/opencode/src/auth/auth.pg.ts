import { pgTable, text, jsonb } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"

export const AuthTable = pgTable("auth", {
  provider_id: text().primaryKey(),
  user_id: text().notNull().default(""),
  type: text().notNull(),
  data: jsonb().notNull().$type<Record<string, unknown>>(),
  ...Timestamps,
})
