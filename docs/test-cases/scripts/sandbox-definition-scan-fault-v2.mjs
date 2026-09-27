import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"

/**
 * Session sandbox definition scan (V2) — fault path.
 *
 * Runs against a SaaS instance whose sandbox endpoint is unreachable, so every sandbox command
 * fails. Verifies the documented asymmetry: Agent `list` degrades to configured + Session
 * definitions, while explicit `refresh` and both Command reads surface an identifiable failure.
 *
 * See `docs/test-cases/session/sandbox-definition-scan.md` SAS-AG-09 and SAS-CM-06.
 */

const BASE = (process.env.BASE ?? "http://localhost:14100").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const nonce = randomUUID().replaceAll("-", "").slice(0, 8)
const timeout = Number(process.env.SCAN_E2E_TIMEOUT_MS ?? 240_000)
const sessionIDs = []
const passed = []

const say = (line) => process.stdout.write(`${line}\n`)
function check(condition, description) {
  assert(condition, description)
  passed.push(description)
  say(`PASS: ${description}`)
}
function pg(sql) {
  if (!PG_URL) throw new Error("PG_URL is required")
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`)
  return result.stdout.trim()
}
const sqlQuote = (value) => `'${value.replaceAll("'", "''")}'`

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = response.status === 204 ? "" : await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  return { response, text, data }
}

try {
  const created = await api("/api/session", "POST", { title: `scan-fault-${nonce}`, location: { directory: "/workspace" } })
  assert.equal(created.response.status, 200, created.text)
  const root = created.data?.data?.id ?? created.data?.id
  sessionIDs.push(root)

  const agentID = `session/degrade-${nonce}`
  const saved = await api(`/api/session/${root}/agents`, "POST", {
    id: agentID,
    config: { mode: "primary", system: `FAULT_AGENT_${nonce}` },
  })
  assert.equal(saved.response.status, 200, saved.text)
  const commandName = `degrade-${nonce}`
  const savedCommand = await api(`/api/session/${root}/commands`, "POST", {
    name: commandName,
    template: `FAULT_COMMAND_${nonce}`,
  })
  assert.equal(savedCommand.response.status, 200, savedCommand.text)

  // ---------------------------------------------------------------- SAS-AG-09
  const listed = await api(`/api/session/${root}/agents`)
  assert.equal(listed.response.status, 200, `SAS-AG-09: GET agents returned ${listed.response.status}: ${listed.text}`)
  const items = listed.data?.data ?? listed.data
  assert(
    items.some((item) => item.agent.id === agentID && item.source === "session"),
    `SAS-AG-09: degraded list dropped the Session definition: ${listed.text.slice(0, 300)}`,
  )
  assert(!items.some((item) => item.source === "sandbox"), "SAS-AG-09: degraded list reported sandbox definitions")
  check(true, "SAS-AG-09 Agent GET degrades to configured + Session definitions without a 5xx")

  const refreshed = await api(`/api/session/${root}/agents/refresh`, "POST")
  assert(
    refreshed.response.status >= 400 && refreshed.response.status < 600,
    `SAS-AG-09: explicit refresh returned ${refreshed.response.status}`,
  )
  check(true, `SAS-AG-09 explicit Agent refresh surfaces an identifiable failure (${refreshed.response.status})`)

  // ---------------------------------------------------------------- SAS-CM-06
  const commandList = await api(`/api/session/${root}/commands`)
  assert(
    commandList.response.status >= 400 && commandList.response.status < 600,
    `SAS-CM-06: GET commands returned ${commandList.response.status} instead of surfacing the scan failure`,
  )
  const commandRefresh = await api(`/api/session/${root}/commands/refresh`, "POST")
  assert(
    commandRefresh.response.status >= 400 && commandRefresh.response.status < 600,
    `SAS-CM-06: commands refresh returned ${commandRefresh.response.status}`,
  )
  assert(
    !/FAULT_COMMAND_/.test(commandList.text),
    "SAS-CM-06: failure response leaked command template content",
  )
  check(
    true,
    `SAS-CM-06 Command list (${commandList.response.status}) and refresh (${commandRefresh.response.status}) surface the scan failure`,
  )

  // The failure must not corrupt stored definitions.
  assert.equal(
    pg(`SELECT count(*) FROM session_agents WHERE session_id=${sqlQuote(root)} AND agent_id=${sqlQuote(agentID)}`),
    "1",
  )
  assert.equal(
    pg(`SELECT count(*) FROM session_commands WHERE session_id=${sqlQuote(root)} AND name=${sqlQuote(commandName)}`),
    "1",
  )
  check(true, "SAS-AG-09/CM-06 scan failures left existing PostgreSQL rows untouched")
} finally {
  for (const id of sessionIDs.reverse()) await api(`/api/session/${id}`, "DELETE")
}

if (sessionIDs.length) {
  const ids = sessionIDs.map(sqlQuote).join(",")
  assert.equal(pg(`SELECT count(*) FROM session_v2 WHERE id IN (${ids})`), "0", "test Sessions remained in PostgreSQL")
  check(true, "all test Session rows were removed from PostgreSQL")
}

if (passed.length) say(`\n${passed.length} fault-path assertion(s) passed.`)
