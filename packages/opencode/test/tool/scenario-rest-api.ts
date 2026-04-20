/**
 * 通过 REST API 异步触发 agent，使用 SSE 监听完成事件，验证 PG 落库。
 *
 * 流程:
 *   1. POST /session            → 创建 session
 *   2. POST /session/:id/prompt_async → 异步发送消息（立即返回 204）
 *   3. GET  /event              → SSE 监听 session.idle 事件（agent 完成）
 *   4. GET  /session/:id/message → 获取结果
 *   5. 查 PG 验证数据完整性
 *
 * Usage:
 *   OPENCODE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/opencode_test \
 *   OPENCODE_SANDBOX_ENABLED=true \
 *   OPENCODE_SANDBOX_DOMAIN=localhost:8080 \
 *   OPENCODE_SANDBOX_IMAGE=opensandbox/code-interpreter-rg \
 *   bun run test/tool/scenario-rest-api.ts
 */
import { execSync } from "child_process"

const PG_URL = process.env["OPENCODE_DATABASE_URL"]
if (!PG_URL) {
  console.error("OPENCODE_DATABASE_URL is required")
  process.exit(1)
}

const PORT = 19876
const BASE = `http://localhost:${PORT}`
const TIMEOUT_MS = 600_000

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

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now()
  const result = await fn()
  console.log(`  ⏱  ${label}: ${(performance.now() - start).toFixed(0)}ms`)
  return result
}

const pgQuery = (sql: string) =>
  execSync(`docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -c "${sql}"`, { encoding: "utf-8" }).trim()

console.log("╔══════════════════════════════════════════════════════════════╗")
console.log("║   REST API Scenario: async trigger + SSE + PG 落库验证      ║")
console.log("╚══════════════════════════════════════════════════════════════╝")
console.log(`PG: ${PG_URL.replace(/:[^:@]*@/, ":***@")}`)

let server: ReturnType<typeof Bun.spawn> | undefined

try {
  // ── Step 0: 清空 PG ──
  section("Step 0: 清空 PG 数据")
  execSync(`docker exec ai-nova-postgres psql -U postgres -d opencode_test -c "
    DO \\$\\$
    DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '__drizzle_migrations') LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END \\$\\$"`)
  console.log("  ✅ PG 已清空")

  // ── Step 1: 启动 opencode serve ──
  section("Step 1: 启动 opencode serve")
  server = Bun.spawn(["bun", "run", "src/index.ts", "serve", "--port", String(PORT), "--hostname", "localhost"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENCODE_DATABASE_URL: PG_URL,
      OPENCODE_SANDBOX_ENABLED: process.env["OPENCODE_SANDBOX_ENABLED"] || "false",
      OPENCODE_SANDBOX_DOMAIN: process.env["OPENCODE_SANDBOX_DOMAIN"] || "localhost:8080",
      OPENCODE_SANDBOX_IMAGE: process.env["OPENCODE_SANDBOX_IMAGE"] || "opensandbox/code-interpreter-rg",
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  for (let i = 0; i < 60; i++) {
    await Bun.sleep(500)
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) break
    } catch {}
    if (i === 59) throw new Error("Server failed to start in 30s")
  }
  console.log(`  ✅ Server 启动: ${BASE} (PID=${server.pid})`)

  // ── Step 2: 创建 session ──
  section("Step 2: 创建 Session")
  const sessionRes = await time("POST /session", async () => {
    const r = await fetch(`${BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    assert(r.ok, `创建 session 返回 ${r.status}`)
    return r.json() as Promise<{ id: string }>
  })
  const sessionID = sessionRes.id
  console.log(`  📦 Session: ${sessionID}`)

  // ── Step 3: 连接 SSE 事件流 ──
  section("Step 3: 连接 SSE 事件流")
  const idlePromise = new Promise<{ sessionID: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("SSE timeout waiting for session.idle")), TIMEOUT_MS)

    fetch(`${BASE}/event`).then((response) => {
      if (!response.ok || !response.body) {
        reject(new Error(`SSE connection failed: ${response.status}`))
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) { clearTimeout(timeout); reject(new Error("SSE stream closed")); return }

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            try {
              const event = JSON.parse(line.slice(6))
              if (event.type === "server.connected") {
                console.log("  📡 SSE connected")
                continue
              }
              if (event.type === "session.idle" && event.properties?.sessionID === sessionID) {
                clearTimeout(timeout)
                console.log("  📡 SSE: session.idle received")
                resolve(event.properties)
                reader.cancel()
                return
              }
            } catch {}
          }
        }
      }
      pump()
    }).catch(reject)
  })

  // ── Step 4: 异步发送消息 ──
  section("Step 4: 异步发送消息 (prompt_async)")
  const prompt = "Create 3 files in the current directory: (1) hello.txt with content 'Hello World' (2) foo.txt with content 'Foo Bar' (3) run 'cat hello.txt foo.txt' to verify"

  await time("POST prompt_async", async () => {
    const r = await fetch(`${BASE}/session/${sessionID}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: prompt }],
      }),
    })
    assert(r.status === 204, `prompt_async 返回 ${r.status}`)
  })
  console.log("  📤 Agent 已异步触发，等待完成...")

  // ── Step 5: 等待 SSE idle 事件 ──
  section("Step 5: 等待 agent 完成 (SSE)")
  const start = Date.now()
  await idlePromise
  console.log(`  ⏱  Agent 耗时: ${((Date.now() - start) / 1000).toFixed(1)}s`)

  // ── Step 6: 获取消息列表 ──
  section("Step 6: 获取消息结果")
  const messages: any[] = await time("GET /session/{id}/message", async () => {
    const r = await fetch(`${BASE}/session/${sessionID}/message`)
    assert(r.ok, `获取消息返回 ${r.status}`)
    return r.json()
  })

  console.log(`  📬 消息数: ${messages.length}`)
  for (const m of messages) {
    const role = m.info?.role ?? "?"
    const parts = m.parts?.length ?? 0
    console.log(`    ${role}: ${parts} parts`)
  }

  // ── Step 7: PG 验证 ──
  section("Step 7: PG 数据验证")

  const sessionCount = parseInt(pgQuery(`SELECT COUNT(*) FROM session WHERE id = '${sessionID}'`), 10)
  assert(sessionCount === 1, `session 表有 1 行 (实际 ${sessionCount})`)

  const msgCount = parseInt(pgQuery(`SELECT COUNT(*) FROM message WHERE session_id = '${sessionID}'`), 10)
  assert(msgCount >= 2, `message 表至少 2 行 (实际 ${msgCount})`)

  const partCount = parseInt(pgQuery(`SELECT COUNT(*) FROM part WHERE session_id = '${sessionID}'`), 10)
  assert(partCount >= 1, `part 表至少 1 行 (实际 ${partCount})`)
  console.log(`  📊 PG: session=${sessionCount}, message=${msgCount}, part=${partCount}`)

  const tools = pgQuery(`SELECT DISTINCT data->>'tool' FROM part WHERE session_id = '${sessionID}' AND data->>'tool' IS NOT NULL`)
  const toolList = tools.split("\n").map((s) => s.trim()).filter(Boolean)
  console.log(`  🔧 工具: ${toolList.join(", ")}`)

  const title = pgQuery(`SELECT title FROM session WHERE id = '${sessionID}'`)
  console.log(`  📝 Session title: ${title.trim()}`)

  // ── Step 8: 外键完整性 ──
  section("Step 8: 外键完整性")
  const orphans = parseInt(pgQuery(`
    SELECT COUNT(*) FROM part p
    LEFT JOIN message m ON m.id = p.message_id
    WHERE p.session_id = '${sessionID}' AND m.id IS NULL
  `), 10)
  assert(orphans === 0, `无孤儿 part (实际 ${orphans})`)

  const mismatch = parseInt(pgQuery(`
    SELECT COUNT(*) FROM part p
    JOIN message m ON m.id = p.message_id
    WHERE p.session_id = '${sessionID}' AND p.session_id != m.session_id
  `), 10)
  assert(mismatch === 0, `session_id 一致 (不匹配 ${mismatch})`)

  console.log()
  console.log("╔══════════════════════════════════════════════════════════════╗")
  console.log("║                       ✅ ALL PASSED                          ║")
  console.log("╚══════════════════════════════════════════════════════════════╝")
} finally {
  section("清理")
  if (server) {
    server.kill()
    await server.exited.catch(() => {})
    console.log("  ✅ Server 已停止")
  }
}
