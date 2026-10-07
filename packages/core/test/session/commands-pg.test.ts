import { expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
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

// The sibling resource services (agents, skills, tools, Session AGENTS.md) advance time_updated
// with `max(now, time_updated + 1)` so a same-millisecond replacement still strictly advances the
// stamp. Commands write `time_updated: now` directly, so two writes landing in one millisecond
// leave an equal (or older) stamp behind. The clock is frozen to reproduce exactly that case and
// the stored value is read after every write to observe the whole sequence.
pgTest("same-millisecond upserts of one session command strictly advance time_updated", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const { session, created } = yield* ensureSession(db)
    const name = `stamp-${crypto.randomUUID()}`
    const sessionID = Session.ID.make(session.id)
    const realNow = Date.now
    try {
      Date.now = () => 1_700_000_000_000
      yield* SessionCommands.create(sessionID, { name, template: "hello" })
      const sequence: number[] = []
      for (let index = 0; index < 8; index++) {
        yield* SessionCommands.create(sessionID, { name, template: `t${index}` })
        const row = yield* db
          .select()
          .from(SessionCommandTable)
          .where(eq(SessionCommandTable.name, name))
          .get()
        sequence.push(row?.time_updated ?? 0)
      }
      Date.now = realNow
      const distinct = new Set(sequence).size
      const sorted = [...sequence].sort((a, b) => a - b)
      // Strictly monotonic: no two writes share a stamp and the stored row keeps the greatest one.
      expect(distinct).toBe(sequence.length)
      expect(sequence).toEqual(sorted)
    } finally {
      Date.now = realNow
    }
    yield* db
      .delete(SessionCommandTable)
      .where(eq(SessionCommandTable.name, name))
      .run()
    yield* removeIfCreated(db, session, created)
  }))
