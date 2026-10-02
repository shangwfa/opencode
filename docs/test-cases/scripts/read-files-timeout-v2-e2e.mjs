import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14096").replace(/\/$/, "")
const FAULT_PROXY = (process.env.FAULT_PROXY ?? "http://127.0.0.1:8081").replace(/\/$/, "")
const PG_URL = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-files-timeout-e2e"
const password = process.env.OPENCODE_PASSWORD
assert(password, "OPENCODE_PASSWORD must match the test SaaS server")
const headers = {
  "content-type": "application/json",
  authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
}
const model = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}')
const sessionIDs = []
const filePath = `/workspace/read-timeout-e2e-${Date.now()}.txt`
const promptTimeout = Number(process.env.PROMPT_TIMEOUT ?? 90_000)
const escapeSql = (value) => value.replaceAll("'", "''")
let failed = 0

function check(name, passed, evidence = "") {
  console.log(`${passed ? "✅" : "❌"} ${name}${evidence ? ` — ${evidence}` : ""}`)
  if (!passed) failed++
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
  return { response, text, data }
}

function pg(sql) {
  const result = spawnSync("psql", [PG_URL, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function proxy(path, method = "GET", body) {
  const response = await fetch(`${FAULT_PROXY}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  assert(response.ok, `fault proxy ${path} failed HTTP ${response.status}: ${text}`)
  return text ? JSON.parse(text) : undefined
}

async function messages(sessionID) {
  const result = await api(`/api/session/${sessionID}/message?order=asc&limit=200`)
  assert(result.response.ok, `messages failed HTTP ${result.response.status}: ${result.text}`)
  return result.data?.data ?? []
}

async function shell(sessionID, command) {
  const result = await api(`/api/session/${sessionID}/shell`, "POST", { command }, 90_000)
  assert([200, 204].includes(result.response.status), `shell failed HTTP ${result.response.status}: ${result.text}`)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const rows = await messages(sessionID)
    const latest = rows.findLast((message) => message.type === "shell")
    if (latest?.time?.completed != null) return latest
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`shell timed out: ${command}`)
}

console.log(`Read files timeout V2 E2E: API=${BASE}; fault proxy=${FAULT_PROXY}; PG=${PG_URL}`)
try {
  const health = await api("/")
  assert(health.response.ok, `SaaS API is unavailable: HTTP ${health.response.status}`)
  const providerList = await api("/api/provider?location[directory]=%2Fworkspace")
  console.log(
    `Available providers: HTTP ${providerList.response.status} ${JSON.stringify((providerList.data?.data ?? []).map((provider) => provider.id))}; response=${providerList.text.slice(0, 250)}`,
  )
  const models = await api("/api/model?location[directory]=%2Fworkspace")
  console.log(
    `Available mock models: HTTP ${models.response.status} ${JSON.stringify((models.data?.data ?? []).filter((model) => model.providerID === "e2e-mock").map((model) => model.id))}`,
  )
  const config = await api("/api/config?location[directory]=%2Fworkspace")
  const configEntries = Array.isArray(config.data) ? config.data : (config.data?.data ?? [])
  const configProviders = configEntries.flatMap((entry) => Object.keys(entry.info?.providers ?? {}))
  console.log(
    `Location config: HTTP ${config.response.status}; shape=${JSON.stringify({ entries: configEntries.map((entry) => ({ type: entry.type, providers: Object.keys(entry.info?.providers ?? {}) })), providers: configProviders })}`,
  )
  const created = await api("/api/session", "POST", {
    title: `read-files-timeout-e2e-${Date.now()}`,
    model,
    location: { directory: "/workspace" },
  })
  assert(created.response.ok, `session create failed HTTP ${created.response.status}: ${created.text}`)
  const sessionID = created.data?.data?.id
  assert(sessionID, `session create response has no ID: ${created.text}`)
  sessionIDs.push(sessionID)

  const initialized = await shell(sessionID, `printf 'timeout-fixture\n' > '${filePath}'`)
  check("API shell creates a real file and Sandbox", initialized.exit === 0)
  const sandboxBefore = pg(
    `select id from sandbox where session_id='${escapeSql(sessionID)}' and state='running' order by time_created desc limit 1`,
  )
  check("PG records one running Sandbox before injection", sandboxBefore.length > 0, sandboxBefore)

  await proxy("/__fault/enable", "POST", { path: filePath })
  const before = new Set(
    (await messages(sessionID)).flatMap((message) =>
      message.type === "assistant"
        ? (message.content ?? []).filter((part) => part.type === "tool").map((part) => part.id)
        : [],
    ),
  )
  const promptResponse = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: `只调用一次 read 工具，读取绝对路径 ${filePath}。不要调用其他工具。若读取失败，直接说明失败原因，不要重试、不要改用其他工具。`,
      metadata: {},
      delivery: "queue",
    }),
    signal: AbortSignal.timeout(promptTimeout),
  })
  const promptBody = await promptResponse.text()
  assert(promptResponse.ok, `prompt_stream failed HTTP ${promptResponse.status}: ${promptBody.slice(0, 500)}`)

  const rows = await messages(sessionID)
  const tools = rows.flatMap((message) =>
    message.type === "assistant"
      ? (message.content ?? []).filter((part) => part.type === "tool" && !before.has(part.id))
      : [],
  )
  const readPart = tools.find((part) => part.name === "read" && part.state?.input?.path === filePath) ??
    tools.find((part) => part.name === "read")
  const errorEvidence = JSON.stringify(readPart?.state ?? {})
  check("Read tool part persists timeout result", Boolean(readPart) && /timed out after 2s/i.test(errorEvidence), errorEvidence)

  const fault = await proxy("/__fault/status")
  // One files request that times out is retried exactly once, so each frozen
  // request cycle must produce one attempt plus one retry, all cancelled by the
  // client. The model may issue more than one read in a turn, so assert the
  // 1:1 attempt/cancel relationship instead of a fixed global count.
  check(
    "every stalled files attempt was cancelled by the client",
    fault.hits > 0 && fault.hits === fault.aborted && fault.hits % 2 === 0,
    JSON.stringify(fault),
  )
  const retried = fault.hits >= 2
  check("the stalled files request was retried once", retried, `attempts=${fault.hits}`)
  const sandboxAfter = pg(
    `select id from sandbox where session_id='${escapeSql(sessionID)}' and state='running' order by time_created desc limit 1`,
  )
  check("timeout does not destroy or replace the Sandbox", sandboxAfter === sandboxBefore, `${sandboxBefore} -> ${sandboxAfter}`)
  const toolInPg = pg(
    `select count(*) from session_message m, jsonb_array_elements(m.data::jsonb->'content') p where m.session_id='${escapeSql(sessionID)}' and p->>'type'='tool' and p->>'name'='read' and p::text ilike '%timed out after 2s%'`,
  )
  check("PG persists the timeout tool part", Number(toolInPg) >= 1, `matching parts=${toolInPg}`)

  await proxy("/__fault/disable", "POST", {})
  const afterTimeout = await shell(sessionID, "echo sandbox-still-usable")
  check("same Sandbox remains usable after the timeout", afterTimeout.exit === 0)
  const sandboxStillRunning = pg(
    `select count(*) from sandbox where session_id='${escapeSql(sessionID)}' and state='running' and id='${escapeSql(sandboxBefore)}'`,
  )
  check("PG still has the original running Sandbox", sandboxStillRunning === "1", sandboxStillRunning)
} catch (error) {
  console.error(`Read timeout E2E error: ${error instanceof Error ? error.stack : String(error)}`)
  try {
    console.error(`Fault proxy state: ${JSON.stringify(await proxy("/__fault/status"))}`)
    const sessionID = sessionIDs[0]
    if (sessionID) {
      console.error(`Latest Session messages: ${JSON.stringify((await messages(sessionID)).slice(-3))}`)
      console.error(`Running Sandbox rows: ${pg(`select id||':'||state from sandbox where session_id='${escapeSql(sessionID)}' order by time_created desc`)}`)
    }
  } catch (diagnosticError) {
    console.error(`Timeout E2E diagnostics failed: ${String(diagnosticError)}`)
  }
  failed++
} finally {
  try {
    await proxy("/__fault/disable", "POST", {})
  } catch (error) {
    console.error(`fault proxy cleanup failed: ${String(error)}`)
    failed++
  }
  for (const sessionID of sessionIDs) {
    try {
      const killed = await api(`/api/session/${sessionID}/kill-sandbox`, "POST", {})
      assert(killed.response.ok, `Sandbox cleanup failed HTTP ${killed.response.status}: ${killed.text}`)
      assert.equal(pg(`select count(*) from sandbox where session_id='${escapeSql(sessionID)}' and state='running'`), "0")
      const deleted = await api(`/api/session/${sessionID}`, "DELETE")
      assert([200, 204].includes(deleted.response.status), `Session cleanup failed HTTP ${deleted.response.status}`)
    } catch (error) {
      console.error(`session cleanup failed for ${sessionID}: ${String(error)}`)
      failed++
    }
  }
}

console.log(`Summary: ${failed} failed assertion(s)`)
if (failed) process.exitCode = 1
