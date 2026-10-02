import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14102").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const password = process.env.OPENCODE_PASSWORD
const headers = {
  "content-type": "application/json",
  ...(password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}),
}
const model = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}')
const sessions = []
const liveStreams = []
let failed = 0

function check(name, condition, detail = "") {
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? `: ${detail}` : ""}`)
  if (!condition) failed++
}

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  return { response, data }
}

async function create() {
  const { response, data } = await api("/api/session", "POST", {
    title: `sse-smoke-${Date.now()}`,
    location: { directory: "/workspace" },
    model,
  })
  assert(response.ok, `create HTTP ${response.status}: ${JSON.stringify(data)}`)
  const id = data?.data?.id
  assert(id, "create response missing session id")
  sessions.push(id)
  return id
}

function subscribe(url) {
  const controller = new AbortController()
  const events = []
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`SSE did not connect: ${url}`)), 15_000)
    const markReady = () => {
      clearTimeout(timeout)
      resolve()
    }
    ;(async () => {
      try {
        const response = await fetch(url, { headers, signal: controller.signal })
        assert(response.ok, `SSE HTTP ${response.status}: ${url}`)
        assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/i)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const blocks = buffer.split(/\r?\n\r?\n/)
          buffer = blocks.pop() ?? ""
          for (const block of blocks) {
            const line = block.split(/\r?\n/).find((entry) => entry.startsWith("data:"))
            if (!line) continue
            try {
              const event = JSON.parse(line.slice(5).trim())
              events.push(event)
              if (event.type === "server.connected") markReady()
            } catch {}
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) reject(error)
      }
    })()
  })
  return {
    events,
    ready,
    async close() {
      controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 25))
    },
  }
}

function pg(sql) {
  assert(PG_URL, "PG_URL required for database assertions")
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

console.log(`SSE V2 smoke: ${BASE}`)
try {
  const global = subscribe(`${BASE}/api/event`)
  liveStreams.push(global)
  await global.ready
  const sid = await create()
  await new Promise((resolve) => setTimeout(resolve, 100))
  check(
    "T9.1/T9.2 global connected + session.created",
    global.events.some((event) => event.type === "server.connected") &&
      global.events.some((event) => event.type === "session.created" && (event.data ?? {}).sessionID === sid),
  )

  const streamA = subscribe(`${BASE}/api/session/${sid}/event`)
  liveStreams.push(streamA)
  const other = await create()
  const streamB = subscribe(`${BASE}/api/session/${other}/event`)
  liveStreams.push(streamB)
  await Promise.all([streamA.ready, streamB.ready])

  const prompt = await fetch(`${BASE}/api/session/${sid}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "只回复：SSE验证成功", metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(180_000),
  })
  const responseText = await prompt.text()
  assert(prompt.ok, `prompt_stream HTTP ${prompt.status}: ${responseText.slice(0, 300)}`)
  const followed = [...responseText.matchAll(/^data:\s*(.+)$/gm)]
    .map((match) => {
      try {
        return JSON.parse(match[1])
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
  const followedTypes = followed.map((event) => event.type)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const sessionEvents = streamA.events.filter((event) => event.type !== "server.connected")
  const wrongSessionIDs = sessionEvents.map((event) => (event.data ?? {}).sessionID).filter((id) => id && id !== sid)
  check(
    "T9.5 text delta and ended",
    followedTypes.includes("session.text.delta") && followedTypes.includes("session.text.ended"),
  )
  check(
    "T9.31 prompt_stream ends at succeeded",
    followedTypes.at(-1) === "session.execution.succeeded",
    followedTypes.at(-1),
  )
  check("T9.29 session stream isolation", wrongSessionIDs.length === 0, `foreign session IDs=${wrongSessionIDs.length}`)
  check("T9.9 execution lifecycle", followedTypes.includes("session.execution.started"))

  const logResponse = await fetch(`${BASE}/api/experimental/session/${sid}/log?after=0&follow=false`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  })
  const logText = await logResponse.text()
  const replayed = [...logText.matchAll(/^data:\s*(.+)$/gm)]
    .map((match) => {
      try {
        return JSON.parse(match[1])
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
  const durableCount = PG_URL
    ? pg(`select count(*) from event where aggregate_id='${sid.replaceAll("'", "''")}'`)
    : "unavailable"
  check(
    "T9.35 durable event persistence/replay",
    logResponse.ok && durableCount !== "0" && replayed.some((event) => event.type === "session.execution.succeeded"),
    `PG rows=${durableCount}, replayed=${replayed.length}`,
  )

  await Promise.all([streamA.close(), streamB.close(), global.close()])
} catch (error) {
  console.error(`SSE smoke error: ${error instanceof Error ? error.stack : String(error)}`)
  failed++
} finally {
  await Promise.all(liveStreams.map((stream) => stream.close()))
  for (const id of sessions) {
    try {
      await api(`/api/session/${id}`, "DELETE")
    } catch (error) {
      console.error(`cleanup failed for ${id}: ${String(error)}`)
      failed++
    }
  }
}

console.log(`Summary: ${failed} failed assertion(s)`)
if (failed) process.exitCode = 1
