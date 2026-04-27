/**
 * PG 数据库测试 v2：第一次 prompt 事件可能并发导致 FK 被吞，
 * 第二次 prompt 验证数据一定能写入
 */
import { Server } from "../../../opencode/src/server/server.ts"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { Database } from "../../../opencode/src/storage/db"

const SERVER_PORT = 14100
const TIMEOUT = 300_000

function log(tag: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [${tag}]`, ...args)
}

async function waitForIdle(client: OpencodeClient, sessionID: string, timeout = TIMEOUT) {
  const texts: string[] = []
  const toolCalls: string[] = []
  const errors: string[] = []

  const events = await client.event.subscribe()
  const deadline = Date.now() + timeout

  for await (const event of events.stream) {
    if (Date.now() > deadline) throw new Error(`timeout after ${timeout}ms`)
    if (event.type === "message.part.updated") {
      const part = event.properties.part
      if (part.sessionID !== sessionID) continue
      if (part.type === "tool" && part.state?.status === "completed") toolCalls.push(part.tool)
      if (part.type === "tool" && part.state?.status === "error") errors.push(`${part.tool}: ${part.state.error}`)
      if (part.type === "text" && part.time?.end) texts.push(part.text?.trim() ?? "")
    }
    if (event.type === "session.status" && event.properties.sessionID === sessionID && event.properties.status.type === "idle") break
    if (event.type === "permission.asked") {
      const perm = event.properties
      if (perm.sessionID !== sessionID) continue
      await client.permission.reply({ requestID: perm.id, reply: "once" })
    }
  }
  return { texts, toolCalls, errors }
}

async function main() {
  // ── 启动 server ──
  await Database.initialize()
  const listener = await Server.listen({ hostname: "127.0.0.1", port: SERVER_PORT })
  const url = `http://${listener.hostname}:${listener.port}`
  log("SERVER", `listening on ${url}`)

  const client = createOpencodeClient({ baseUrl: url, directory: process.cwd() })

  try {
    // ── Session 创建 ──
    const ses = await client.session.create({
      title: "pg-test-v2",
      permission: [
        { permission: "bash", action: "allow", pattern: "*" },
        { permission: "read", action: "allow", pattern: "*" },
        { permission: "question", action: "deny", pattern: "*" },
      ],
    })
    const sid = ses.data!.id
    log("TEST", `session: ${sid}`)

    // ── Prompt 1：简单 bash ──
    await client.session.prompt({ sessionID: sid, parts: [{ type: "text", text: 'Run: echo "pg test 1"' }] })
    const r1 = await waitForIdle(client, sid)
    log("PROMPT1", `tools: ${r1.toolCalls.join(",") || "none"}, errors: ${r1.errors.length}`)

    // ── 等待 2 秒确保事件都处理完 ──
    await new Promise((r) => setTimeout(r, 2000))

    // ── Prompt 2：第二个 bash ──
    await client.session.prompt({ sessionID: sid, parts: [{ type: "text", text: 'Run: echo "pg test 2" && date -u' }] })
    const r2 = await waitForIdle(client, sid)
    log("PROMPT2", `tools: ${r2.toolCalls.join(",") || "none"}, errors: ${r2.errors.length}`)

    // ── 查询 PG ──
    const q = (sql: string) => Bun.spawnSync(
      ["docker", "exec", "ai-nova-postgres", "psql", "-U", "postgres", "-d", "opencode_test", "-t", "-c", sql],
      { stdout: "pipe", stderr: "pipe" },
    )
    const count = (out: string) => out.trim().split("\n").filter(Boolean).length

    const tables = q("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
    log("PG", `tables: ${count(tables.stdout.toString())}`)

    const sessions = q("SELECT id, title FROM session")
    log("PG", `sessions: ${count(sessions.stdout.toString())}`)

    const messages = q("SELECT id, session_id FROM message")
    log("PG", `messages: ${count(messages.stdout.toString())}`)

    const parts = q("SELECT id, message_id FROM part")
    log("PG", `parts: ${count(parts.stdout.toString())}`)

    const msgs = q("SELECT m.id, m.session_id, p.id as part_id FROM message m LEFT JOIN part p ON p.message_id = m.id WHERE m.session_id = (SELECT id FROM session LIMIT 1)")
    log("PG", `detail:\n${msgs.stdout.toString().trim()}`)

    const nSessions = count(sessions.stdout.toString())
    const nMessages = count(messages.stdout.toString())
    const nParts = count(parts.stdout.toString())

    log("ASSERT", nSessions >= 1 ? `PASS: ${nSessions} session(s)` : `FAIL: ${nSessions}`)
    log("ASSERT", nMessages >= 1 ? `PASS: ${nMessages} message(s)` : `FAIL: ${nMessages}`)
    log("ASSERT", nParts >= 1 ? `PASS: ${nParts} part(s)` : `FAIL: ${nParts}`)

    const ok = nSessions >= 1 && nMessages >= 1 && nParts >= 1
    log("SUMMARY", ok ? "PASS: PG data written correctly" : "FAIL")

    await client.session.delete({ sessionID: sid }).catch(() => {})
  } finally {
    await listener.stop()
    log("SERVER", "stopped")
  }
}

main().catch((err) => {
  console.error("FATAL:", err)
  process.exit(1)
})
