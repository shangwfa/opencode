// V2 CCR 补充验收：L8 多实例（A 产 entry → B 复用同字节并取回原文）、L12 重启恢复（restart A 后同 hash 同字节）、
// L9 收益基准（压缩轮实际 input tokens vs entry.originalTokens）。
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"

const BASE_A = (process.env.BASE_A ?? "http://localhost:14106").replace(/\/$/, "")
const BASE_B = (process.env.BASE_B ?? "http://localhost:14107").replace(/\/$/, "")
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
const SENTINEL = `CCR_MULTI_SENTINEL_557_${nonce}`

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
const sha256 = (v) => createHash("sha256").update(v).digest("hex")

async function api(base, path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
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

async function prompt(base, sessionID, text) {
  const response = await fetch(`${base}/api/session/${sessionID}/prompt_stream`, {
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
  assert(events.some((e) => e.type === "session.execution.succeeded"), `execution failed`)
  return events
}

function seed(sessionID) {
  const items = []
  for (let i = 1; i <= 300; i++) items.push({ id: i, note: "p-" + i + "-" + "x".repeat(48), marker: i === 252 ? SENTINEL : null })
  const bigText = JSON.stringify({ total: 300, generated: "ccr-multi", items })
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
        state: { status: "completed", input: { query: `seed-${nonce}` }, content: [{ type: "text", text: bigText }], metadata: {} },
        time: { created: Date.now(), ran: Date.now(), completed: Date.now() },
      },
    ],
    finish: "tool-calls",
    rawFinish: "tool_use",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const seq = Number(pg(`SELECT coalesce(max(seq),0)+1 FROM session_message WHERE session_id=${quote(sessionID)}`))
  pg(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (${quote("msg_mseed" + nonce)}, ${quote(sessionID)}, 'assistant', ${seq}, ${Date.now()}, ${Date.now()}, ${quote(JSON.stringify(message))})`)
  return bigText
}

const removeSession = async (base, sid) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    await api(base, `/api/session/${sid}`, "DELETE").catch(() => undefined)
    if (pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(sid)}`) === "0") return
    await sleep(1000)
  }
}

const sessionID = (await api(BASE_A, "/api/session", "POST", { title: `ccr-multi-${nonce}`, location: { directory: "/workspace" }, model })).data.data.id

try {
  // ---------- 实例 A：seed + 推出窗口，产生 entry ----------
  seed(sessionID)
  for (let i = 0; i < 5; i++) await prompt(BASE_A, sessionID, "Reply with exactly: OK")
  await sleep(3000)
  const entriesA = pg(`SELECT count(*) FROM kv WHERE key LIKE 'plugin/ccr/${sessionID}/%'`)
  check(entriesA === "1", "L8 前置：实例 A 产生恰好一条 entry")
  const entryKey = pg(`SELECT key FROM kv WHERE key LIKE 'plugin/ccr/${sessionID}/%' LIMIT 1`)
  const hash = entryKey.split("/").pop()
  const valueA = pg(`SELECT value FROM kv WHERE key=${quote(entryKey)}`)
  const shaReplacement = (v) => sha256(JSON.parse(v).replacement ?? "")
  const entryMeta = JSON.parse(valueA)
  check(Number(entryMeta.originalTokens) > 1000, `L9 前置：entry.originalTokens=${entryMeta.originalTokens}`)

  // ---------- L9 收益基准：A 最后一轮（seed 已出窗被压缩）的实际 input tokens ----------
  const messagesA = (await api(BASE_A, `/api/session/${sessionID}/message?order=asc`)).data.data ?? []
  const lastTokens = messagesA.filter((m) => m.type === "assistant").at(-1)?.tokens
  check(
    lastTokens && Number(lastTokens.input) < Number(entryMeta.originalTokens) / 2,
    `L9 压缩轮实际 input=${lastTokens?.input} tok，远小于未压缩估算 ${entryMeta.originalTokens}`,
  )

  // ---------- L8 多实例：实例 B 复用 A 的 entry（同 hash 同字节）并取回原文 ----------
  await prompt(BASE_B, sessionID, "Reply with exactly: OK")
  await sleep(3000)
  const entriesB = pg(`SELECT count(*) FROM kv WHERE key LIKE 'plugin/ccr/${sessionID}/%'`)
  const valueB = pg(`SELECT value FROM kv WHERE key=${quote(entryKey)}`)
  check(entriesB === "1", "L8 实例 B 命中并复用同一 entry（不新建、不覆盖）")
  check(shaReplacement(valueB) === shaReplacement(valueA), "L8 复用后 replacement 字节完全一致（字节稳定）")

  const retrieveEvents = await prompt(
    BASE_B,
    sessionID,
    `Call the ccr_retrieve tool with hash=${hash} right now. Then tell me: does the marker "${SENTINEL}" appear in the retrieved content? Answer with the exact marker if found.`,
  )
  const msgsB = (await api(BASE_B, `/api/session/${sessionID}/message?order=asc`)).data.data ?? []
  const answerB = msgsB.filter((m) => m.type === "assistant").at(-1)
  const textB = (answerB?.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n")
  check(
    retrieveEvents.some((e) => e.type === "session.tool.input.started" && (e.data ?? e.properties ?? {}).name === "ccr_retrieve"),
    "L8 实例 B 调用 ccr_retrieve（读 A 持久化的原文）",
  )
  check(textB.includes(SENTINEL), "L8 实例 B 取回 A 存的完整原文（哨兵命中）")

  // ---------- L12 重启恢复：restart 实例 A，同 session 同 hash 同字节 ----------
  const restarted = spawnSync("docker", ["restart", process.env.RESTART_CONTAINER ?? "opencode-saas-ccr-a"], { encoding: "utf8" })
  assert.equal(restarted.status, 0, `docker restart failed: ${restarted.stderr}`)
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      ready = (await api(BASE_A, "/api/info")).status === 200
    } catch {}
    if (!ready) await sleep(2000)
  }
  check(ready, "L12 实例 A 重启后恢复就绪")
  await prompt(BASE_A, sessionID, "Reply with exactly: OK")
  await sleep(3000)
  const valueAfter = pg(`SELECT value FROM kv WHERE key=${quote(entryKey)}`)
  // retrievalCount 随取回递增属预期元数据变化；L12 断言的是 replacement 字节（请求视图稳定性）
  check(shaReplacement(valueAfter) === shaReplacement(valueA), "L12 重启后同 session+hash 注入完全相同的 replacement 字节")
  const countAfter = pg(`SELECT count(*) FROM kv WHERE key LIKE 'plugin/ccr/${sessionID}/%'`)
  check(countAfter === "1", "L12 重启后不重复建条目")
} finally {
  await removeSession(BASE_A, sessionID)
  check(pg(`SELECT count(*) FROM kv WHERE key LIKE 'plugin/ccr/${sessionID}/%'`) === "0", "清理：测试 session 的 ccr 条目零残留")
}
