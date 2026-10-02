import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14104").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const password = process.env.OPENCODE_PASSWORD
const headers = {
  "content-type": "application/json",
  ...(password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}),
}
const model = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}')
let sid
let failures = 0

function check(name, ok, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `: ${detail}` : ""}`)
  if (!ok) failures++
}

async function api(path, method = "GET", body, timeout = 120_000) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  return { response, data, text }
}

function pg(sql) {
  assert(PG_URL, "PG_URL required")
  const result = spawnSync("psql", [PG_URL, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

console.log(`Watchdog V2 E2E: ${BASE}; expected timeout 1s, scan interval 1s`)
try {
  const created = await api("/api/session", "POST", {
    title: `watchdog-v2-${Date.now()}`,
    location: { directory: "/workspace" },
    model,
  })
  assert(created.response.ok, `create HTTP ${created.response.status}: ${created.text}`)
  sid = created.data?.data?.id
  assert(sid, `create returned no ID: ${created.text}`)

  const response = await fetch(`${BASE}/api/session/${sid}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: "请只调用 bash 工具执行 sleep 30，等待命令结束，不要使用其他工具或回答说明。",
      metadata: {},
      delivery: "queue",
    }),
    signal: AbortSignal.timeout(90_000),
  })
  const streamText = await response.text()
  assert(response.ok, `prompt_stream HTTP ${response.status}: ${streamText.slice(0, 400)}`)
  const events = [...streamText.matchAll(/^data:\s*(.+)$/gm)].flatMap((match) => {
    try {
      return [JSON.parse(match[1])]
    } catch {
      return []
    }
  })
  const toolEvents = events.filter((event) => event.type.startsWith("session.tool."))
  const interrupted = events.find(
    (event) => event.type === "session.execution.interrupted" && event.data?.reason === "watchdog",
  )
  check(
    "T-WDT.V2.1 active long-running tool is interrupted by watchdog",
    Boolean(interrupted),
    `tools=${toolEvents.map((event) => event.type).join(",")}; terminal=${events.at(-1)?.type}`,
  )

  const readback = await api(`/api/session/${sid}/message?order=asc&limit=100`)
  const messages = readback.data?.data ?? []
  const toolParts = messages
    .filter((message) => message.type === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === "tool")
  const settled = toolParts.length > 0 && toolParts.every((part) => part.state.status !== "running")
  check(
    "T-WDT.V2.2 interrupted tool is durably settled",
    settled,
    JSON.stringify(toolParts.map((part) => ({ name: part.name, status: part.state.status }))),
  )

  const stored = pg(
    `select count(*) from event where aggregate_id='${sid.replaceAll("'", "''")}' and type like 'session.execution.interrupted%' and data::jsonb->>'reason'='watchdog'`,
  )
  check("T-WDT.V2.3 PG records watchdog interruption", stored === "1", `rows=${stored}`)
} catch (error) {
  console.error(`Watchdog E2E error: ${error instanceof Error ? error.stack : String(error)}`)
  failures++
} finally {
  if (sid) {
    try {
      const result = await api(`/api/session/${sid}`, "DELETE")
      assert([200, 204].includes(result.response.status), `cleanup HTTP ${result.response.status}`)
    } catch (error) {
      console.error(`cleanup failed for ${sid}: ${String(error)}`)
      failures++
    }
  }
}

console.log(`Summary: ${failures} failed assertion(s)`)
if (failures) process.exitCode = 1
