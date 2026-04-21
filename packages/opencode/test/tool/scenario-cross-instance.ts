/**
 * 复杂跨实例场景测试：
 *   - 实例A (19876) 执行 agent
 *   - 实例B (19877) SSE 监听
 *   - 验证 PG LISTEN/NOTIFY 跨实例事件分发
 *
 * 场景覆盖：
 *   1. 多 session 并发执行，SSE 分别连不同实例
 *   2. 单 SSE 连接监听无过滤，验证收到所有 session 事件
 *   3. SSE 按 sessionID 过滤，验证只收到目标 session 事件
 *   4. agent 完成后 PG 数据完整性
 *   5. SSE 断连后重连，验证数据不丢（从 PG 拉历史）
 *   6. 同一 session 连续两次 prompt_async
 */
import { execSync } from "child_process"

const PORT_A = 19876
const PORT_B = 19877
const A = `http://127.0.0.1:${PORT_A}`
const B = `http://127.0.0.1:${PORT_B}`

function section(title: string) {
  console.log(`\n${"═".repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${"═".repeat(60)}`)
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  ❌ ${msg}`)
    process.exit(1)
  }
  console.log(`  ✅ ${msg}`)
}

const pgQuery = (sql: string) =>
  execSync(`docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -c "${sql}"`, { encoding: "utf-8" }).trim()

async function waitForSSEEvent(sessionID: string, port: number, eventType: string, timeoutMs: number = 120_000) {
  return new Promise<{ events: any[]; elapsed: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SSE timeout waiting for ${eventType} on port ${port}`)), timeoutMs)
    const events: any[] = []
    const start = Date.now()

    fetch(`${port === PORT_A ? A : B}/event?sessionID=${sessionID}`).then((res) => {
      if (!res.ok || !res.body) { clearTimeout(timer); reject(new Error(`SSE ${res.status}`)); return }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) { clearTimeout(timer); reject(new Error("SSE closed")); return }
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            try {
              const event = JSON.parse(line.slice(6))
              events.push(event)
              if (event.type === eventType) {
                clearTimeout(timer)
                resolve({ events, elapsed: Date.now() - start })
                reader.cancel()
                return
              }
            } catch {}
          }
        }
      }
      pump()
    }).catch((e) => { clearTimeout(timer); reject(e) })
  })
}

async function createSession(base: string) {
  const r = await fetch(`${base}/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  const data = await r.json() as any
  return data.id as string
}

async function sendAsync(base: string, sessionID: string, text: string) {
  const r = await fetch(`${base}/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
  })
  return r.status
}

console.log("╔══════════════════════════════════════════════════════════════╗")
console.log("║   跨实例复杂场景测试: PG LISTEN/NOTIFY Event Bus            ║")
console.log("╚══════════════════════════════════════════════════════════════╝")

try {
  // ── 场景 1: 基础跨实例（A执行，B监听）──
  section("场景 1: 基础跨实例 — A 执行，B 监听 SSE")
  const s1 = await createSession(A)
  console.log(`  Session: ${s1} (created on A)`)

  const s1Result = await Promise.all([
    waitForSSEEvent(s1, PORT_B, "session.idle"),
    sendAsync(A, s1, "Create file1.txt with content 'hello-from-A', then cat file1.txt"),
  ]).then(([sse]) => sse)

  assert(s1Result.elapsed > 0, `agent 完成，耗时 ${s1Result.elapsed}ms`)
  assert(s1Result.events.some((e) => e.type === "session.idle"), "B 收到 session.idle")
  assert(s1Result.events.some((e) => e.type === "message.part.updated"), "B 收到工具事件")
  assert(s1Result.events.some((e) => e.type === "message.part.delta"), "B 收到流式输出")

  // ── 场景 2: 反向跨实例（B执行，A监听）──
  section("场景 2: 反向跨实例 — B 执行，A 监听 SSE")
  const s2 = await createSession(B)
  console.log(`  Session: ${s2} (created on B)`)

  const s2Result = await Promise.all([
    waitForSSEEvent(s2, PORT_A, "session.idle"),
    sendAsync(B, s2, "Create file2.txt with content 'hello-from-B', then cat file2.txt"),
  ]).then(([sse]) => sse)

  assert(s2Result.events.some((e) => e.type === "session.idle"), "A 收到 B 的 session.idle")

  // ── 场景 3: 两个 session 并发，同一 SSE 连接（无过滤）──
  section("场景 3: 并发 session，无过滤 SSE")
  const s3a = await createSession(A)
  const s3b = await createSession(A)
  console.log(`  Sessions: ${s3a}, ${s3b}`)

  // 无过滤 SSE 连到 B，应该收到两个 session 的事件
  const s3AllEvents: any[] = []
  const s3SSE = new Promise<{ events: any[] }>((resolve) => {
    const timer = setTimeout(() => resolve({ events: s3AllEvents }), 90_000)
    fetch(`${B}/event`).then((res) => {
      if (!res.ok || !res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) { clearTimeout(timer); resolve({ events: s3AllEvents }); return }
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            try { s3AllEvents.push(JSON.parse(line.slice(6))) } catch {}
          }
          // 两个 session 都 idle 了就结束
          const idles = s3AllEvents.filter((e) => e.type === "session.idle")
          if (idles.length >= 2) { clearTimeout(timer); resolve({ events: s3AllEvents }); reader.cancel(); return }
        }
      }
      pump()
    })
  })

  await Promise.all([
    sendAsync(A, s3a, "Create file3a.txt with content 'concurrent-A'"),
    sendAsync(A, s3b, "Create file3b.txt with content 'concurrent-B'"),
  ])
  console.log("  两个 prompt_async 已发送")

  const s3Result = await s3SSE
  const s3Idles = s3Result.events.filter((e) => e.type === "session.idle")
  const s3Sessions = s3Idles.map((e) => e.properties?.sessionID)
  assert(s3Idles.length >= 2, `收到 ${s3Idles.length} 个 session.idle（期望 ≥2）`)
  assert(s3Sessions.includes(s3a) && s3Sessions.includes(s3b), "两个 session 的 idle 都收到")

  // ── 场景 4: SSE 按 sessionID 过滤，隔离验证──
  section("场景 4: SSE 按 sessionID 过滤")
  const s4target = await createSession(A)
  const s4noise = await createSession(A)
  console.log(`  Target: ${s4target}, Noise: ${s4noise}`)

  // SSE 只监听 target，noise 的事件不应出现
  const s4Result = await Promise.all([
    waitForSSEEvent(s4target, PORT_B, "session.idle"),
    (async () => {
      await new Promise((r) => setTimeout(r, 500))
      await sendAsync(A, s4noise, "Create noise.txt with content 'noise'")
      await sendAsync(A, s4target, "Create target.txt with content 'target'")
    })(),
  ]).then(([sse]) => sse)

  const noiseEvents = s4Result.events.filter((e) => e.properties?.sessionID === s4noise)
  assert(noiseEvents.length === 0, `过滤生效：noise session 事件数为 ${noiseEvents.length}（期望 0）`)
  assert(s4Result.events.some((e) => e.type === "session.idle" && e.properties?.sessionID === s4target), "只收到 target 的 idle")

  // ── 场景 5: SSE 断连后重连，数据不丢 ──
  section("场景 5: SSE 断连重连，数据不丢")
  const s5 = await createSession(A)

  // 先发异步消息
  await sendAsync(A, s5, "Create reconnect.txt with content 'still-here'")
  // 等 agent 完成
  await waitForSSEEvent(s5, PORT_B, "session.idle")
  console.log("  agent 已完成")

  // 然后从 B 用 REST API 拉消息（模拟重连后拉历史）
  const s5Messages = await fetch(`${B}/session/${s5}/message`).then((r) => r.json() as Promise<any[]>)
  assert(s5Messages.length >= 2, `REST API 拉到 ${s5Messages.length} 条 message（期望 ≥2）`)

  const s5Parts = s5Messages.flatMap((m: any) => m.parts ?? [])
  assert(s5Parts.length >= 1, `parts 总数 ${s5Parts.length}（期望 ≥1）`)
  console.log(`  ✅ 断连重连后从 PG 拉到完整数据: ${s5Messages.length} messages, ${s5Parts.length} parts`)

  // ── 场景 6: 同一 session 连续两次 prompt ──
  section("场景 6: 同一 session 连续两次 prompt")
  const s6 = await createSession(A)

  // 第一次
  const r1 = await Promise.all([
    waitForSSEEvent(s6, PORT_B, "session.idle"),
    sendAsync(A, s6, "Create first.txt with content 'first'"),
  ]).then(([sse]) => sse)
  assert(r1.events.some((e) => e.type === "session.idle"), "第一次 prompt 完成")

  // 第二次
  const r2 = await Promise.all([
    waitForSSEEvent(s6, PORT_B, "session.idle"),
    sendAsync(A, s6, "Create second.txt with content 'second'"),
  ]).then(([sse]) => sse)
  assert(r2.events.some((e) => e.type === "session.idle"), "第二次 prompt 完成")
  console.log(`  ✅ 同一 session 两次 prompt 各收到 idle`)

  // ── 最终 PG 验证 ──
  section("最终 PG 数据验证")
  const sessions = parseInt(pgQuery("SELECT COUNT(*) FROM session"))
  const messages = parseInt(pgQuery("SELECT COUNT(*) FROM message"))
  const parts = parseInt(pgQuery("SELECT COUNT(*) FROM part"))
  console.log(`  📊 PG: sessions=${sessions}, messages=${messages}, parts=${parts}`)

  const orphans = parseInt(pgQuery(`
    SELECT COUNT(*) FROM part p LEFT JOIN message m ON m.id = p.message_id WHERE m.id IS NULL
  `))
  assert(orphans === 0, `无孤儿 part (${orphans})`)

  console.log()
  console.log("╔══════════════════════════════════════════════════════════════╗")
  console.log("║                   ✅ ALL 6 SCENARIOS PASSED                  ║")
  console.log("╚══════════════════════════════════════════════════════════════╝")
} catch (e) {
  console.error("\n❌ TEST FAILED:", e instanceof Error ? e.message : String(e))
  process.exit(1)
}
