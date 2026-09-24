// Probe the legacy session appId test cases against the current V2 API.
// SSE events are printed as they arrive; run the companion PG queries separately.
import assert from "node:assert/strict"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14105").replace(/\/$/, "")
const PASSWORD = process.env.OPENCODE_PASSWORD
const headers = {
  "content-type": "application/json",
  ...(PASSWORD ? { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` } : {}),
}
const MODEL = { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }
const runTag = Date.now().toString(36)
let failures = 0

async function request(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  return { status: response.status, ok: response.ok, data }
}

function report(id, status, detail) {
  console.log(`${status ? "✅" : "❌"} ${id}: ${detail}`)
  if (!status) failures++
}

async function streamPrompt(sessionID, text, label = "T41.4.1") {
  console.log(`\n--- ${label} prompt_stream ---`)
  const response = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`prompt_stream HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
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
      if (!data) continue
      const event = JSON.parse(data)
      events.push(event)
      const type = event.type ?? "event"
      const properties = event.properties ?? event.data ?? {}
      console.log(`[SSE] ${type}${type === "session.text.delta" ? ` ${properties.delta ?? ""}` : ""}`)
    }
  }
  assert(events.some((event) => event.type === "session.execution.succeeded"), "消息执行未成功")
}

console.log(`V2 appId probe: ${BASE}`)

const created = await request("/api/session", "POST", {
  title: "appid-v2-probe",
  location: { directory: "/workspace" },
  model: MODEL,
  appId: "biz-proj-001",
})
console.log("create with appId:", created.status, JSON.stringify(created.data ?? created).slice(0, 500))
assert(created.ok, "T41.1.1 创建会话失败")
if (created.ok) {
  const sessionID = created.data.data.id
  const detail = await request(`/api/session/${sessionID}`)
  const appId = detail.data?.data?.appId ?? detail.data?.appId ?? null
  report("T41.1.1", appId === "biz-proj-001", `session=${sessionID}; detail.appId=${JSON.stringify(appId)}`)

  await streamPrompt(sessionID, "请只回复数字 2，不要调用工具。")
  const messages = await request(`/api/session/${sessionID}/message?order=asc`)
  const rows = messages.data?.data ?? messages.data ?? []
  const assistantText = rows
    .filter((message) => message.type === "assistant")
    .flatMap((message) => (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text))
    .join("\n")
  report("T41.4.1", assistantText.trim() === "2", `消息已流式完成；助手终态=${JSON.stringify(assistantText.slice(-160))}`)
}

const withoutApp = await request("/api/session", "POST", {
  title: "appid-v2-null-probe",
  location: { directory: "/workspace" },
})
if (withoutApp.ok) {
  const detail = await request(`/api/session/${withoutApp.data.data.id}`)
  const appId = detail.data?.data?.appId ?? detail.data?.appId ?? null
  report("T41.1.2", appId === null, `detail.appId=${JSON.stringify(appId)}`)
}

const invalid = await request("/api/session", "POST", {
  title: "appid-v2-invalid-probe",
  location: { directory: "/workspace" },
  appId: "bad id!",
})
report("T41.1.3", invalid.status === 400, `HTTP ${invalid.status}; ${JSON.stringify(invalid.data).slice(0, 220)}`)

const listFixtures = await Promise.all([
  request("/api/session", "POST", {
    title: `appid-list-match-${runTag}`,
    location: { directory: "/workspace" },
    appId: "biz-proj-001",
  }),
  request("/api/session", "POST", {
    title: `appid-list-other-${runTag}`,
    location: { directory: "/workspace" },
    appId: "biz-proj-002",
  }),
  request("/api/session", "POST", {
    title: `appid-list-none-${runTag}`,
    location: { directory: "/workspace" },
  }),
])
assert(listFixtures.every((result) => result.ok), "T41.2.1 准备会话失败")

const filtered = await request("/api/session?appId=biz-proj-001")
const sessions = filtered.data?.data ?? filtered.data
const isList = Array.isArray(sessions)
const appIds = isList ? sessions.map((session) => session.appId ?? null) : []
report(
  "T41.2.1/2.2",
  isList && sessions.some((session) => session.id === listFixtures[0].data.data.id) &&
    !sessions.some((session) => [listFixtures[1].data.data.id, listFixtures[2].data.data.id].includes(session.id)) &&
    appIds.every((appId) => appId === "biz-proj-001"),
  `HTTP ${filtered.status}; ${isList ? `rows=${sessions.length}; appIds=${JSON.stringify([...new Set(appIds)])}` : JSON.stringify(filtered.data).slice(0, 220)}`,
)

const missing = await request("/api/session?appId=no-such-app")
const missingSessions = missing.data?.data ?? missing.data
report(
  "T41.2.2",
  Array.isArray(missingSessions) && missingSessions.length === 0,
  `HTTP ${missing.status}; ${Array.isArray(missingSessions) ? `rows=${missingSessions.length}` : JSON.stringify(missing.data).slice(0, 220)}`,
)

const combo = await request("/api/session?appId=biz-proj-001&limit=10&search=probe")
const comboSessions = combo.data?.data ?? combo.data
report(
  "T41.2.3",
  combo.ok && Array.isArray(comboSessions) && comboSessions.length <= 10 && comboSessions.every((session) => session.appId === "biz-proj-001"),
  `HTTP ${combo.status}; ${Array.isArray(comboSessions) ? `rows=${comboSessions.length}; appIds=${JSON.stringify([...new Set(comboSessions.map((session) => session.appId ?? null))])}` : JSON.stringify(combo.data).slice(0, 220)}`,
)

const cursorFixtures = await Promise.all(["first", "second"].map((part) =>
  request("/api/session", "POST", {
    title: `appid-cursor-${runTag}-${part}`,
    location: { directory: "/workspace" },
    appId: "cursor-app",
  }),
))
assert(cursorFixtures.every((result) => result.ok), "T41.2.3 cursor 准备会话失败")
const cursorFirst = await request(`/api/session?appId=cursor-app&search=appid-cursor-${runTag}&limit=1`)
const cursorFirstRows = cursorFirst.data?.data ?? cursorFirst.data
const nextCursor = cursorFirst.data?.cursor?.next
const cursorSecond = nextCursor
  ? await request(`/api/session?limit=1&cursor=${encodeURIComponent(nextCursor)}`)
  : { ok: false, data: undefined }
const cursorSecondRows = cursorSecond.data?.data ?? cursorSecond.data
report(
  "T41.2.3 cursor 保持 appId",
  cursorFirst.ok && Array.isArray(cursorFirstRows) && cursorFirstRows.length === 1 &&
    cursorFirstRows[0]?.appId === "cursor-app" && cursorSecond.ok && Array.isArray(cursorSecondRows) &&
    cursorSecondRows.length === 1 && cursorSecondRows[0]?.appId === "cursor-app" &&
    cursorFirstRows[0]?.id !== cursorSecondRows[0]?.id,
  `first=${JSON.stringify(cursorFirstRows)}; second=${JSON.stringify(cursorSecondRows)}`,
)

console.log("\n--- T41.3.1 最近活动排序 ---")
const sortOld = await request("/api/session", "POST", {
  title: "appid-sort-older",
  location: { directory: "/workspace" },
  model: MODEL,
  appId: "sort-app",
})
const sortNew = await request("/api/session", "POST", {
  title: "appid-sort-newer",
  location: { directory: "/workspace" },
  model: MODEL,
  appId: "sort-app",
})
assert(sortOld.ok && sortNew.ok, "T41.3.1 会话创建失败")
const sortOldID = sortOld.data.data.id
const sortNewID = sortNew.data.data.id
const initialSort = await request("/api/session?appId=sort-app&search=appid-sort")
const initialRows = initialSort.data?.data ?? initialSort.data
report(
  "T41.3.1 创建顺序",
  Array.isArray(initialRows) && initialRows[0]?.id === sortNewID && initialRows[1]?.id === sortOldID,
  `ids=${Array.isArray(initialRows) ? JSON.stringify(initialRows.map((session) => session.id)) : JSON.stringify(initialSort.data).slice(0, 180)}`,
)
const oldBefore = await request(`/api/session/${sortOldID}`)
await streamPrompt(sortOldID, "请只回复数字 2，不要调用工具。", "T41.3.1 最近活动消息")
const afterSort = await request("/api/session?appId=sort-app&search=appid-sort")
const afterRows = afterSort.data?.data ?? afterSort.data
const oldAfter = await request(`/api/session/${sortOldID}`)
report(
  "T41.3.1 发消息后置顶",
  Array.isArray(afterRows) && afterRows[0]?.id === sortOldID &&
    oldAfter.data?.data?.time?.updated > oldBefore.data?.data?.time?.updated,
  `ids=${Array.isArray(afterRows) ? JSON.stringify(afterRows.map((session) => session.id)) : JSON.stringify(afterSort.data).slice(0, 180)}; updated=${oldBefore.data?.data?.time?.updated}->${oldAfter.data?.data?.time?.updated}`,
)

console.log("\nV2 probe finished. Check session_v2 PG rows for app_id separately.")
console.log(`Summary: ${failures} failed assertion(s)`)
if (failures > 0) process.exitCode = 1
