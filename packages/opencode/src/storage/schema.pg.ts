import { bigint, jsonb, pgTable, text } from "drizzle-orm/pg-core"

export const Timestamps = {
  time_created: bigint({ mode: "number" })
    .notNull()
    .$default(() => Date.now()),
  time_updated: bigint({ mode: "number" })
    .notNull()
    .$onUpdate(() => Date.now()),
}

export const StorageDataTable = pgTable("storage_data", {
  key: text().primaryKey(),
  data: jsonb().notNull(),
  time_updated: bigint({ mode: "number" }).notNull(),
})
