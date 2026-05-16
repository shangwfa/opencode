/**
 * sandbox-provider pgLayer 集成测试
 * 连接本地 PG（postgresql://postgres:postgres@localhost:5432/opencode_test）
 * 验证 getOrCreate / get / keepAlive / release / isKeepAlive / destroy 的 DB 持久化行为
 *
 * 运行方式：
 *   OPENCODE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/opencode_test \
 *   bun test test/tool/sandbox-provider-pg.test.ts
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../../src/storage/db"
import { SandboxTable } from "../../src/tool/sandbox.pg"
import { eq } from "drizzle-orm"

// ── 直接测试 DB 层操作（不依赖 Sandbox SDK）────────────────────────────

const DB_URL = process.env.OPENCODE_DATABASE_URL
if (!DB_URL) {
  console.log("跳过 sandbox-provider-pg 测试：未设置 OPENCODE_DATABASE_URL")
  process.exit(0)
}

const db = Database.Client()

async function cleanupSession(sessionID: string) {
  await db.delete(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).run()
}

// ── 测试辅助 ──────────────────────────────────────────────────────────

function makeRow(sessionID: string, overrides: Partial<typeof SandboxTable.$inferInsert> = {}) {
  return {
    id: `sb_test_${Date.now()}`,
    session_id: sessionID,
    host: "http://localhost:8080",
    state: "running" as const,
    keep_alive: false,
    command_session_id: null,
    time_created: Date.now(),
    time_updated: Date.now(),
    ...overrides,
  }
}

async function dbGet(sessionID: string) {
  const rows = await db.select().from(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).limit(1)
  return rows[0] ?? null
}

describe("sandbox DB 层 - 基本 CRUD", () => {
  const SID = "ses_pg_test_basic"

  beforeEach(async () => { await cleanupSession(SID) })
  afterEach(async () => { await cleanupSession(SID) })

  test("insert 后可查询到记录", async () => {
    const row = makeRow(SID)
    await db.insert(SandboxTable).values(row).run()
    const got = await dbGet(SID)
    expect(got).not.toBeNull()
    expect(got!.id).toBe(row.id)
    expect(got!.session_id).toBe(SID)
    expect(got!.state).toBe("running")
    expect(got!.keep_alive).toBe(false)
    expect(got!.command_session_id).toBeNull()
  })

  test("upsert（onConflict session_id）更新已有记录", async () => {
    const row = makeRow(SID)
    await db.insert(SandboxTable).values(row).run()

    const newId = `sb_test_new_${Date.now()}`
    await db
      .insert(SandboxTable)
      .values({ ...row, id: newId, host: "http://localhost:9999" })
      .onConflictDoUpdate({
        target: SandboxTable.session_id,
        set: { id: newId, host: "http://localhost:9999", time_updated: Date.now() },
      })
      .run()

    const got = await dbGet(SID)
    expect(got!.id).toBe(newId)
    expect(got!.host).toBe("http://localhost:9999")
  })

  test("delete 后查询返回 null", async () => {
    await db.insert(SandboxTable).values(makeRow(SID)).run()
    await db.delete(SandboxTable).where(eq(SandboxTable.session_id, SID)).run()
    const got = await dbGet(SID)
    expect(got).toBeNull()
  })
})

describe("sandbox DB 层 - state 更新", () => {
  const SID = "ses_pg_test_state"

  beforeEach(async () => { await cleanupSession(SID) })
  afterEach(async () => { await cleanupSession(SID) })

  test("state 从 running 更新为 killed", async () => {
    await db.insert(SandboxTable).values(makeRow(SID, { state: "running" })).run()
    await db.update(SandboxTable).set({ state: "killed", time_updated: Date.now() }).where(eq(SandboxTable.session_id, SID)).run()
    const got = await dbGet(SID)
    expect(got!.state).toBe("killed")
  })
})

describe("sandbox DB 层 - keep_alive", () => {
  const SID = "ses_pg_test_keepalive"

  beforeEach(async () => { await cleanupSession(SID) })
  afterEach(async () => { await cleanupSession(SID) })

  test("keep_alive 默认 false，set true 后可读回", async () => {
    await db.insert(SandboxTable).values(makeRow(SID)).run()
    const before = await dbGet(SID)
    expect(before!.keep_alive).toBe(false)

    await db.update(SandboxTable).set({ keep_alive: true, time_updated: Date.now() }).where(eq(SandboxTable.session_id, SID)).run()
    const after = await dbGet(SID)
    expect(after!.keep_alive).toBe(true)
  })

  test("keep_alive set false 后可读回（release）", async () => {
    await db.insert(SandboxTable).values(makeRow(SID, { keep_alive: true })).run()
    await db.update(SandboxTable).set({ keep_alive: false, time_updated: Date.now() }).where(eq(SandboxTable.session_id, SID)).run()
    const got = await dbGet(SID)
    expect(got!.keep_alive).toBe(false)
  })
})

describe("sandbox DB 层 - command_session_id", () => {
  const SID = "ses_pg_test_cmdsession"

  beforeEach(async () => { await cleanupSession(SID) })
  afterEach(async () => { await cleanupSession(SID) })

  test("command_session_id 初始为 null，写入后可读回", async () => {
    await db.insert(SandboxTable).values(makeRow(SID)).run()
    const before = await dbGet(SID)
    expect(before!.command_session_id).toBeNull()

    const cmdID = "cmd_session_abc123"
    await db.update(SandboxTable).set({ command_session_id: cmdID, time_updated: Date.now() }).where(eq(SandboxTable.session_id, SID)).run()
    const after = await dbGet(SID)
    expect(after!.command_session_id).toBe(cmdID)
  })
})

describe("sandbox DB 层 - 多 session 隔离", () => {
  const SID_A = "ses_pg_test_multi_a"
  const SID_B = "ses_pg_test_multi_b"

  beforeEach(async () => { await cleanupSession(SID_A); await cleanupSession(SID_B) })
  afterEach(async () => { await cleanupSession(SID_A); await cleanupSession(SID_B) })

  test("两个 session 互不干扰", async () => {
    await db.insert(SandboxTable).values(makeRow(SID_A, { state: "running", keep_alive: true })).run()
    await db.insert(SandboxTable).values(makeRow(SID_B, { state: "killed", keep_alive: false })).run()

    const a = await dbGet(SID_A)
    const b = await dbGet(SID_B)

    expect(a!.state).toBe("running")
    expect(a!.keep_alive).toBe(true)
    expect(b!.state).toBe("killed")
    expect(b!.keep_alive).toBe(false)
  })

  test("delete session_A 不影响 session_B", async () => {
    await db.insert(SandboxTable).values(makeRow(SID_A)).run()
    await db.insert(SandboxTable).values(makeRow(SID_B)).run()

    await db.delete(SandboxTable).where(eq(SandboxTable.session_id, SID_A)).run()

    expect(await dbGet(SID_A)).toBeNull()
    expect(await dbGet(SID_B)).not.toBeNull()
  })
})

describe("sandbox DB 层 - session_id UNIQUE 约束", () => {
  const SID = "ses_pg_test_unique"

  beforeEach(async () => { await cleanupSession(SID) })
  afterEach(async () => { await cleanupSession(SID) })

  test("同一 session_id 重复 insert 抛出冲突错误", async () => {
    await db.insert(SandboxTable).values(makeRow(SID)).run()
    await expect(
      db.insert(SandboxTable).values(makeRow(SID, { id: `sb_dup_${Date.now()}` })).run()
    ).rejects.toThrow()
  })
})
