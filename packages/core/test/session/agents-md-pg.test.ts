import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Database } from "@opencode/core/database/database"
import { SessionAgentsMd } from "@opencode/core/session/agents-md"
import { SessionAgentsMdTable, SessionTable } from "@opencode/core/session/sql"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/schema/session"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SessionAgentsMd.node])))
const pgTest = process.env.OPENCODE_DATABASE_URL ? it.effect : it.effect.skip

pgTest("persists and upserts one Session AGENTS.md row in PostgreSQL", () => {
  // A unique slug per run scopes cleanup to rows this test created on the shared database.
  const slug = `session-agents-md-pg-test-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = Session.ID.create()
    const service = yield* SessionAgentsMd.Service

    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug,
        directory: AbsolutePath.make("/"),
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)

    const created = yield* service.put(sessionID, "SESSION_AGENTS_PG_V1")
    const first = yield* db
      .select()
      .from(SessionAgentsMdTable)
      .where(eq(SessionAgentsMdTable.session_id, sessionID))
      .all()
    expect(first).toHaveLength(1)
    const firstRow = first[0]
    if (!firstRow) throw new Error("Session AGENTS.md row was not inserted")
    expect(firstRow.content).toBe("SESSION_AGENTS_PG_V1")
    expect(firstRow.id).toBe(created.id)
    const createdAt = firstRow.time_created
    const firstUpdatedAt = firstRow.time_updated

    const updated = yield* service.put(sessionID, "SESSION_AGENTS_PG_V2")
    const rows = yield* db
      .select()
      .from(SessionAgentsMdTable)
      .where(eq(SessionAgentsMdTable.session_id, sessionID))
      .all()
    expect(rows).toHaveLength(1)
    expect(updated.id).toBe(created.id)
    expect(updated.content).toBe("SESSION_AGENTS_PG_V2")
    expect(rows[0]?.time_created).toBe(createdAt)
    // Replacement always advances time_updated, even within the same millisecond.
    expect(rows[0]?.time_updated).toBeGreaterThan(firstUpdatedAt)
    expect(yield* service.get(sessionID)).toEqual(updated)

    // Concurrent replacements each advance time_updated against the row's current value,
    // so no two writes share a stamp and the stored row keeps the greatest one.
    const concurrent = yield* Effect.forEach(
      Array.from({ length: 8 }, (_, index) => index),
      (index) => service.put(sessionID, `SESSION_AGENTS_PG_CONCURRENT_${index}`),
      { concurrency: "unbounded" },
    )
    const stamps = concurrent.map((info) => DateTime.toEpochMillis(info.time.updated))
    expect(new Set(stamps).size).toBe(stamps.length)
    const afterConcurrent = yield* db
      .select()
      .from(SessionAgentsMdTable)
      .where(eq(SessionAgentsMdTable.session_id, sessionID))
      .all()
    expect(afterConcurrent[0]?.time_updated).toBe(Math.max(...stamps))

    // Deleting the owning Session cascades the AGENTS.md row away.
    yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
    expect(yield* service.get(sessionID)).toBeNull()
    expect(
      yield* db
        .select()
        .from(SessionAgentsMdTable)
        .where(eq(SessionAgentsMdTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie),
    ).toHaveLength(0)
  }).pipe(
    // Clean up by exact slug even when an assertion fails mid-test.
    Effect.ensuring(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.delete(SessionTable).where(eq(SessionTable.slug, slug)).run().pipe(Effect.orDie)
      }).pipe(Effect.ignore),
    ),
  )
})
