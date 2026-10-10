import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { SessionPluginTable, SessionTable } from "@opencode/core/session/sql"
import { SessionPlugin } from "@opencode/schema/session-plugin"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { testEffect } from "../lib/effect"
import { ensureSession, removeIfCreated } from "../lib/session"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node]),
    [Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") }))],
  ),
)
const pgTest = process.env.OPENCODE_DATABASE_URL ? it.effect : it.effect.skip

pgTest("session plugin schema persists tagged source and cascades on session delete", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const { session, created } = yield* ensureSession(db)
    const id = SessionPlugin.ID.create()
    try {
      yield* db.insert(SessionPluginTable).values({
        id,
        session_id: session.id,
        name: SessionPlugin.Name.make("pg-fixture"),
        description: "PG fixture",
        source: { type: "code", code: "export default async () => ({})" },
        time_created: Date.now(),
        time_updated: Date.now(),
      }).run()
      const row = yield* db.select().from(SessionPluginTable).where(eq(SessionPluginTable.id, id)).get()
      expect(row?.source).toEqual({ type: "code", code: "export default async () => ({})" })
      yield* db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run()
      expect(yield* db.select().from(SessionPluginTable).where(eq(SessionPluginTable.id, id)).get()).toBeUndefined()
    } finally {
      yield* removeIfCreated(db, session, created)
    }
  }),
)
