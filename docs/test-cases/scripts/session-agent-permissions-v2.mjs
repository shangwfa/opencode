import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://localhost:14096").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
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

function check(ok, description) {
  assert(ok, `FAIL: ${description}`)
  console.log(`PASS: ${description}`)
}

function pg(sql) {
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`psql verification failed: ${result.stderr}`)
  return result.stdout.trim()
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`
}

const sessionResult = await api("/api/session", "POST", { title: "session-agent-permissions-v2" })
check(sessionResult.status === 200 && sessionResult.data?.data?.id, "create permission test Session")
const sessionID = sessionResult.data.data.id
const otherSessionResult = await api("/api/session", "POST", { title: "session-agent-permissions-v2-other" })
check(otherSessionResult.status === 200 && otherSessionResult.data?.data?.id, "create second Session for request isolation")
const otherSessionID = otherSessionResult.data.data.id
const agentID = "session/permission-probe"
let pendingRequestID

try {
  const rules = [
    { action: "read", resource: "*", effect: "deny" },
    { action: "read", resource: "public/*.md", effect: "allow" },
    { action: "write", resource: "*", effect: "deny" },
    { action: "bash", resource: "*", effect: "deny" },
    { action: "bash", resource: "git status", effect: "allow" },
    { action: "edit", resource: "*", effect: "ask" },
  ]
  const saved = await api(`/api/session/${sessionID}/agents`, "POST", {
    id: agentID,
    config: { mode: "primary", permissions: rules },
  })
  check(saved.status === 200 && saved.data?.source === "session", "save Agent permissions as V2 Rule[]")

  const sessionRules = [
    { action: "read", resource: "docs/*.md", effect: "allow" },
    { action: "write", resource: "docs/release.md", effect: "allow" },
  ]
  const updated = await api(`/api/session/${sessionID}`, "PATCH", { permissions: sessionRules })
  check(updated.status === 204, "save Session-level permissions via V2 PATCH")
  const session = await api(`/api/session/${sessionID}`)
  check(
    session.status === 200 && JSON.stringify(session.data?.data?.permissions) === JSON.stringify(sessionRules),
    "read back persisted Session permissions",
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

  check((await evaluate("read", "docs/guide.md")) === "allow", "Session rule takes precedence over Agent deny")
  check((await evaluate("read", "public/guide.md")) === "allow", "last matching Agent rule wins")
  check((await evaluate("read", "private/secret.md")) === "deny", "unmatched allowlist path remains denied")
  check((await evaluate("write", "docs/release.md")) === "allow", "Session allow overrides Agent write deny")
  check((await evaluate("write", "secrets.txt")) === "deny", "Agent write deny applies outside Session allow")
  check((await evaluate("bash", "git status")) === "allow", "bash command allowlist matches exact command")
  check((await evaluate("bash", "rm -rf /workspace")) === "deny", "unlisted bash command is denied")

  const asked = await api(`/api/session/${sessionID}/permission`, "POST", {
    action: "edit",
    resources: ["docs/approval.md"],
    agent: agentID,
  })
  check(asked.status === 200 && asked.data?.data?.effect === "ask", "ask rule creates a pending permission request")
  pendingRequestID = asked.data.data.id
  const pending = await api(`/api/session/${sessionID}/permission`)
  check(
    pending.status === 200 && pending.data?.data?.some((item) => item.id === pendingRequestID),
    "list exposes the pending request for its Session",
  )
  check(
    (await api(`/api/session/${otherSessionID}/permission/${pendingRequestID}`)).status === 404,
    "another Session cannot read the pending request",
  )
  check(
    (await api(`/api/session/${otherSessionID}/permission/${pendingRequestID}/reply`, "POST", { decision: "once" })).status === 404,
    "another Session cannot resolve the pending request",
  )
  const details = await api(`/api/session/${sessionID}/permission/${pendingRequestID}`)
  check(details.status === 200 && details.data?.data?.resources?.[0] === "docs/approval.md", "get pending request details")
  const replied = await api(`/api/session/${sessionID}/permission/${pendingRequestID}/reply`, "POST", { decision: "once" })
  check(replied.status === 204, "reply once resolves the pending permission request")
  pendingRequestID = undefined
  check((await api(`/api/session/${sessionID}/permission`)).data?.data?.length === 0, "resolved request is removed from pending list")

  if (PG_URL) {
    const storedAgentRules = pg(
      `SELECT jsonb_array_length(config::jsonb->'permissions') FROM session_agents WHERE session_id=${quote(sessionID)} AND agent_id=${quote(agentID)}`,
    )
    check(storedAgentRules === String(rules.length), "Agent permission rules are persisted in PostgreSQL")
    const storedSessionRules = pg(
      `SELECT jsonb_array_length(permission::jsonb) FROM session_v2 WHERE id=${quote(sessionID)}`,
    )
    check(storedSessionRules === String(sessionRules.length), "Session permission rules are persisted in PostgreSQL")
  }
} finally {
  if (pendingRequestID) {
    await api(`/api/session/${sessionID}/permission/${pendingRequestID}/reply`, "POST", { decision: "reject" })
  }
  await api(`/api/session/${otherSessionID}`, "DELETE")
  await api(`/api/session/${sessionID}`, "DELETE")
  if (PG_URL) {
    const left = pg(`SELECT COUNT(*) FROM session_agents WHERE session_id=${quote(sessionID)}`)
    check(left === "0", "Session deletion cascades permission-bearing Agent rows")
  }
}
