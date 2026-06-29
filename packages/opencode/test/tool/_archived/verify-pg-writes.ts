/**
 * 验证 PG 数据库写入：Session.create → 手动插入 Message/Part → 查 PG 表确认
 *
 * Usage:
 *   OPENCODE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/opencode_test \
 *     bun run test/tool/verify-pg-writes.ts
 */
import { Effect, Layer, ManagedRuntime } from "effect"
import { Session } from "../../../src/session/session"
import { Bus } from "../../../src/bus"
import { Database } from "../../../src/storage/db"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
// TODO: merge-upstream — project.sql / ProjectTable location changed
// import { ProjectTable } from "../../../src/project/project.sql"
import { SessionID, MessageID, PartID } from "../../../src/session/schema"
import { provideTestInstance, disposeAllInstances } from "../../fixture/fixture"
import { eq } from "drizzle-orm"

const PG_URL = process.env["OPENCODE_DATABASE_URL"]
if (!PG_URL) {
  console.error("❌ OPENCODE_DATABASE_URL is not set")
  process.exit(1)
}

function section(title: string) {
  console.log(`\n━━━ ${title} ━━━`)
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  ❌ ${msg}`)
    throw new Error(`Assertion failed: ${msg}`)
  }
  console.log(`  ✅ ${msg}`)
}

console.log("╔══════════════════════════════════════════════════════════════╗")
console.log("║   Verify PG Writes: Session / Message / Part               ║")
console.log("╚══════════════════════════════════════════════════════════════╝")
console.log(`PG: ${PG_URL.replace(/:[^:@]*@/, ":***@")}`)

section("Step 0: 初始化 DB + 迁移")
await Database.initialize()
console.log(`  📦 Dialect: ${Database.dialect}`)
assert(Database.dialect === "pg", "确认使用 PG dialect")

section("Step 1: 确保 project 行存在")
const projectID = "proj_verify_test"
const now = Date.now()
await Database.use(async (db: any) => {
  const existing = await db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID))
  if (existing.length === 0) {
    await db.insert(ProjectTable).values({
      id: projectID,
      worktree: "/tmp/pg-verify",
      sandboxes: [],
      time_created: now,
      time_updated: now,
    })
    console.log(`  📝 插入 project: ${projectID}`)
  } else {
    console.log(`  📝 project 已存在: ${projectID}`)
  }
})

section("Step 2: 创建 Session 行")
const sessionID = SessionID.make("ses_pg_verify_" + Date.now())
await Database.use(async (db: any) => {
  await db.insert(SessionTable).values({
    id: sessionID,
    project_id: projectID,
    slug: "pg-verify",
    directory: "/tmp/pg-verify",
    title: "PG Verify Test",
    version: "1.0.0",
    time_created: now,
    time_updated: now,
  })
  console.log(`  📝 插入 session: ${sessionID}`)
})

section("Step 3: 插入 Message (模拟 user message)")
const msgID = MessageID.make("msg_pg_verify_" + Date.now())
await Database.use(async (db: any) => {
  await db.insert(MessageTable).values({
    id: msgID,
    session_id: sessionID,
    time_created: now,
    time_updated: now,
    data: { role: "user", content: "创建一个 Node.js 项目脚手架" },
  })
  console.log(`  📝 插入 message: ${msgID}`)
})

section("Step 4: 插入 Part (模拟 tool-invocation)")
const partID = PartID.make("part_pg_verify_" + Date.now())
await Database.use(async (db: any) => {
  await db.insert(PartTable).values({
    id: partID,
    message_id: msgID,
    session_id: sessionID,
    time_created: now,
    time_updated: now,
    data: {
      type: "tool-invocation",
      toolName: "write",
      toolCallId: "call_001",
      state: "result",
      args: { filePath: "package.json", content: '{"name":"sandbox-demo"}' },
      result: "Wrote file successfully",
    },
  })
  console.log(`  📝 插入 part: ${partID}`)
})

section("Step 5: 从 PG 读回验证")
const rows = await Database.use(async (db: any) => {
  const sessions = await db.select().from(SessionTable).where(eq(SessionTable.id, sessionID))
  const messages = await db.select().from(MessageTable).where(eq(MessageTable.session_id, sessionID))
  const parts = await db.select().from(PartTable).where(eq(PartTable.session_id, sessionID))
  return { sessions, messages, parts }
})

assert(rows.sessions.length === 1, `session 表有 1 行 (实际 ${rows.sessions.length})`)
assert(rows.sessions[0].title === "PG Verify Test", `session title === "PG Verify Test"`)
assert(rows.sessions[0].directory === "/tmp/pg-verify", `session directory 正确`)

assert(rows.messages.length === 1, `message 表有 1 行 (实际 ${rows.messages.length})`)
assert(rows.messages[0].data.role === "user", `message role === "user"`)
assert(rows.messages[0].data.content.includes("Node.js"), `message content 包含 "Node.js"`)

assert(rows.parts.length === 1, `part 表有 1 行 (实际 ${rows.parts.length})`)
assert(rows.parts[0].data.toolName === "write", `part toolName === "write"`)
assert(rows.parts[0].data.state === "result", `part state === "result"`)
assert(rows.parts[0].data.result === "Wrote file successfully", `part result 正确`)

section("Step 6: 直接 psql 查一下（交叉验证）")
const { execSync } = require("child_process")
const psqlCount = (table: string) => {
  const out = execSync(
    `docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -c "SELECT COUNT(*) FROM ${table}"`,
    { encoding: "utf-8" },
  ).trim()
  return parseInt(out, 10)
}

const sessionCount = psqlCount("session")
const messageCount = psqlCount("message")
const partCount = psqlCount("part")

console.log(`  📊 psql 直查: session=${sessionCount}, message=${messageCount}, part=${partCount}`)
assert(sessionCount >= 1, `psql: session 表至少 1 行`)
assert(messageCount >= 1, `psql: message 表至少 1 行`)
assert(partCount >= 1, `psql: part 表至少 1 行`)

console.log()
console.log("╔══════════════════════════════════════════════════════════════╗")
console.log("║                       ✅ ALL PASSED                          ║")
console.log("╚══════════════════════════════════════════════════════════════╝")

await Database.close()
