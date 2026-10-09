import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://localhost:14101").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
assert(PG_URL, "PG_URL is required; this test verifies PostgreSQL persistence")

const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const watchers = []

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
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

function check(value, description) {
  assert(value, `FAIL: ${description}`)
  console.log(`PASS: ${description}`)
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    )
  return value
}

function pg(sql) {
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`psql verification failed: ${result.stderr}`)
  return result.stdout.trim()
}

function watchSession(sessionID) {
  const controller = new AbortController()
  const task = (async () => {
    const response = await fetch(`${BASE}/api/session/${sessionID}/event`, {
      headers: { ...headers, accept: "text/event-stream" },
      signal: controller.signal,
    })
    if (response.status !== 200) throw new Error(`SSE HTTP ${response.status} for ${sessionID}`)
    console.log(`[SSE ${sessionID}] 已订阅会话事件`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (!controller.signal.aborted) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ""
      for (const block of blocks) {
        const raw = block.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim()
        if (!raw) continue
        try {
          const event = JSON.parse(raw)
          if (!/delta|streamed|usage.updated/.test(event.type)) console.log(`[SSE ${sessionID}] ${event.type}`)
        } catch {}
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) console.error(`[SSE ${sessionID}] ${String(error)}`)
  })
  watchers.push({ controller, task })
}

async function prepareSandbox(sessionID) {
  const started = await api(`/api/session/${sessionID}/shell`, "POST", { command: "true", timeoutSeconds: 30 })
  check(started.status === 204, "initialize per-Session OpenSandbox through shell API")
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const result = await api(`/api/session/${sessionID}/message?order=asc`)
    const shell = (result.data?.data ?? []).find((message) => message.type === "shell" && message.command === "true")
    if (shell?.status === "exited") {
      check(shell.exit === 0, "Sandbox setup command exits successfully")
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Sandbox initialization timed out for ${sessionID}`)
}

const created = await api("/api/session", "POST", { title: "permission preset API test" })
check(created.status === 200 && created.data?.data?.id, "create primary Session through HTTP API")
const sessionID = created.data.data.id
watchSession(sessionID)
await prepareSandbox(sessionID)
const otherCreated = await api("/api/session", "POST", { title: "permission preset isolation test" })
check(otherCreated.status === 200 && otherCreated.data?.data?.id, "create isolated Session through HTTP API")
const otherID = otherCreated.data.data.id
watchSession(otherID)
await prepareSandbox(otherID)
const agentID = "preset-probe"

try {
  const agentCreated = await api(`/api/session/${sessionID}/agents`, "POST", {
    id: agentID,
    config: { system: "PRESET_TEST_SYSTEM", description: "Preserve this Agent field" },
  })
  check(agentCreated.status === 200, "create Agent with fields that preset update must preserve")
  const agentConfigBeforeSessionPreset = JSON.parse(
    pg(`SELECT config::jsonb FROM session_agents WHERE session_id=${quote(sessionID)} AND agent_id=${quote(agentID)}`),
  )

  const sessionPreset = await api(`/api/session/${sessionID}/permissions/preset`, "PUT", { preset: "read-only" })
  check(sessionPreset.status === 200 && sessionPreset.data?.preset === "read-only", "set Session read-only preset")
  const readOnlyRules = sessionPreset.data.permissions
  check(
      readOnlyRules[0]?.action === "*" && readOnlyRules[0]?.effect === "deny" &&
      readOnlyRules.some((rule) => rule.action === "read" && rule.effect === "allow") &&
      !readOnlyRules.some((rule) => rule.action === "edit" && rule.effect === "allow") &&
      readOnlyRules.some((rule) => rule.action === "read" && rule.resource === "*.env" && rule.effect === "ask") &&
      readOnlyRules.some((rule) => rule.action === "read" && rule.resource === "*.env.*" && rule.effect === "ask") &&
      readOnlyRules.some((rule) => rule.action === "read" && rule.resource === "*.env.example" && rule.effect === "allow"),
    "read-only response contains deny/read rules and protected .env exceptions",
  )
  const sessionReadback = await api(`/api/session/${sessionID}`)
  check(
    sessionReadback.status === 200 &&
      JSON.stringify(stable(sessionReadback.data?.data?.permissions)) === JSON.stringify(stable(readOnlyRules)),
    "Session preset reads back through GET Session",
  )
  const sessionRulesPG = JSON.parse(
    pg(`SELECT permission::jsonb FROM session_v2 WHERE id=${quote(sessionID)}`),
  )
  check(
    JSON.stringify(stable(sessionRulesPG)) === JSON.stringify(stable(readOnlyRules)),
    "Session preset persists exactly in PostgreSQL",
  )
  const agentConfigAfterSessionPreset = JSON.parse(
    pg(`SELECT config::jsonb FROM session_agents WHERE session_id=${quote(sessionID)} AND agent_id=${quote(agentID)}`),
  )
  check(
    JSON.stringify(stable(agentConfigBeforeSessionPreset)) === JSON.stringify(stable(agentConfigAfterSessionPreset)),
    "Session preset does not mutate the Session Agent override row",
  )

  async function evaluate(action, resource) {
    const result = await api(`/api/session/${sessionID}/permission`, "POST", {
      action,
      resources: [resource],
      agent: agentID,
    })
    check(result.status === 200 && result.data?.data?.effect, `evaluate ${action} ${resource}`)
    return result.data.data.effect
  }

  const agentWorkspace = await api(
    `/api/session/${sessionID}/agents/${agentID}/permissions/preset`,
    "PUT",
    { preset: "workspace-write" },
  )
  check(agentWorkspace.status === 200 && agentWorkspace.data?.preset === "workspace-write", "set Agent workspace-write preset")
  check(
    agentWorkspace.data?.agent?.agent?.system === "PRESET_TEST_SYSTEM" &&
      agentWorkspace.data?.agent?.agent?.description === "Preserve this Agent field",
    "Agent preset preserves system and description fields",
  )
  let agentConfig = JSON.parse(
    pg(`SELECT config::jsonb FROM session_agents WHERE session_id=${quote(sessionID)} AND agent_id=${quote(agentID)}`),
  )
  check(
    agentConfig.system === "PRESET_TEST_SYSTEM" &&
      agentConfig.description === "Preserve this Agent field" &&
      agentConfig.permissions.some((rule) => rule.action === "edit" && rule.effect === "allow") &&
      agentConfig.permissions.some((rule) => rule.action === "external_directory" && rule.effect === "deny"),
    "Agent override and preset rules persist in PostgreSQL without dropping other config",
  )
  check((await evaluate("read", "src/index.ts")) === "allow", "read-only Session still allows workspace reads")
  check((await evaluate("edit", "src/index.ts")) === "deny", "Session read-only denies edit despite Agent workspace-write")

  const sessionWorkspace = await api(`/api/session/${sessionID}/permissions/preset`, "PUT", {
    preset: "workspace-write",
  })
  check(sessionWorkspace.status === 200, "replace Session preset with workspace-write")
  check((await evaluate("edit", "src/index.ts")) === "allow", "workspace-write allows workspace edit")
  check((await evaluate("shell", "git status")) === "ask", "workspace-write asks before shell execution")
  check((await evaluate("external_directory", "/tmp/preset-probe")) === "deny", "workspace-write denies external directory access")

  const agentFull = await api(
    `/api/session/${sessionID}/agents/${agentID}/permissions/preset`,
    "PUT",
    { preset: "full-access" },
  )
  check(agentFull.status === 200, "replace Agent preset with full-access")
  const sessionBeforeAgentFull = await api(`/api/session/${sessionID}`)
  const sessionRulesBeforeAgentFull = sessionBeforeAgentFull.data?.data?.permissions
  const agentConfigFull = JSON.parse(
    pg(`SELECT config::jsonb FROM session_agents WHERE session_id=${quote(sessionID)} AND agent_id=${quote(agentID)}`),
  )
  check(
    agentConfigFull.permissions.length === 2 &&
      agentConfigFull.permissions[0].action === "*" && agentConfigFull.permissions[0].effect === "allow" &&
      agentConfigFull.permissions[1].action === "external_directory" && agentConfigFull.permissions[1].effect === "allow",
    "Agent full-access replaces Agent preset rules in PostgreSQL",
  )
  check(
    JSON.stringify(stable((await api(`/api/session/${sessionID}`)).data?.data?.permissions)) ===
      JSON.stringify(stable(sessionRulesBeforeAgentFull)),
    "Agent preset does not mutate Session-level permissions",
  )
  const sessionFull = await api(`/api/session/${sessionID}/permissions/preset`, "PUT", { preset: "full-access" })
  check(sessionFull.status === 200, "replace Session preset with full-access")
  check((await evaluate("mcp/deploy", "*")) === "allow", "full-access allows an otherwise unknown custom action")
  check((await evaluate("external_directory", "/tmp/preset-probe")) === "allow", "full-access permission rule allows external_directory")
  agentConfig = JSON.parse(
    pg(`SELECT config::jsonb FROM session_agents WHERE session_id=${quote(sessionID)} AND agent_id=${quote(agentID)}`),
  )
  check(
    agentConfig.permissions.length === 2 &&
      agentConfig.permissions.some((rule) => rule.action === "*" && rule.effect === "allow") &&
      agentConfig.permissions.some((rule) => rule.action === "external_directory" && rule.effect === "allow"),
    "new Agent preset replaces rather than appends old preset rules in PostgreSQL",
  )

  const otherSession = await api(`/api/session/${otherID}`)
  check(
    otherSession.status === 200 &&
      (!otherSession.data?.data?.permissions || otherSession.data.data.permissions.length === 0),
    "preset changes do not leak into another Session",
  )
  check(
    pg(`SELECT count(*) FROM session_agents WHERE session_id=${quote(otherID)} AND agent_id=${quote(agentID)}`) === "0",
    "Agent preset does not create an Agent row in another Session",
  )

  check(
    (await api(`/api/session/${sessionID}/permissions/preset`, "PUT", { preset: "unknown" })).status === 400,
    "reject unknown preset value",
  )
  check(
    (await api(`/api/session/${sessionID}/agents/missing/permissions/preset`, "PUT", { preset: "read-only" })).status === 404,
    "return 404 for an Agent that does not exist in this Session",
  )
  check(
    (await api(`/api/session/${sessionID}/agents/bad%20id/permissions/preset`, "PUT", { preset: "read-only" })).status === 400,
    "reject invalid Agent ID",
  )
  check(
    (await api(`/api/session/ses_preset_missing/permissions/preset`, "PUT", { preset: "read-only" })).status === 404,
    "return 404 for a missing Session",
  )
} finally {
  const deletedOther = await api(`/api/session/${otherID}`, "DELETE")
  check(deletedOther.status === 204, "delete isolated Session through API")
  const deletedPrimary = await api(`/api/session/${sessionID}`, "DELETE")
  check(deletedPrimary.status === 204, "delete primary Session through API")
  for (const watcher of watchers) watcher.controller.abort()
  await Promise.allSettled(watchers.map((watcher) => watcher.task))
  check(pg(`SELECT count(*) FROM session_agents WHERE session_id=${quote(sessionID)}`) === "0", "cleanup removes Session Agent rows from PostgreSQL")
}
