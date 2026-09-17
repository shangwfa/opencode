// exec_log 悬空 running 行清扫（PG-gated）：
//   实例死亡后无人写终态的 running 行，超 24h（STALE_RUNNING_MS）被终态化为
//   failed("instance lost")；未超期 running 与终态行不动。
// 需要本地测试库：
//   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:15432/opencode_test bun test test/session/exec-log-reap-pg.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import postgres from "postgres"
import { eq } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { ExecLogTable, STALE_RUNNING_MS, insertExecLog, reapStaleRunning } from "../../src/session/exec-log"
import { SessionTable } from "../../src/session/session.pg"
import type { SessionID } from "../../src/session/schema"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()
const db = enabled ? Database.Client() : undefined
const fixtureDb = DB_URL ? postgres(DB_URL as string) : undefined

const DIRECTORY = "/tmp/exec-reap-test"
const PROJECT_ID = "exec-reap-test-project"
let sequence = 0

const sessions: string[] = []
const logIDs: string[] = []

async function createSession() {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const sessionID = `ses_exreap_${Date.now()}_${++sequence}` as SessionID
  const now = Date.now()
  await fixtureDb.unsafe(
    `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [PROJECT_ID, DIRECTORY, now, now, []],
  )
  await fixtureDb.unsafe(
    `INSERT INTO session (
       id, project_id, directory, slug, title, version, time_created, time_updated,
       cost, tokens_input, tokens_output, tokens_reasoning
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0, 0)`,
    [sessionID, PROJECT_ID, DIRECTORY, "exec-reap-test", "Exec reap test", "test", now, now],
  )
  sessions.push(sessionID)
  return sessionID
}

async function insertLog(input: { id: string; sessionID: string; status: string; timeStarted: number }) {
  await insertExecLog({
    id: input.id,
    session_id: input.sessionID as never,
    command: JSON.stringify({ probe: input.id }),
    status: input.status as never,
    source: "tool-call",
    time_started: input.timeStarted,
    time_finished: input.status === "running" ? undefined : input.timeStarted + 1000,
  })
  logIDs.push(input.id)
}

async function logRow(id: string) {
  const rows = (await db!.select().from(ExecLogTable).where(eq(ExecLogTable.id, id)).limit(1)) as unknown as Array<{
    status: string
    rule: string | null
    time_finished: number | null
  }>
  return rows[0]
}

describe.skipIf(!enabled)("exec_log stale running reap (PG)", () => {
  beforeAll(async () => {
    await Database.initialize()
  })

  afterAll(async () => {
    if (!fixtureDb) return
    await fixtureDb.unsafe("DELETE FROM project WHERE id = $1", [PROJECT_ID])
    await fixtureDb.end()
  })

  afterEach(async () => {
    for (const id of logIDs) await db!.delete(ExecLogTable).where(eq(ExecLogTable.id, id)).run()
    for (const sid of sessions)
      await db!
        .delete(SessionTable)
        .where(eq(SessionTable.id, sid as never))
        .run()
    logIDs.length = 0
    sessions.length = 0
  })

  test("terminalizes only over-age running rows", async () => {
    const sessionID = await createSession()
    const now = Date.now()
    // 超期 running（应终态化）
    await insertLog({
      id: `reap_old_${++sequence}`,
      sessionID,
      status: "running",
      timeStarted: now - STALE_RUNNING_MS - 60_000,
    })
    // 未超期 running（应保留：实例可能仍在合法执行）
    const freshID = `reap_fresh_${++sequence}`
    await insertLog({ id: freshID, sessionID, status: "running", timeStarted: now - 60_000 })
    // 终态行（应保留且不被改写）
    const doneID = `reap_done_${++sequence}`
    await insertLog({ id: doneID, sessionID, status: "completed", timeStarted: now - STALE_RUNNING_MS - 60_000 })
    const overAgeID = logIDs[0]!

    const count = await reapStaleRunning()
    expect(count).toBeGreaterThanOrEqual(1)

    const aged = await logRow(overAgeID)
    expect(aged?.status).toBe("failed")
    expect(aged?.rule).toContain("instance lost")
    expect(aged?.time_finished).not.toBeNull()

    expect((await logRow(freshID))?.status).toBe("running")
    expect((await logRow(doneID))?.status).toBe("completed")
  })

  test("re-runs are idempotent (nothing left to reap)", async () => {
    const sessionID = await createSession()
    const now = Date.now()
    await insertLog({
      id: `reap_idem_${++sequence}`,
      sessionID,
      status: "running",
      timeStarted: now - STALE_RUNNING_MS - 60_000,
    })
    const first = await reapStaleRunning()
    expect(first).toBeGreaterThanOrEqual(1)
    const second = await reapStaleRunning()
    expect(second).toBe(0)
  })
})
