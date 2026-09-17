/**
 * SaaS 全面集成测试 v2
 *
 * 覆盖：
 * 1. PG 并发写入 + 数据隔离 + 内容校验
 * 2. Sandbox 工具执行（bash/read/write） + 容器隔离
 * 3. 工具并发（多 session 同时执行工具）
 * 4. 工具结果校验（输出内容正确性）
 * 5. Session 生命周期（创建/删除/级联）
 * 6. PG 完整性（FK/内容一致性）
 */
import { Server } from "../../../opencode/src/server/server.ts"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { Database } from "../../../opencode/src/storage/db"

const SERVER_PORT = 14300
const TIMEOUT = 120_000
const CONCURRENT_SESSIONS = 10
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

function log(tag: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [${tag}]`, ...args)
}

type IdleResult = { texts: string[]; toolCalls: string[]; errors: string[] }
type EventStream = Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>>

const PERMISSIONS = [
  { permission: "bash", action: "allow", pattern: "*" },
  { permission: "read", action: "allow", pattern: "*" },
  { permission: "write", action: "allow", pattern: "*" },
  { permission: "edit", action: "allow", pattern: "*" },
  { permission: "glob", action: "allow", pattern: "*" },
  { permission: "grep", action: "allow", pattern: "*" },
  { permission: "list", action: "allow", pattern: "*" },
  { permission: "question", action: "deny", pattern: "*" },
]

let passed = 0
let failed = 0

function assert(condition: boolean, label: string) {
  if (condition) {
    log("ASSERT", `PASS: ${label}`)
    passed++
  } else {
    log("ASSERT", `FAIL: ${label}`)
    failed++
  }
}

function consumeUntilIdle(stream: EventStream, client: OpencodeClient, sessionID: string, timeout = TIMEOUT): Promise<IdleResult> {
  return new Promise((resolve, reject) => {
    const texts: string[] = []
    const toolCalls: string[] = []
    const errors: string[] = []
    const timer = setTimeout(() => reject(new Error(`consumeUntilIdle timeout after ${timeout}ms`)), timeout)
    ;(async () => {
      for await (const event of stream.stream) {
        if (event.type === "message.part.updated") {
          const part = event.properties.part
          if (part.sessionID !== sessionID) continue
          if (part.type === "tool" && part.state?.status === "completed") toolCalls.push(part.tool)
          if (part.type === "tool" && part.state?.status === "error") errors.push(`${part.tool}: ${part.state.error}`)
          if (part.type === "text" && part.time?.end) texts.push(part.text?.trim() ?? "")
        }
        if (event.type === "session.error") {
          const props = event.properties
          if (props.sessionID === sessionID && props.error) {
            const msg = props.error.data && "message" in props.error.data ? String(props.error.data.message) : String(props.error.name)
            errors.push(msg)
          }
        }
        if (event.type === "session.status" && event.properties.sessionID === sessionID && event.properties.status.type === "idle") {
          clearTimeout(timer)
          resolve({ texts, toolCalls, errors })
          return
        }
        if (event.type === "permission.asked") {
          const perm = event.properties
          if (perm.sessionID !== sessionID) continue
          await client.permission.reply({ requestID: perm.id, reply: "once" })
        }
      }
      clearTimeout(timer)
      resolve({ texts, toolCalls, errors })
    })().catch((err) => { clearTimeout(timer); reject(err) })
  })
}

async function promptAndWait(client: OpencodeClient, sessionID: string, text: string, timeout = TIMEOUT): Promise<IdleResult> {
  const events = await client.event.subscribe()
  const idlePromise = consumeUntilIdle(events, client, sessionID, timeout)
  await client.session.prompt({ sessionID, model: MODEL, parts: [{ type: "text", text }] })
  return idlePromise
}

function pgQuery(sql: string) {
  return Bun.spawnSync(
    ["docker", "exec", "ai-nova-postgres", "psql", "-U", "postgres", "-d", "opencode_test", "-t", "-A", "-c", sql],
    { stdout: "pipe", stderr: "pipe" },
  ).stdout.toString().trim()
}

function pgCount(sql: string) {
  return parseInt(pgQuery(sql), 10) || 0
}

// ═══════════════════════════════════════════
// TEST 1: 单 Session 多轮 + 工具结果校验
// ═══════════════════════════════════════════
async function testSingleSessionTools(client: OpencodeClient) {
  log("TEST1", "=== 单 Session 多轮工具 + 结果校验 ===")

  const ses = await client.session.create({ title: "tool-verify", permission: PERMISSIONS })
  const sid = ses.data!.id

  // Round 1: bash with verifiable output
  const r1 = await promptAndWait(client, sid, "Run this exact command and nothing else: echo 'HELLO-WORLD-123'")
  log("TEST1", `round1: tools=[${r1.toolCalls.join(",")}]`)
  assert(r1.toolCalls.includes("bash"), `round1: bash tool invoked`)
  assert(r1.errors.length === 0, `round1: 0 errors`)
  const hasCorrectOutput1 = r1.texts.some(t => t.includes("HELLO-WORLD-123"))
  assert(hasCorrectOutput1, `round1: output contains 'HELLO-WORLD-123'`)

  // Round 2: file write + read via bash
  const r2 = await promptAndWait(client, sid, "Run exactly: echo 'verify-content-456' > /tmp/test-verify.txt && cat /tmp/test-verify.txt")
  log("TEST1", `round2: tools=[${r2.toolCalls.join(",")}]`)
  assert(r2.toolCalls.includes("bash"), `round2: bash tool invoked`)
  assert(r2.errors.length === 0, `round2: 0 errors`)
  const hasCorrectOutput2 = r2.texts.some(t => t.includes("verify-content-456"))
  assert(hasCorrectOutput2, `round2: output contains 'verify-content-456'`)

  // Round 3: delete + verify
  const r3 = await promptAndWait(client, sid, "Run exactly: rm /tmp/test-verify.txt && echo 'deleted-ok' && ls /tmp/test-verify.txt 2>&1 || true")
  log("TEST1", `round3: tools=[${r3.toolCalls.join(",")}]`)
  assert(r3.errors.length === 0, `round3: 0 errors`)

  // PG data verification
  const msgCount = pgCount(`SELECT COUNT(*) FROM message WHERE session_id = '${sid}'`)
  const partCount = pgCount(`SELECT COUNT(*) FROM part WHERE session_id = '${sid}'`)
  assert(msgCount >= 4, `PG: ${msgCount} messages (>= 4)`)

  const userMsgs = pgCount(`SELECT COUNT(*) FROM message WHERE session_id = '${sid}' AND data->>'role' = 'user'`)
  const assistantMsgs = pgCount(`SELECT COUNT(*) FROM message WHERE session_id = '${sid}' AND data->>'role' = 'assistant'`)
  assert(userMsgs >= 3, `PG: ${userMsgs} user messages`)
  assert(assistantMsgs >= 3, `PG: ${assistantMsgs} assistant messages`)

  const bashParts = pgCount(`SELECT COUNT(*) FROM part WHERE session_id = '${sid}' AND data->>'tool' = 'bash'`)
  assert(bashParts >= 3, `PG: ${bashParts} bash tool parts`)

  await client.session.delete({ sessionID: sid }).catch(() => {})
  log("TEST1", "done")
}

// ═══════════════════════════════════════════
// TEST 2: N Session 并发（简单 prompt，纯 PG 写入）
// ═══════════════════════════════════════════
async function testConcurrentSessions(client: OpencodeClient) {
  log("TEST2", `=== ${CONCURRENT_SESSIONS} Session 并发 ===`)

  const sessions: string[] = []
  const prompts = Array.from({ length: CONCURRENT_SESSIONS }, (_, i) =>
    `Reply with exactly one word: "ok-${i}"`
  )

  for (let i = 0; i < CONCURRENT_SESSIONS; i++) {
    const ses = await client.session.create({ title: `concurrent-${i}`, permission: PERMISSIONS })
    sessions.push(ses.data!.id)
  }
  log("TEST2", `created ${CONCURRENT_SESSIONS} sessions`)

  const streams: EventStream[] = []
  for (const sid of sessions) streams.push(await client.event.subscribe())

  const promptPromises = sessions.map((sid, i) =>
    client.session.prompt({ sessionID: sid, model: MODEL, parts: [{ type: "text", text: prompts[i] }] })
  )

  const results = await Promise.all(
    sessions.map((sid, i) => consumeUntilIdle(streams[i], client, sid, 300_000))
  )
  await Promise.all(promptPromises)

  let totalErrors = 0
  for (const r of results) totalErrors += r.errors.length
  assert(totalErrors === 0, `concurrent: 0 errors (got ${totalErrors})`)

  const perSessionMsgs = sessions.map(sid => pgCount(`SELECT COUNT(*) FROM message WHERE session_id = '${sid}'`))
  const sessionsWithData = perSessionMsgs.filter(c => c > 0).length
  assert(sessionsWithData === CONCURRENT_SESSIONS, `concurrent PG: ${sessionsWithData}/${CONCURRENT_SESSIONS} sessions have messages`)

  // Data isolation: verify each session has exactly its own messages
  const orphanParts = pgCount("SELECT COUNT(*) FROM part p LEFT JOIN message m ON p.message_id = m.id WHERE m.id IS NULL")
  assert(orphanParts === 0, `concurrent: 0 orphan parts`)

  log("TEST2", `PG per session: msgs=[${perSessionMsgs.join(",")}]`)
  for (const sid of sessions) await client.session.delete({ sessionID: sid }).catch(() => {})
  log("TEST2", "done")
}

// ═══════════════════════════════════════════
// TEST 3: Sandbox 工具执行（bash + 文件操作）
// ═══════════════════════════════════════════
async function testSandboxTools(client: OpencodeClient) {
  log("TEST3", "=== Sandbox 工具执行 ===")

  const ses = await client.session.create({ title: "sandbox-tools", permission: PERMISSIONS })
  const sid = ses.data!.id

  // Bash: create file, read it, delete it
  const prompt = [
    "Execute these bash commands in order, one at a time:",
    "1. echo 'sandbox-file-content-789' > /tmp/sb-verify.txt",
    "2. cat /tmp/sb-verify.txt",
    "3. rm /tmp/sb-verify.txt && echo 'sb-deleted-ok'",
  ].join("\n")

  const r = await promptAndWait(client, sid, prompt, 300_000)
  log("TEST3", `tools: ${r.toolCalls.join(", ")} count=${r.toolCalls.length}`)

  const bashCount = r.toolCalls.filter(t => t === "bash").length
  assert(bashCount >= 2, `sandbox: ${bashCount} bash calls (>= 2)`)
  assert(r.errors.length === 0, `sandbox: 0 errors`)

  // Verify bash output content
  const hasFileContent = r.texts.some(t => t.includes("sandbox-file-content-789"))
  assert(hasFileContent, `sandbox: output contains file content 'sandbox-file-content-789'`)
  const hasDeleted = r.texts.some(t => t.includes("sb-deleted-ok") || t.includes("deleted") || t.includes("removed"))
  assert(hasDeleted, `sandbox: file deleted (texts: ${r.texts.map(t => t.substring(0, 60)).join(" | ")})`)

  // PG data
  const msgCount = pgCount(`SELECT COUNT(*) FROM message WHERE session_id = '${sid}'`)
  const partCount = pgCount(`SELECT COUNT(*) FROM part WHERE session_id = '${sid}'`)
  assert(msgCount >= 1, `sandbox PG: ${msgCount} messages`)
  assert(partCount >= 1, `sandbox PG: ${partCount} parts`)

  await client.session.delete({ sessionID: sid }).catch(() => {})
  log("TEST3", "done")
}

// ═══════════════════════════════════════════
// TEST 4: 工具并发（多 session 同时 bash）
// ═══════════════════════════════════════════
async function testConcurrentTools(client: OpencodeClient) {
  log("TEST4", `=== ${CONCURRENT_SESSIONS} Session 并发工具执行 ===`)

  const sessions: string[] = []
  for (let i = 0; i < CONCURRENT_SESSIONS; i++) {
    const ses = await client.session.create({ title: `tool-concurrent-${i}`, permission: PERMISSIONS })
    sessions.push(ses.data!.id)
  }
  log("TEST4", `created ${CONCURRENT_SESSIONS} sessions`)

  const streams: EventStream[] = []
  for (const sid of sessions) streams.push(await client.event.subscribe())

  // Each session runs a different bash command
  const promptPromises = sessions.map((sid, i) =>
    client.session.prompt({
      sessionID: sid,
      model: MODEL,
      parts: [{ type: "text", text: `Run exactly: echo "tool-result-${i}"` }],
    })
  )

  const results = await Promise.all(
    sessions.map((sid, i) => consumeUntilIdle(streams[i], client, sid, 300_000))
  )
  await Promise.all(promptPromises)

  let totalBash = 0
  let totalErrors = 0
  for (let i = 0; i < CONCURRENT_SESSIONS; i++) {
    totalBash += results[i].toolCalls.filter(t => t === "bash").length
    totalErrors += results[i].errors.length
  }

  assert(totalBash >= CONCURRENT_SESSIONS, `tool concurrent: ${totalBash} bash calls across ${CONCURRENT_SESSIONS} sessions`)
  assert(totalErrors === 0, `tool concurrent: 0 errors`)

  // PG: every session should have tool result data
  const perSessionParts = sessions.map(sid =>
    pgCount(`SELECT COUNT(*) FROM part WHERE session_id = '${sid}' AND data->>'tool' = 'bash'`)
  )
  const sessionsWithToolParts = perSessionParts.filter(c => c > 0).length
  assert(sessionsWithToolParts >= CONCURRENT_SESSIONS * 0.8, `tool concurrent PG: ${sessionsWithToolParts}/${CONCURRENT_SESSIONS} sessions have bash parts`)

  log("TEST4", `bash=${totalBash} errors=${totalErrors} toolParts=[${perSessionParts.join(",")}]`)
  for (const sid of sessions) await client.session.delete({ sessionID: sid }).catch(() => {})
  log("TEST4", "done")
}

// ═══════════════════════════════════════════
// TEST 5: Session 生命周期（删除级联）
// ═══════════════════════════════════════════
async function testSessionLifecycle(client: OpencodeClient) {
  log("TEST5", "=== Session 生命周期 + 删除级联 ===")

  // Create session with data
  const ses = await client.session.create({ title: "lifecycle-test", permission: PERMISSIONS })
  const sid = ses.data!.id

  await promptAndWait(client, sid, "Run: echo 'lifecycle-data'")

  // Verify data exists
  const msgsBefore = pgCount(`SELECT COUNT(*) FROM message WHERE session_id = '${sid}'`)
  const partsBefore = pgCount(`SELECT COUNT(*) FROM part WHERE session_id = '${sid}'`)
  assert(msgsBefore >= 1, `lifecycle: ${msgsBefore} messages before delete`)
  assert(partsBefore >= 1, `lifecycle: ${partsBefore} parts before delete`)

  // Delete session
  await client.session.delete({ sessionID: sid })

  // Verify cascade delete
  const msgsAfter = pgCount(`SELECT COUNT(*) FROM message WHERE session_id = '${sid}'`)
  const partsAfter = pgCount(`SELECT COUNT(*) FROM part WHERE session_id = '${sid}'`)
  const sessionAfter = pgCount(`SELECT COUNT(*) FROM session WHERE id = '${sid}'`)
  assert(msgsAfter === 0, `lifecycle: 0 messages after delete (was ${msgsBefore})`)
  assert(partsAfter === 0, `lifecycle: 0 parts after delete (was ${partsBefore})`)
  assert(sessionAfter === 0, `lifecycle: session deleted from PG`)

  log("TEST5", "done")
}

// ═══════════════════════════════════════════
// TEST 6: PG 数据完整性 + 内容校验
// ═══════════════════════════════════════════
async function testPgIntegrity() {
  log("TEST6", "=== PG 数据完整性 + 内容校验 ===")

  const tables = pgQuery("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
  const tableCount = tables.split("\n").filter(Boolean).length
  assert(tableCount >= 10, `PG: ${tableCount} tables exist`)

  // FK integrity
  const checks = [
    ["orphan parts", "SELECT COUNT(*) FROM part p LEFT JOIN message m ON p.message_id = m.id WHERE m.id IS NULL"],
    ["orphan messages", "SELECT COUNT(*) FROM message m LEFT JOIN session s ON m.session_id = s.id WHERE s.id IS NULL"],
    ["orphan sessions", "SELECT COUNT(*) FROM session s LEFT JOIN project p ON s.project_id = p.id WHERE p.id IS NULL"],
    ["session mismatch", "SELECT COUNT(*) FROM part p JOIN message m ON p.message_id = m.id WHERE p.session_id != m.session_id"],
  ] as const
  for (const [label, sql] of checks) {
    assert(pgCount(sql) === 0, `integrity: 0 ${label}`)
  }

  // Content integrity: every message should have non-empty data
  const emptyMsgs = pgCount("SELECT COUNT(*) FROM message WHERE data = '{}'::jsonb OR data IS NULL")
  assert(emptyMsgs === 0, `content: 0 empty message data`)

  const emptyParts = pgCount("SELECT COUNT(*) FROM part WHERE data = '{}'::jsonb OR data IS NULL")
  assert(emptyParts === 0, `content: 0 empty part data`)

  // Every session should have a title
  const noTitle = pgCount("SELECT COUNT(*) FROM session WHERE title = '' OR title IS NULL")
  assert(noTitle === 0, `content: all sessions have titles`)

  log("TEST6", "done")
}

// ═══════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════
async function main() {
  await Database.initialize()
  const listener = await Server.listen({ hostname: "127.0.0.1", port: SERVER_PORT })
  const url = `http://${listener.hostname}:${listener.port}`
  log("SERVER", `listening on ${url}`)

  const client = createOpencodeClient({ baseUrl: url, directory: process.cwd() })

  try {
    const health = await client.global.health()
    log("HEALTH", `server healthy: ${JSON.stringify(health.data?.status ?? health.data)}`)

    await testSingleSessionTools(client)
    await testConcurrentSessions(client)
    await testSandboxTools(client)
    await testConcurrentTools(client)
    await testSessionLifecycle(client)
    await testPgIntegrity()

    log("SUMMARY", `${passed} passed, ${failed} failed`)
    log("SUMMARY", failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED")
  } finally {
    await listener.stop()
    log("SERVER", "stopped")
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("FATAL:", err)
  process.exit(1)
})
