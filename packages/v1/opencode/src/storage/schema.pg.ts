import { bigint, customType, pgTable, text } from "drizzle-orm/pg-core"

// jsonb column with driver-level decoding. The PG bridge (db.pg.ts) configures
// postgres.js to return json/jsonb as raw strings so core SQLite text-json
// decoders keep working; drizzle's stock jsonb() column has an identity
// decoder, so any direct select through a *.pg.ts schema would receive strings
// instead of parsed values. This column type keeps the same wire behavior on
// writes (JSON.stringify to a text param) and parses on the way out.
// See docs/upstream-merge-guide.md and the HITL PG tests for the failure mode
// this prevents.
export const pgJsonb = <T = unknown>(name?: string) =>
  customType<{ data: T; driverData: string | T }>({
    dataType: () => "jsonb",
    toDriver: (value) => JSON.stringify(value),
    fromDriver: (value) => (typeof value === "string" ? (JSON.parse(value) as T) : value),
    // drizzle's builder typing demands a name; the runtime resolves
    // undefined into the property-key position like every other column.
  })(name as string)

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
  data: pgJsonb().notNull(),
  time_updated: bigint({ mode: "number" }).notNull(),
})
