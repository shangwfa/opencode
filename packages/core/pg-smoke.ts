import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "./src/database/database.js"
import { LayerNode } from "@opencode/util/effect/layer-node.js"

process.env.OPENCODE_DATABASE_URL = "postgresql://local@127.0.0.1:5432/opencode-v2-up"

const program = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const tables = yield* db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
  console.log("tables:", tables.map((t) => t.name).join(", "))
  const n = yield* db.get<{ c: number }>(sql`SELECT count(*) AS c FROM session_v2`)
  console.log("session rows:", n?.c)
})

process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e) })
Effect.runPromise(program.pipe(Effect.provide(LayerNode.compile(Database.node))) as any)
  .then(() => process.exit(0))
  .catch((e: any) => { console.error("FAIL:", e?.message ?? e); console.error("cause:", JSON.stringify(e?.cause ?? e, null, 1)?.slice(0, 600)); process.exit(1) })
