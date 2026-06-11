/**
 * PostgreSQL integration test.
 *
 * Requires a running PG instance. Set OPENCODE_DATABASE_URL to enable.
 * Example:
 *   OPENCODE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/opencode_test bun test test/storage/pg-integration.test.ts
 *
 * If the env var is not set, all tests are skipped.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import postgres from "postgres"

const url = process.env["OPENCODE_DATABASE_URL"]
const enabled = !!url

// Helper: raw PG client for verification queries
function raw() {
  if (!url) throw new Error("OPENCODE_DATABASE_URL not set")
  return postgres(url)
}

describe.skipIf(!enabled)("PostgreSQL integration", () => {
  let client: ReturnType<typeof postgres>

  beforeAll(async () => {
    client = raw()
    // Clean slate: drop all tables if they exist
    await client.unsafe(`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `)
  })

  afterAll(async () => {
    await client.end()
  })

  test("connects and runs basic query", async () => {
    const rows = await client`SELECT 1 AS ok`
    expect(rows).toHaveLength(1)
    expect(rows[0].ok).toBe(1)
  })

  test("migration creates all expected tables", async () => {
    // Read and execute the migration SQL
    const migrationPath = new URL("../../migration-pg/20260417053648_initial/migration.sql", import.meta.url)
    const sql = await Bun.file(migrationPath).text()

    // Split on statement-breakpoint marker and execute each statement
    const stmts = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)
    for (const stmt of stmts) {
      await client.unsafe(stmt)
    }

    // Verify all tables exist
    const tables = await client`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `
    const names = tables.map((r: any) => r.tablename)
    expect(names).toContain("project")
    expect(names).toContain("session")
    expect(names).toContain("message")
    expect(names).toContain("part")
    expect(names).toContain("todo")
    expect(names).toContain("session_entry")
    expect(names).toContain("permission")
    expect(names).toContain("session_share")
    expect(names).toContain("event_sequence")
    expect(names).toContain("event")
    expect(names).toContain("workspace")
  })

  test("project table CRUD", async () => {
    const id = "proj_" + Math.random().toString(36).slice(2)
    const now = Date.now()

    // Insert
    await client`
      INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
      VALUES (${id}, '/tmp/test', ${now}, ${now}, ${client.json([])})
    `

    // Read
    const rows = await client`SELECT * FROM project WHERE id = ${id}`
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].worktree).toBe("/tmp/test")
    expect(Number(rows[0].time_created)).toBe(now)

    // Update
    await client`UPDATE project SET name = 'test-project' WHERE id = ${id}`
    const updated = await client`SELECT name FROM project WHERE id = ${id}`
    expect(updated[0].name).toBe("test-project")

    // Delete
    await client`DELETE FROM project WHERE id = ${id}`
    const deleted = await client`SELECT * FROM project WHERE id = ${id}`
    expect(deleted).toHaveLength(0)
  })

  test("session table with foreign key to project", async () => {
    const pid = "proj_fk_" + Math.random().toString(36).slice(2)
    const sid = "sess_fk_" + Math.random().toString(36).slice(2)
    const now = Date.now()

    await client`
      INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
      VALUES (${pid}, '/tmp/fk', ${now}, ${now}, ${client.json([])})
    `
    await client`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (${sid}, ${pid}, 'test-slug', '/tmp/fk', 'Test Session', 'v1', ${now}, ${now})
    `

    const rows = await client`SELECT * FROM session WHERE id = ${sid}`
    expect(rows).toHaveLength(1)
    expect(rows[0].project_id).toBe(pid)

    // CASCADE delete: deleting project should delete session
    await client`DELETE FROM project WHERE id = ${pid}`
    const orphan = await client`SELECT * FROM session WHERE id = ${sid}`
    expect(orphan).toHaveLength(0)
  })

  test("jsonb columns store and retrieve structured data", async () => {
    const pid = "proj_json_" + Math.random().toString(36).slice(2)
    const sid = "sess_json_" + Math.random().toString(36).slice(2)
    const mid = "msg_json_" + Math.random().toString(36).slice(2)
    const now = Date.now()

    // postgres.js auto-serializes objects to jsonb — pass raw objects, not JSON.stringify
    const sandboxes = ["sb1", "sb2"]
    const commands = { start: "npm run dev" }
    await client`
      INSERT INTO project (id, worktree, time_created, time_updated, sandboxes, commands)
      VALUES (${pid}, '/tmp/json', ${now}, ${now}, ${client.json(sandboxes)}, ${client.json(commands)})
    `

    // Verify jsonb is properly stored and retrieved
    const proj = await client`SELECT sandboxes, commands FROM project WHERE id = ${pid}`
    expect(proj[0].sandboxes).toEqual(["sb1", "sb2"])
    expect(proj[0].commands).toEqual({ start: "npm run dev" })

    // Test message with jsonb data column
    await client`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (${sid}, ${pid}, 'json-test', '/tmp/json', 'JSON Test', 'v1', ${now}, ${now})
    `
    const data = { role: "user", content: "hello", model: "gpt-4" }
    await client`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (${mid}, ${sid}, ${now}, ${now}, ${client.json(data)})
    `

    const msg = await client`SELECT data FROM message WHERE id = ${mid}`
    expect(msg[0].data).toEqual(data)

    // Cleanup
    await client`DELETE FROM project WHERE id = ${pid}`
  })

  test("bigint timestamps store millisecond precision", async () => {
    const pid = "proj_ts_" + Math.random().toString(36).slice(2)
    const now = 1713340800123 // specific ms-precision timestamp

    await client`
      INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
      VALUES (${pid}, '/tmp/ts', ${now}, ${now}, ${client.json([])})
    `

    const rows = await client`SELECT time_created, time_updated FROM project WHERE id = ${pid}`
    // PG bigint comes back as string by default
    expect(Number(rows[0].time_created)).toBe(now)
    expect(Number(rows[0].time_updated)).toBe(now)

    await client`DELETE FROM project WHERE id = ${pid}`
  })

  test("event_sequence and event tables with foreign key", async () => {
    const agg = "agg_" + Math.random().toString(36).slice(2)
    const eid = "evt_" + Math.random().toString(36).slice(2)

    await client`
      INSERT INTO event_sequence (aggregate_id, seq) VALUES (${agg}, 0)
    `
    await client`
      INSERT INTO event (id, aggregate_id, seq, type, data)
      VALUES (${eid}, ${agg}, 0, 'session.created.1', ${client.json({ id: "s1", title: "hi" })})
    `

    const events = await client`SELECT * FROM event WHERE aggregate_id = ${agg}`
    expect(events).toHaveLength(1)
    expect(events[0].data).toEqual({ id: "s1", title: "hi" })

    // upsert seq
    await client`
      INSERT INTO event_sequence (aggregate_id, seq) VALUES (${agg}, 1)
      ON CONFLICT (aggregate_id) DO UPDATE SET seq = 1
    `
    const seq = await client`SELECT seq FROM event_sequence WHERE aggregate_id = ${agg}`
    expect(seq[0].seq).toBe(1)

    // CASCADE
    await client`DELETE FROM event_sequence WHERE aggregate_id = ${agg}`
    const orphan = await client`SELECT * FROM event WHERE aggregate_id = ${agg}`
    expect(orphan).toHaveLength(0)
  })

  test("todo table composite primary key", async () => {
    const pid = "proj_todo_" + Math.random().toString(36).slice(2)
    const sid = "sess_todo_" + Math.random().toString(36).slice(2)
    const now = Date.now()

    await client`
      INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
      VALUES (${pid}, '/tmp/todo', ${now}, ${now}, ${client.json([])})
    `
    await client`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (${sid}, ${pid}, 'todo-test', '/tmp/todo', 'Todo Test', 'v1', ${now}, ${now})
    `

    // Insert two todos with different positions
    await client`
      INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
      VALUES (${sid}, 'first task', 'pending', 'high', 0, ${now}, ${now})
    `
    await client`
      INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
      VALUES (${sid}, 'second task', 'completed', 'low', 1, ${now}, ${now})
    `

    const todos = await client`SELECT * FROM todo WHERE session_id = ${sid} ORDER BY position`
    expect(todos).toHaveLength(2)
    expect(todos[0].content).toBe("first task")
    expect(todos[1].content).toBe("second task")

    // Duplicate key should fail
    let failed = false
    try {
      await client`
        INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
        VALUES (${sid}, 'dup', 'pending', 'high', 0, ${now}, ${now})
      `
    } catch (err: any) {
      failed = true
      expect(err.code).toBe("23505") // unique_violation
    }
    expect(failed).toBe(true)

    await client`DELETE FROM project WHERE id = ${pid}`
  })

  test("indexes exist for query performance", async () => {
    const indexes = await client`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY indexname
    `
    const names = indexes.map((r: any) => r.indexname)

    expect(names).toContain("session_project_idx")
    expect(names).toContain("session_workspace_idx")
    expect(names).toContain("session_parent_idx")
    expect(names).toContain("message_session_time_created_id_idx")
    expect(names).toContain("part_message_id_id_idx")
    expect(names).toContain("part_session_idx")
    expect(names).toContain("todo_session_idx")
    expect(names).toContain("session_entry_session_idx")
    expect(names).toContain("session_entry_session_type_idx")
    expect(names).toContain("session_entry_time_created_idx")
  })

  test("drizzle-orm PG driver works with schema", async () => {
    // Test that drizzle-orm can connect and query through postgres.js
    const { init } = await import("../../src/storage/db.pg")
    const { db, client: pgClient } = init(url!)

    try {
      const pid = "proj_drizzle_" + Math.random().toString(36).slice(2)
      const now = Date.now()

      // Use drizzle to import the PG schema and perform operations
      const { ProjectTable } = await import("../../src/project/project.pg")
      const { eq } = await import("drizzle-orm")

      // Insert via drizzle
      await db.insert(ProjectTable).values({
        id: pid as any,
        worktree: "/tmp/drizzle",
        sandboxes: [],
        time_created: now,
        time_updated: now,
      })

      // Select via drizzle
      const rows = await db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, pid as any))
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe(pid as any)
      expect(rows[0].worktree).toBe("/tmp/drizzle")
      expect(rows[0].sandboxes).toEqual([])

      // Update via drizzle
      await db
        .update(ProjectTable)
        .set({ name: "drizzle-test" })
        .where(eq(ProjectTable.id, pid as any))
      const updated = await db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, pid as any))
      expect(updated[0].name).toBe("drizzle-test")

      // Delete via drizzle
      await db.delete(ProjectTable).where(eq(ProjectTable.id, pid as any))
      const deleted = await db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, pid as any))
      expect(deleted).toHaveLength(0)
    } finally {
      await pgClient.end()
    }
  })

  test("ON CONFLICT DO UPDATE works (upsert pattern)", async () => {
    const { init } = await import("../../src/storage/db.pg")
    const { db, client: pgClient } = init(url!)

    try {
      const { EventSequenceTable } = await import("../../src/sync/event.pg")
      const agg = "agg_upsert_" + Math.random().toString(36).slice(2)

      // First insert
      await db.insert(EventSequenceTable).values({ aggregate_id: agg, seq: 0 })

      // Upsert — should update seq
      await db
        .insert(EventSequenceTable)
        .values({ aggregate_id: agg, seq: 5 })
        .onConflictDoUpdate({
          target: EventSequenceTable.aggregate_id,
          set: { seq: 5 },
        })

      const { eq } = await import("drizzle-orm")
      const rows = await db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, agg))
      expect(rows).toHaveLength(1)
      expect(rows[0].seq).toBe(5)

      await db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, agg))
    } finally {
      await pgClient.end()
    }
  })

  test("transaction with serializable isolation", async () => {
    const { init } = await import("../../src/storage/db.pg")
    const { db, client: pgClient } = init(url!)

    try {
      const { ProjectTable } = await import("../../src/project/project.pg")
      const { eq } = await import("drizzle-orm")
      const pid = "proj_tx_" + Math.random().toString(36).slice(2)
      const now = Date.now()

      // Insert base data
      await db.insert(ProjectTable).values({
        id: pid as any,
        worktree: "/tmp/tx",
        sandboxes: [],
        time_created: now,
        time_updated: now,
      })

      // Run serializable transaction
      await db.transaction(
        async (tx) => {
          const rows = await tx
            .select()
            .from(ProjectTable)
            .where(eq(ProjectTable.id, pid as any))
          expect(rows).toHaveLength(1)
          await tx
            .update(ProjectTable)
            .set({ name: "tx-updated" })
            .where(eq(ProjectTable.id, pid as any))
        },
        { isolationLevel: "serializable" },
      )

      // Verify outside transaction
      const rows = await db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, pid as any))
      expect(rows[0].name).toBe("tx-updated")

      await db.delete(ProjectTable).where(eq(ProjectTable.id, pid as any))
    } finally {
      await pgClient.end()
    }
  })
})
