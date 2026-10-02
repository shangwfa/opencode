// V2 session derivation: POST /api/session { summaryFrom } generates a fresh summary of the
// source Session and installs it in the new one. Mirrors docs/test-cases/session/session-summary-from.md,
// rewritten for the V2 API (prompt_stream / wait, session_message, session.execution.* events).
//
// The load-bearing contract is source isolation: deriving must leave the source Session untouched.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://localhost:14107").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const rawModel = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}')
const MODEL = { providerID: rawModel.providerID, id: rawModel.id ?? rawModel.modelID }

let failures = 0
const created = []
const say = (line) => process.stdout.write(`${line}\n`)
function check(id, ok, detail = "") {
  say(`${ok ? "✅" : "❌"} ${id}${detail ? `: ${detail}` : ""}`)
  if (!ok) failures++
}
const q = (value) => `'${String(value).replaceAll("'", "''")}'`

function pg(sql) {
  if (!PG_URL) throw new Error("PG_URL is required")
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`)
  return result.stdout.trim()
}

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const text = response.status === 204 ? "" : await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  return { status: response.status, ok: response.ok, data, text }
}

const newSession = async (body) => {
  const result = await api("/api/session", "POST", { location: { directory: "/workspace" }, model: MODEL, ...body })
  if (!result.ok) throw new Error(`create failed: ${result.text}`)
  const id = result.data?.data?.id
  created.push(id)
  return id
}

const messages = async (sid) => (await api(`/api/session/${sid}/message?order=asc&limit=200`)).data?.data ?? []
const assistantText = (message) =>
  (message?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")

const prompt = async (sid, text) => {
  const response = await fetch(`${BASE}/api/session/${sid}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok) throw new Error(`prompt_stream HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ""
    for (const block of blocks) {
      const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim()
      if (data && data !== "[DONE]") {
        try {
          events.push(JSON.parse(data))
        } catch {}
      }
    }
  }
  return events
}

/** The derived assistant message arrives asynchronously, so poll until its final text is projected. */
async function waitDerived(sid, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await messages(sid)
    const assistant = rows.findLast(
      (message) => message.type === "assistant" && message.time?.completed && (message.content ?? []).some((part) => part.type === "text"),
    )
    if (assistant) return assistant
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return undefined
}

async function waitCompaction(sid, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await messages(sid)
    const completed = rows.findLast(
      (message) => message.type === "compaction" && message.status === "completed" && message.summary,
    )
    if (completed) return completed
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
}

async function subscribeEvents() {
  const controller = new AbortController()
  const response = await fetch(`${BASE}/api/event`, {
    headers,
    signal: controller.signal,
  })
  if (!response.ok) throw new Error(`event.subscribe HTTP ${response.status}`)
  const events = []
  const reader = response.body.getReader()
  const task = (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split(/\r?\n\r?\n/)
        buffer = blocks.pop() ?? ""
        for (const block of blocks) {
          const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim()
          if (data) {
            try {
              events.push(JSON.parse(data))
            } catch {}
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
    }
  })()
  return {
    events,
    async close() {
      controller.abort()
      await task.catch(() => {})
    },
  }
}

say(`session-summary-from V2 probe: ${BASE}`)
say(`model: ${MODEL.providerID}/${MODEL.id}`)

// ────────────────────────────────────────────── T43.1.1 / T43.1.2 basic derivation
const source = await newSession({ title: "summary-source" })
await prompt(source, "记住：项目代号是凤凰，上线日期定在下周一")
const sourceBefore = await messages(source)
const sourceUpdatedBefore = pg(`select time_updated from session_v2 where id=${q(source)}`)
// Snapshot the source's own event count AFTER seeding it, so the derivation is the only thing
// that could add to it. (Counting from zero would just re-measure the seeding prompt's events.)
const sourceEventsBefore = pg(`select count(*) from event where aggregate_id=${q(source)}`)

const eventStream = await subscribeEvents()
const derived = await newSession({ summaryFrom: source, title: "derived" })
const checkpoint = await waitDerived(derived)
await eventStream.close()
{
  // T43.1.1: the request returns immediately; the summary lands shortly after.
  const summary = assistantText(checkpoint)
  check("T43.1.1", checkpoint !== undefined, `assistant=${JSON.stringify(summary.slice(0, 120) || null)}`)
  const mentioned = /凤凰|上线|下周一|phoenix/i.test(summary)
  check("T43.1.1 摘要覆盖源会话要点", mentioned, `phoenix/launch mentioned=${mentioned}`)
  const derivedDeltas = eventStream.events.filter((event) => {
    const properties = event.properties ?? event.data ?? {}
    return event.type === "session.text.delta" && properties.sessionID === derived && properties.assistantMessageID === checkpoint?.id
  })
  check("T43.1.1 实时 Text.Delta", derivedDeltas.length > 0, `delta events=${derivedDeltas.length}`)
  const streamedText = derivedDeltas.map((event) => (event.properties ?? event.data ?? {}).delta ?? "").join("")
  check("T43.1.1 流式与落库文本一致", streamedText === summary, `stream=${streamedText.length} chars persisted=${summary.length} chars`)

  // The summary is visible as a regular assistant message, not as a compaction record.
  const targetKinds = (await messages(derived)).map((message) => `${message.type}:${message.status ?? ""}`)
  check("T43.1.2 普通 assistant 消息", targetKinds.some((kind) => kind.startsWith("assistant:")), `target=${JSON.stringify(targetKinds)}`)
  check("T43.1.2 不落 compaction", !targetKinds.some((kind) => kind.startsWith("compaction:")), `target=${JSON.stringify(targetKinds)}`)
  const stored = pg(
    `select count(*) from session_message where session_id=${q(derived)} and type='assistant' and data::text like '%Objective%'`,
  )
  check("T43.1.2 PG assistant 落库", stored === "1", `assistant summary rows=${stored}`)
}

// ────────────────────────────────────────────── T43.5.1 derivation after an earlier checkpoint
{
  const historySource = await newSession({ title: "summary-history-source" })
  await prompt(historySource, "请记住旧事实：档案柜密码是芝麻开门。")
  await api(`/api/session/${historySource}/compact`, "POST", { delivery: "queue" })
  const oldCheckpoint = await waitCompaction(historySource)
  check("T43.5.1 源会话先生成 compaction", oldCheckpoint !== undefined, `checkpoint=${oldCheckpoint?.id ?? "missing"}`)

  await prompt(historySource, "请记住新事实：发布窗口是周五下午。")
  const historyDerived = await newSession({ summaryFrom: historySource, title: "summary-history-derived" })
  const derivedAssistant = await waitDerived(historyDerived)
  const derivedText = assistantText(derivedAssistant)
  check(
    "T43.5.1 旧摘要与新消息均被派生",
    derivedAssistant !== undefined && /芝麻开门/.test(derivedText) && /周五下午|发布窗口/.test(derivedText),
    `summary=${JSON.stringify(derivedText.slice(0, 220))}`,
  )
  const derivedRows = await messages(historyDerived)
  check(
    "T43.5.1 目标仍只有普通 assistant 摘要",
    derivedRows.filter((message) => message.type === "assistant").length === 1 &&
      !derivedRows.some((message) => message.type === "compaction"),
    `types=${JSON.stringify(derivedRows.map((message) => message.type))}`,
  )
}

// ────────────────────────────────────────────── T43.3.1 source isolation (the contract)
{
  const sourceAfter = await messages(source)
  const sourceUpdatedAfter = pg(`select time_updated from session_v2 where id=${q(source)}`)
  check(
    "T43.3.1 源会话零写入",
    JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore),
    `before=${sourceBefore.length} after=${sourceAfter.length}`,
  )
  const sourceEventsAfter = pg(`select count(*) from event where aggregate_id=${q(source)}`)
  check(
    "T43.3.1 源会话无新事件",
    sourceEventsAfter === sourceEventsBefore,
    `${sourceEventsBefore} -> ${sourceEventsAfter}`,
  )
  check(
    "T43.3.1 源会话 time_updated 未变",
    sourceUpdatedAfter === sourceUpdatedBefore,
    `${sourceUpdatedBefore} -> ${sourceUpdatedAfter}`,
  )
}

// ────────────────────────────────────────────── T43.4.1 the summary is live context
{
  const answer = await prompt(derived, "这个会话之前提到的项目代号是什么？只回答代号")
  const text = (await messages(derived))
    .filter((message) => message.type === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  check("T43.4.1 端到端生效", /凤凰|phoenix/i.test(text), `reply=${JSON.stringify(text.slice(-120))} terminal=${JSON.stringify(answer.filter((e) => String(e.type).startsWith("session.execution.")).map((e) => e.type))}`)
}

// ────────────────────────────────────────────── T43.6 fallbacks
{
  const empty = await newSession({ title: "summary-empty-source" })
  const fallback = await api("/api/session", "POST", {
    location: { directory: "/workspace" },
    model: MODEL,
    summaryFrom: empty,
  })
  created.push(fallback.data?.data?.id)
  check("T43.6.1 空源不阻断创建", fallback.status === 200 && fallback.data?.data?.id !== undefined, `HTTP ${fallback.status}`)

  const missing = await api("/api/session", "POST", {
    location: { directory: "/workspace" },
    model: MODEL,
    summaryFrom: "ses_nonexistent0000000000000000",
  })
  created.push(missing.data?.data?.id)
  check("T43.6.2 不存在源不阻断创建", missing.status === 200 && missing.data?.data?.id !== undefined, `HTTP ${missing.status}`)

  const invalid = await api("/api/session", "POST", { location: { directory: "/workspace" }, summaryFrom: "invalid-id" })
  check("T43.6.3 非法格式 400", invalid.status === 400, `HTTP ${invalid.status}`)
}

// ────────────────────────────────────────────── T43.9.1 concurrent derivation
{
  const [a, b] = await Promise.all([
    newSession({ summaryFrom: source }),
    newSession({ summaryFrom: source }),
  ])
  const [ca, cb] = await Promise.all([waitDerived(a), waitDerived(b)])
  check(
    "T43.9.1 并发派生",
    a !== b && ca !== undefined && cb !== undefined,
    `ids=${a !== b} summaries=${ca !== undefined}/${cb !== undefined}`,
  )
}

say("")
say(`Summary: ${failures} failed assertion(s)`)

for (const id of created) {
  if (id) await api(`/api/session/${id}`, "DELETE").catch(() => {})
}
const remaining = created.filter(Boolean).length
  ? pg(`select count(*) from session_v2 where id in (${created.filter(Boolean).map(q).join(",")})`)
  : "0"
say(`cleanup: ${remaining} test Session row(s) remaining`)

if (failures > 0) process.exitCode = 1
