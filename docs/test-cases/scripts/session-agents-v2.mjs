import { spawnSync } from "node:child_process"
import { isDeepStrictEqual } from "node:util"

const BASE = process.env.BASE ?? "http://localhost:14096"
const PG_URL = process.env.PG_URL
const rawModel = process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'
const parsedModel = JSON.parse(rawModel)
const MODEL = { providerID: parsedModel.providerID, model: parsedModel.modelID ?? parsedModel.id }
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "Content-Type": "application/json",
  ...(AUTH ? { Authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`PASS: ${message}`)
}

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = response.status === 204 ? "" : await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  return { status: response.status, data }
}

function pgValue(value) {
  const result = spawnSync(
    "psql",
    [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", value],
    { encoding: "utf8" },
  )
  if (result.status !== 0) throw new Error(`psql verification failed: ${result.stderr}`)
  return result.stdout.trim()
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`
}

async function runShell(sessionID, command) {
  const started = await api(`/api/session/${sessionID}/shell`, "POST", { command })
  if (started.status !== 204) throw new Error(`shell HTTP ${started.status}: ${JSON.stringify(started.data)}`)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const result = await api(`/api/session/${sessionID}/message?order=asc`)
    const messages = result.data?.data ?? []
    const shell = messages.filter((message) => message.type === "shell" && message.command === command).at(-1)
    if (shell && shell.status !== "running") {
      if (shell.status !== "exited" || shell.exit !== 0)
        throw new Error(`shell failed (${shell.status}, ${shell.exit}): ${shell.output?.output ?? ""}`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`shell timeout: ${command}`)
}

const created = await api("/api/session", "POST", { title: "session-agents-v2-e2e" })
assert(created.status === 200 && created.data?.data?.id, "create session over V2 API")
const sid = created.data.data.id
let otherID

try {
  const other = await api("/api/session", "POST", { title: "session-agents-v2-isolation" })
  assert(other.status === 200 && other.data?.data?.id, "create isolated session")
  otherID = other.data.data.id

  const createdAgent = await api(`/api/session/${sid}/agents`, "POST", {
    id: "session/reviewer",
    config: { description: "session reviewer", mode: "subagent", system: "Review carefully." },
  })
  assert(createdAgent.status === 200 && createdAgent.data?.source === "session", "create session override")
  if (PG_URL) {
    const stored = pgValue(
      `SELECT COUNT(*) || ':' || MIN(config::jsonb->>'description') FROM session_agents WHERE session_id=${sqlString(sid)} AND agent_id=${sqlString("session/reviewer")}`,
    )
    assert(stored === "1:session reviewer", "HTTP create persisted one matching PostgreSQL row")
  }

  const updatedAgent = await api(`/api/session/${sid}/agents`, "POST", {
    id: "session/reviewer",
    config: { description: "updated reviewer", mode: "subagent" },
  })
  assert(updatedAgent.status === 200 && updatedAgent.data?.agent?.description === "updated reviewer", "upsert override")
  assert(updatedAgent.data.agent.system !== "Review carefully.", "upsert replaces that Session's partial config")

  const list = await api(`/api/session/${sid}/agents`)
  const agent = list.data?.data?.find((item) => item.agent.id === "session/reviewer")
  assert(list.status === 200 && agent?.source === "session", "list merged effective agents")

  const isolated = await api(`/api/session/${otherID}/agents`)
  assert(!isolated.data?.data?.some((item) => item.agent.id === "session/reviewer"), "session definitions are isolated")

  const refreshed = await api(`/api/session/${sid}/agents/refresh`, "POST", {})
  assert(refreshed.status === 200 && Array.isArray(refreshed.data?.data), "refresh sandbox agent scan")

  const sandboxID = `sandbox-${sid}`
  const sandboxFile = `/workspace/.opencode/agents/${sandboxID}.md`
  const sandboxMarkdown = "---\ndescription: E2E sandbox agent\nmode: subagent\n---\nSANDBOX_AGENT_E2E_SYSTEM\n"
  const sandboxContent = Buffer.from(sandboxMarkdown).toString("base64")
  await runShell(
    sid,
    `mkdir -p /workspace/.opencode/agents && printf '%s' '${sandboxContent}' | base64 -d > '${sandboxFile}'`,
  )
  const sandboxRefresh = await api(`/api/session/${sid}/agents/refresh`, "POST", {})
  const sandboxAgent = sandboxRefresh.data?.data?.find((item) => item.agent.id === sandboxID)
  assert(
    sandboxAgent?.source === "sandbox" && sandboxAgent.sourcePath === `${sandboxID}.md`,
    "refresh discovers sandbox Markdown Agent and reports relative source path",
  )
  assert(sandboxAgent.agent.system === "SANDBOX_AGENT_E2E_SYSTEM", "sandbox Markdown body becomes Agent system prompt")

  const titleOverride = await api(`/api/session/${sid}/agents`, "POST", {
    id: "title",
    config: { system: "SESSION_TITLE_AGENT_E2E" },
  })
  assert(titleOverride.status === 200 && titleOverride.data?.agent?.system === "SESSION_TITLE_AGENT_E2E", "Session title Agent override is accepted")

  const roundTripID = `config-roundtrip-${sid.slice(-8)}`
  const roundTripConfig = {
    model: MODEL,
    request: { headers: { "x-session-agent-test": "roundtrip" }, body: { probe: "session-agent-config" } },
    system: "SESSION_AGENT_OPTIONAL_FIELDS_SYSTEM",
    description: "optional config fields round-trip",
    mode: "subagent",
    hidden: true,
    color: "#12aBcD",
    steps: 3,
    disabled: false,
    permissions: [{ action: "read", resource: "roundtrip/*", effect: "allow" }],
  }
  const roundTripCreated = await api(`/api/session/${sid}/agents`, "POST", { id: roundTripID, config: roundTripConfig })
  assert(roundTripCreated.status === 200, "create Agent with all optional ConfigAgent fields")
  const roundTripList = await api(`/api/session/${sid}/agents`)
  const roundTripAgent = roundTripList.data?.data?.find((item) => item.agent.id === roundTripID)?.agent
  assert(roundTripAgent, "list Agent with optional ConfigAgent fields")
  assert(
    roundTripAgent.model?.providerID === roundTripConfig.model.providerID && roundTripAgent.model?.id === roundTripConfig.model.model,
    "model config field round-trips",
  )
  assert(
    roundTripAgent.request.headers["x-session-agent-test"] === "roundtrip" && roundTripAgent.request.body.probe === "session-agent-config",
    "request headers/body config fields round-trip",
  )
  assert(
    roundTripAgent.system === roundTripConfig.system && roundTripAgent.description === roundTripConfig.description,
    "system and description config fields round-trip",
  )
  assert(
    roundTripAgent.mode === roundTripConfig.mode && roundTripAgent.hidden === true && roundTripAgent.color === roundTripConfig.color && roundTripAgent.steps === 3,
    "mode, hidden, color, and steps config fields round-trip",
  )
  assert(roundTripAgent.permissions.some((rule) => rule.resource === "roundtrip/*" && rule.effect === "allow"), "permissions config field merges into the effective Agent")
  if (PG_URL) {
    const storedConfig = JSON.parse(
      pgValue(`SELECT config::jsonb FROM session_agents WHERE session_id=${sqlString(sid)} AND agent_id=${sqlString(roundTripID)}`),
    )
    for (const [key, value] of Object.entries(roundTripConfig)) {
      assert(isDeepStrictEqual(storedConfig[key], value), `PostgreSQL config field ${key} round-trips`)
    }
  }
  assert((await api(`/api/session/${sid}/agents/${roundTripID}`, "DELETE")).status === 204, "delete optional-config round-trip Agent")

  assert((await api(`/api/session/ses_not_found/agents`, "POST", { id: "reviewer", config: {} })).status === 404, "unknown session create returns 404")
  assert((await api(`/api/session/ses_not_found/agents/refresh`, "POST", {})).status === 404, "unknown session refresh returns 404")
  assert((await api(`/api/session/${sid}/agents`, "POST", { config: {} })).status === 400, "missing Agent ID returns 400")
  assert(
    (await api(`/api/session/${sid}/agents`, "POST", { id: "invalid-mode", config: { mode: "invalid" } })).status === 400,
    "invalid Agent mode returns 400",
  )
  const oversized = await api(`/api/session/${sid}/agents`, "POST", {
    id: "oversized",
    config: { system: "x".repeat(270 * 1024) },
  })
  assert(oversized.status === 413 && oversized.data?._tag === "SessionAgentContentTooLargeError", "oversized config returns 413")

  assert((await api(`/api/session/${sid}/agents/session%2Freviewer`, "DELETE")).status === 204, "delete one override")
  if (PG_URL) {
    const remaining = pgValue(
      `SELECT COUNT(*) FROM session_agents WHERE session_id=${sqlString(sid)} AND agent_id=${sqlString("session/reviewer")}`,
    )
    assert(remaining === "0", "HTTP delete removed the PostgreSQL override row")
  }
  const afterDelete = await api(`/api/session/${sid}/agents`)
  assert(!afterDelete.data?.data?.some((item) => item.agent.id === "session/reviewer" && item.source === "session"), "delete removes Session override")
  assert((await api(`/api/session/${sid}/agents`, "DELETE")).status === 204, "clear all overrides")
  assert((await api(`/api/session/${sid}/agents`)).status === 200, "list after clear succeeds")
  assert((await api("/api/session/ses_not_found/agents", "GET")).status === 404, "unknown session list returns 404")
} finally {
  // Do not leave the test Agent definition in a persistent sandbox volume.
  // The session may already have been deleted if setup failed, so cleanup is best effort.
  try {
    const sandboxFile = `/workspace/.opencode/agents/sandbox-${sid}.md`
    await runShell(sid, `rm -f '${sandboxFile}'`)
  } catch {}
  if (otherID) await api(`/api/session/${otherID}`, "DELETE")
  await api(`/api/session/${sid}`, "DELETE")
  if (PG_URL) {
    const remaining = pgValue(`SELECT COUNT(*) FROM session_agents WHERE session_id=${sqlString(sid)}`)
    assert(remaining === "0", "session cleanup cascaded PostgreSQL Agent rows")
  }
}
