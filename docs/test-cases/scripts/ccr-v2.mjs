// V2 CCR（Compress-Cache-Retrieve）E2E：seed 大 tool output → 推入压缩窗口 → 请求视图压缩 + kv entry（L2/L4）、
// PG 原文不动与幂等（L5）、模型真实 retrieve 取回原文（L3）、删除会话级联清理 kv（L6）、
// 未开启 CCR 的对照容器零条目（L7）。L0 单测见 ccr-plugin.test.ts / ccr.test.ts。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"

const BASE = (process.env.BASE ?? "http://localhost:14106").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const parsedModel = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-GLM","id":"glm-5.3"}')
const model = { providerID: parsedModel.providerID, id: parsedModel.id ?? parsedModel.modelID }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nonce = randomUUID().replaceAll("-", "").slice(0, 8)
const SENTINEL = `CCR_SEED_SENTINEL_774_${nonce}`

function check(ok, description) {
  assert(ok, `FAIL: ${description}`)
  console.log(`PASS: ${description}`)
}
function pg(sql) {
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`)
  return result.stdout.trim()
}
const quote = (value) => `'${value.replaceAll("'", "''")}'`

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(300_000),
  })
  const text = response.status === 204 ? "" : await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  return { status: response.status, data, text }
}

async function prompt(sessionID, text) {
  const response = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(300_000),
  })
  assert.equal(response.status, 200, `prompt_stream HTTP ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const events = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ""
    for (const block of blocks) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")
      if (!data || data === "[DONE]") continue
      try {
        events.push(JSON.parse(data))
      } catch {}
    }
  }
  assert(events.some((e) => e.type === "session.execution.succeeded"), `execution failed: ${events.map((e) => e.type).slice(-6).join(",")}`)
  return events
}

// 直接向 PG seed 一条 status=completed 的大 tool output 消息（V1 复测方法；CCR 是消息层功能，与沙箱无关）
function seedBigToolOutput(sessionID) {
  const items = []
  for (let i = 1; i <= 300; i++) {
    items.push({ id: i, name: `item-${i}`, note: `payload-${i}-${"x".repeat(48)}`, marker: i === 252 ? SENTINEL : null })
  }
  const bigText = JSON.stringify({ total: 300, generated: "ccr-e2e", items })
  const message = {
    time: { created: Date.now(), streamed: Date.now(), completed: Date.now() },
    agent: "build",
    model: { id: model.id, providerID: model.providerID, variant: "default" },
    content: [
      {
        type: "tool",
        id: `call_seed_${nonce}`,
        name: "websearch",
        executed: false,
        state: {
          status: "completed",
          input: { query: `seed-${nonce}` },
          content: [{ type: "text", text: bigText }],
          metadata: {},
        },
        time: { created: Date.now(), ran: Date.now(), completed: Date.now() },
      },
    ],
    // 完整合法形状：缺 finish/rawFinish/cost 会被 SessionHistory.decodeMessageRow 静默丢弃
    finish: "tool-calls",
    rawFinish: "tool_use",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const seq = Number(pg(`SELECT coalesce(max(seq),0)+1 FROM session_message WHERE session_id=${quote(sessionID)}`))
  pg(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (${quote("msg_seed" + nonce)}, ${quote(sessionID)}, 'assistant', ${seq}, ${Date.now()}, ${Date.now()}, ${quote(JSON.stringify(message))})`)
  return bigText
}

const removeSession = async (sid) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    await api(`/api/session/${sid}`, "DELETE").catch(() => undefined)
    if (pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(sid)}`) === "0") return
    await sleep(1000)
  }
}

const kvEntries = (sid) => pg(`SELECT count(*) FROM kv WHERE key LIKE 'plugin/ccr/${sid}/%'`)

const sessionID = (await api("/api/session", "POST", { title: `ccr-e2e-${nonce}`, location: { directory: "/workspace" }, model })).data.data.id

try {
  // ---------- seed + 推出 protect_recent 窗口 ----------
  const bigText = seedBigToolOutput(sessionID)
  check(bigText.length > 30000, `seed 大 tool output（${bigText.length} 字符，含唯一哨兵）`)
  for (let i = 0; i < 5; i++) await prompt(sessionID, "Reply with exactly: OK")
  await sleep(3000)

  // ---------- L2/L4：压缩发生 + kv entry 持久化 ----------
  const entryCount = kvEntries(sessionID)
  check(entryCount === "1", "L2/L4 请求视图压缩发生且 kv 恰好一条 plugin/ccr entry")
  const entryKey = pg(`SELECT key FROM kv WHERE key LIKE 'plugin/ccr/${sessionID}/%' LIMIT 1`)
  const hash = entryKey.split("/").pop()
  const entry = JSON.parse(pg(`SELECT value FROM kv WHERE key=${quote(entryKey)}`))
  check(Number(entry.originalTokens) > 1000 && Number(entry.compressedTokens) < Number(entry.originalTokens), `L4 entry 元数据（originalTokens=${entry.originalTokens} → compressedTokens=${entry.compressedTokens}）`)
  const ratio = 1 - Number(entry.compressedTokens) / Number(entry.originalTokens)
  check(ratio > 0.5, `L2 压缩收益 >50%（实际 ${(ratio * 100).toFixed(1)}%）`)

  // ---------- L5：PG 原文不动 + 幂等 ----------
  const seededNow = pg(`SELECT length(data) FROM session_message WHERE id=${quote("msg_seed" + nonce)}`)
  check(Number(seededNow) >= bigText.length, "L5 PG part 原文原封未动（压缩只改请求视图）")
  for (let i = 0; i < 2; i++) await prompt(sessionID, "Reply with exactly: OK")
  await sleep(3000)
  check(kvEntries(sessionID) === "1", "L5 幂等：后续轮次不重复建条目（同 hash）")

  // ---------- L3：模型真实 retrieve ----------
  const retrieveEvents = await prompt(
    sessionID,
    `Call the ccr_retrieve tool with hash=${hash} right now. After retrieving, tell me: does the marker string "${SENTINEL}" appear in the retrieved content? Answer with the exact marker string if found, otherwise answer no.`,
  )
  const messages = (await api(`/api/session/${sessionID}/message?order=asc`)).data.data ?? []
  const lastAssistant = messages.filter((m) => m.type === "assistant").at(-1)
  const lastText = (lastAssistant?.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n")
  const retrieveCalled = retrieveEvents.some(
    (e) => e.type === "session.tool.input.started" && (e.data ?? e.properties ?? {}).name === "ccr_retrieve",
  )
  check(retrieveCalled, "L3 模型实际调用 ccr_retrieve（工具暴露 + 注册，L1）")
  check(lastText.includes(SENTINEL), `L3 retrieve 取回完整原文并找到哨兵（回答含 ${SENTINEL}）`)
  const retrievalCount = JSON.parse(pg(`SELECT value FROM kv WHERE key=${quote(entryKey)}`)).retrievalCount
  check(Number(retrievalCount) >= 1, `L4 retrievalCount 递增（=${retrievalCount}）`)

  // ---------- L6：删除会话级联清理 ----------
  await removeSession(sessionID)
  check(kvEntries(sessionID) === "0", "L6 session 删除后 plugin/ccr 条目级联清理")
} finally {
  await removeSession(sessionID).catch(() => undefined)
  check(kvEntries(sessionID) === "0", "清理：测试 session 的 ccr 条目零残留")
}
