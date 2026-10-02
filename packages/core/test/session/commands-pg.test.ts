import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { SessionCommandTable, SessionTable } from "@opencode/core/session/sql"
import { SessionCommands } from "@opencode/core/session/commands"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "../lib/effect"
import { ensureSession, removeIfCreated } from "../lib/session"
import { Session } from "@opencode/schema/session"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))
const pgTest = process.env.OPENCODE_DATABASE_URL ? it.effect : it.effect.skip

pgTest("upserts a session command through the PostgreSQL compatibility layer", () => Effect.gen(function* () {
  const { db } = yield* Database.Service
  const { session, created } = yield* ensureSession(db)
  const name = `debug-${crypto.randomUUID()}`
  const sessionID = Session.ID.make(session.id)
  const input = {
    name,
    template: "hello",
    subtask: true,
  }
  const result = yield* SessionCommands.create(sessionID, input)
  expect(result.source).toBe("session")
  expect(result.subagent).toBe(true)

  const updated = yield* SessionCommands.create(sessionID, { ...input, template: "updated" })
  expect(updated.template).toBe("updated")
  const rows = yield* db
    .select()
    .from(SessionCommandTable)
    .where(eq(SessionCommandTable.session_id, sessionID))
    .all()
  expect(rows.filter((row) => row.name === name)).toHaveLength(1)

  yield* db
    .delete(SessionCommandTable)
    .where(eq(SessionCommandTable.name, name))
    .run()
  yield* removeIfCreated(db, session, created)
}))
