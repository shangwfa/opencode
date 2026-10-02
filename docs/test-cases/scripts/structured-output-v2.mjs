import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14103").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const password = process.env.OPENCODE_PASSWORD
const headers = {
  "content-type": "application/json",
  ...(password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}),
}
const model = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}')
const sessions = []
let failures = 0

function check(name, condition, detail = "") {
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? `: ${detail}` : ""}`)
  if (!condition) failures++
}

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
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

async function create(title) {
  const { response, data } = await api("/api/session", "POST", {
    title,
    location: { directory: "/workspace" },
    model,
  })
  assert(response.ok, `create HTTP ${response.status}: ${JSON.stringify(data)}`)
  const id = data?.data?.id
  assert(id, `create returned no ID: ${JSON.stringify(data)}`)
  sessions.push(id)
  return id
}

async function messages(sid) {
  const { response, data } = await api(`/api/session/${sid}/message?order=asc&limit=100`)
  assert(response.ok, `message list HTTP ${response.status}: ${JSON.stringify(data)}`)
  return data?.data ?? data
}

async function wait(sid) {
  const { response, data } = await api(`/api/experimental/session/${sid}/wait`, "POST", {})
  assert(response.ok, `wait HTTP ${response.status}: ${JSON.stringify(data)}`)
}

async function prompt(sid, payload) {
  return api(`/api/session/${sid}/prompt`, "POST", { metadata: {}, delivery: "queue", ...payload })
}

async function waitForStructured(sid, timeout = 240_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const rows = await messages(sid)
    const result = rows.findLast((message) => message.type === "assistant" && message.structured != null)
    if (result) return { rows, result }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`timed out waiting for structured assistant message in ${sid}`)
}

function pg(sql) {
  assert(PG_URL, "PG_URL required for PG assertion")
  const result = spawnSync("psql", [PG_URL, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function structuredPrompt(sid, text, schema) {
  const accepted = await prompt(sid, { text, format: { type: "json_schema", schema } })
  assert.equal(accepted.response.status, 200, `prompt failed: ${accepted.text}`)
  assert(accepted.data?.data?.id, `prompt omitted accepted message ID: ${accepted.text}`)
  await wait(sid)
  return waitForStructured(sid)
}

console.log(`Structured Output V2: ${BASE}; model=${model.providerID}/${model.id}`)
try {
  // TSO.1 + TSO.2: JSON schema, list and single-message GET, plus storage projection.
  const basic = await create("structured-basic")
  const basicSchema = {
    type: "object",
    properties: { answer: { type: "boolean" }, city: { type: "string" } },
    required: ["answer", "city"],
    additionalProperties: false,
  }
  const first = await structuredPrompt(basic, "北京是中国的首都吗？返回 answer 和 city。", basicSchema)
  check(
    "TSO.1 required schema result",
    first.result.structured?.answer === true && first.result.structured?.city === "北京",
    JSON.stringify(first.result.structured),
  )
  const user = first.rows.find((message) => message.type === "user")
  check("TSO.2 list returns user format", user?.format?.type === "json_schema", JSON.stringify(user?.format))
  const one = await api(`/api/session/${basic}/message/${user.id}`)
  check(
    "TSO.2 single GET returns format",
    one.response.ok && one.data?.data?.format?.type === "json_schema",
    `HTTP ${one.response.status}`,
  )
  const assistantByID = await api(`/api/session/${basic}/message/${first.result.id}`)
  check(
    "TSO.2 single GET returns structured",
    assistantByID.response.ok && assistantByID.data?.data?.structured?.city === "北京",
    `HTTP ${assistantByID.response.status}`,
  )
  const dbResult = pg(
    `select data::jsonb->'structured' from session_message where session_id='${basic}' and id='${first.result.id}'`,
  )
  check("TSO.1 PG structured projection", JSON.parse(dbResult)?.city === "北京", dbResult)

  // TSO.3: asynchronous prompt admission followed by wait and readback.
  const asyncSID = await create("structured-async")
  const asyncSchema = { type: "object", properties: { color: { type: "string" } }, required: ["color"] }
  const asyncResult = await structuredPrompt(asyncSID, "天空是什么颜色？color 用一个中文词回答。", asyncSchema)
  check(
    "TSO.3 async acceptance and structured result",
    asyncResult.result.structured?.color != null,
    JSON.stringify(asyncResult.result.structured),
  )

  // TSO.4: prompt_stream terminates at an execution result; the structured value is projected too.
  const streamSID = await create("structured-stream")
  const streamResponse = await fetch(`${BASE}/api/session/${streamSID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: "一周有几天？",
      metadata: {},
      delivery: "queue",
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { days: { type: "integer" } }, required: ["days"] },
      },
    }),
    signal: AbortSignal.timeout(240_000),
  })
  const streamText = await streamResponse.text()
  const streamEvents = [...streamText.matchAll(/^data:\s*(.+)$/gm)].flatMap((match) => {
    try {
      return [JSON.parse(match[1])]
    } catch {
      return []
    }
  })
  const terminal = streamEvents.at(-1)?.type
  const streamRows = await messages(streamSID)
  const streamStructured = streamRows.findLast((message) => message.type === "assistant" && message.structured != null)
  check(
    "TSO.4 prompt_stream terminal",
    streamResponse.ok && terminal === "session.execution.succeeded",
    `HTTP ${streamResponse.status}; terminal=${terminal}`,
  )
  check(
    "TSO.4 structured readback",
    streamStructured?.structured?.days === 7,
    JSON.stringify(streamStructured?.structured),
  )

  // TSO.5: request schema rejects unknown format type and non-object JSON Schema.
  const invalidSID = await create("structured-invalid")
  const invalidType = await prompt(invalidSID, { text: "invalid", format: { type: "xml", schema: {} } })
  const invalidSchema = await prompt(invalidSID, { text: "invalid", format: { type: "json_schema", schema: 42 } })
  check("TSO.5 invalid type returns 400", invalidType.response.status === 400, `HTTP ${invalidType.response.status}`)
  check(
    "TSO.5 invalid schema returns 400",
    invalidSchema.response.status === 400,
    `HTTP ${invalidSchema.response.status}`,
  )

  // TSO.6: explicit text mode stays a plain assistant response.
  const textSID = await create("structured-text")
  const textAccepted = await prompt(textSID, { text: "只回复两个字：收到", format: { type: "text" } })
  check("TSO.6 text mode accepted", textAccepted.response.status === 200, `HTTP ${textAccepted.response.status}`)
  await wait(textSID)
  const textRows = await messages(textSID)
  check(
    "TSO.6 no structured result",
    !textRows.some((message) => message.type === "assistant" && message.structured != null),
  )
  check(
    "TSO.6 normal assistant text",
    textRows.some(
      (message) =>
        message.type === "assistant" && message.content?.some((part) => part.type === "text" && part.text.trim()),
    ),
  )

  // TSO.7: corrupt only our own user-message format, then ensure list decoding degrades safely.
  const dirtyUser = textRows.find((message) => message.type === "user")
  const escapedSID = textSID.replaceAll("'", "''")
  const escapedMID = dirtyUser.id.replaceAll("'", "''")
  const updated = pg(
    `update session_message set data=jsonb_set(data::jsonb, '{format}', '{"type":"xml","legacy":true}'::jsonb)::text where session_id='${escapedSID}' and id='${escapedMID}' and type='user' returning id`,
  )
  check("TSO.7 test row corrupted", updated === dirtyUser.id, updated)
  const dirtyRead = await api(`/api/session/${textSID}/message?order=asc&limit=100`)
  const decodedDirtyUser = dirtyRead.data?.data?.find((message) => message.id === dirtyUser.id)
  check(
    "TSO.7 invalid stored format is discarded",
    dirtyRead.response.ok && decodedDirtyUser?.format == null,
    `HTTP ${dirtyRead.response.status}; format=${JSON.stringify(decodedDirtyUser?.format)}`,
  )
} catch (error) {
  console.error(`Structured Output test error: ${error instanceof Error ? error.stack : String(error)}`)
  failures++
} finally {
  for (const sid of sessions) {
    try {
      const { response } = await api(`/api/session/${sid}`, "DELETE")
      assert([200, 204].includes(response.status), `delete ${sid} HTTP ${response.status}`)
    } catch (error) {
      console.error(`cleanup failed for ${sid}: ${String(error)}`)
      failures++
    }
  }
}

console.log(`Summary: ${failures} failed assertion(s)`)
if (failures) process.exitCode = 1
