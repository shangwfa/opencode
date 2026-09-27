import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"

const BASE = (process.env.BASE ?? "http://localhost:14096").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const parsedModel = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}')
const model = { providerID: parsedModel.providerID, id: parsedModel.modelID ?? parsedModel.id }
const nonce = randomUUID().replaceAll("-", "").slice(0, 12)
const timeout = Number(process.env.COMPOSE_E2E_TIMEOUT_MS ?? 180_000)
const sessionIDs = []
const passed = []
let rootID
let agentPath
let artifacts = []

function check(condition, description) {
  assert(condition, description)
  passed.push(description)
  console.log(`PASS: ${description}`)
}

function pg(sql) {
  if (!PG_URL) throw new Error("PG_URL is required for Compose Agent PostgreSQL assertions")
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`psql verification failed: ${result.stderr}`)
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
  return { response, data, text }
}

function status(result, expected, label) {
  assert.equal(result.response.status, expected, `${label}: ${result.text}`)
  return result.data
}

async function runShell(sessionID, command) {
  status(await api(`/api/session/${sessionID}/shell`, "POST", { command }), 204, "start Sandbox fixture shell")
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const messages = status(await api(`/api/session/${sessionID}/message?order=asc`), 200, "read shell messages")
    const item = (messages.data ?? []).filter((message) => message.type === "shell" && message.command === command).at(-1)
    if (item && item.status !== "running") {
      assert.equal(item.status, "exited", item.output?.output)
      assert.equal(item.exit, 0, item.output?.output)
      return item.output?.output ?? ""
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Sandbox shell timed out: ${command}`)
}

async function events(response) {
  assert.equal(response.status, 200, `prompt_stream HTTP ${response.status}`)
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/i)
  const output = []
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
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
      if (!data || data === "[DONE]") continue
      try {
        output.push(JSON.parse(data))
      } catch {}
    }
  }
  return output
}

const properties = (event) => event.properties ?? event.data ?? {}
const readFile = async (sessionID, path) => {
  const response = await fetch(`${BASE}/api/session/${sessionID}/fs/read/${path.split("/").map(encodeURIComponent).join("/")}`, {
    headers,
    signal: AbortSignal.timeout(timeout),
  })
  assert.equal(response.status, 200, `read Sandbox file ${path}: HTTP ${response.status}`)
  return new TextDecoder().decode(await response.arrayBuffer())
}

try {
  const created = status(
    await api("/api/session", "POST", {
      title: `compose-agent-v2-${nonce}`,
      location: { directory: "/workspace" },
      model,
    }),
    200,
    "create Compose Session using V2 API",
  )
  rootID = created.data.id
  sessionIDs.push(rootID)
  check(Boolean(rootID), "V2 Session response contains a Session ID")

  agentPath = `/workspace/.opencode/agents/compose-implementer-${nonce}.md`
  const implementer = `---\nmode: subagent\ndescription: Compose workflow implementer\npermissions:\n  - action: edit\n    resource: "*"\n    effect: allow\n  - action: read\n    resource: "*"\n    effect: allow\n  - action: shell\n    resource: "*"\n    effect: allow\n---\nCreate exactly the file and content named in your task. Use the write tool, then report the created path. Do not modify other files.\n`
  const encoded = Buffer.from(implementer).toString("base64")
  await runShell(
    rootID,
    `mkdir -p /workspace/.opencode/agents && printf '%s' '${encoded}' | base64 -d > '${agentPath}'`,
  )
  const refreshed = status(await api(`/api/session/${rootID}/agents/refresh`, "POST"), 200, "refresh Sandbox Agent definitions")
  const implementerID = `compose-implementer-${nonce}`
  assert(refreshed.data.some((item) => item.agent.id === implementerID && item.source === "sandbox"), "Sandbox implementer Agent was not discovered")
  check(true, "Sandbox subagent fixture is discovered through the V2 Agent refresh route")

  const composeID = `session/compose-${nonce}`
  const composeConfig = {
    mode: "primary",
    description: "Compose Agent that delegates independent implementation tasks",
    system: `You are the Compose Agent. For independent file creation tasks, create one background subagent call per task using agent ${implementerID}. Do not run shell or write tools yourself. Wait for the tasks if needed and report the results.`,
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "allow" },
    ],
  }
  status(await api(`/api/session/${rootID}/agents`, "POST", { id: composeID, config: composeConfig }), 200, "create V2 Compose Agent")
  status(await api(`/api/session/${rootID}/agent`, "POST", { agent: composeID }), 204, "select V2 Compose Agent")
  const agentRows = pg(
    `SELECT agent_id || '|' || (config::jsonb->>'mode') FROM session_agents WHERE session_id=${sqlQuote(rootID)} AND agent_id=${sqlQuote(composeID)}`,
  )
  check(agentRows === `${composeID}|primary`, "Compose Agent config was persisted in PostgreSQL")

  const isolated = status(
    await api("/api/session", "POST", {
      title: `compose-agent-isolation-${nonce}`,
      location: { directory: "/workspace" },
      model,
    }),
    200,
    "create second Session for Agent isolation",
  )
  sessionIDs.push(isolated.data.id)
  const isolatedAgents = status(await api(`/api/session/${isolated.data.id}/agents`), 200, "list second Session Agents")
  assert(!isolatedAgents.data.some((item) => item.agent.id === composeID && item.source === "session"))
  assert.equal(
    pg(`SELECT count(*) FROM session_agents WHERE session_id=${sqlQuote(isolated.data.id)} AND agent_id=${sqlQuote(composeID)}`),
    "0",
  )
  check(true, "Session Agent definition and PostgreSQL row are isolated from another Session")

  const alpha = `compose-alpha-${nonce}.py`
  const beta = `compose-beta-${nonce}.py`
  artifacts = [alpha, beta]
  const prompt = await fetch(`${BASE}/api/session/${rootID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: `Launch two independent background tasks in this turn using ${implementerID}. Task A: create /workspace/${alpha} containing exactly print("alpha")\\n. Task B: create /workspace/${beta} containing exactly print("beta")\\n. Use two subagent tool calls, one per file, and do not create the files yourself.`,
      metadata: {},
      delivery: "queue",
    }),
    signal: AbortSignal.timeout(timeout),
  })
  const stream = await events(prompt)
  const calls = new Set(
    stream
      .filter((event) => event.type === "session.tool.input.started" && properties(event).name === "subagent")
      .map((event) => properties(event).id),
  )
  assert.equal(calls.size, 2, `expected two subagent tool calls, received ${calls.size}`)
  const completedCalls = [...calls].map((id) =>
    stream.find((event) => event.type === "session.tool.success" && properties(event).id === id),
  )
  assert(completedCalls.every(Boolean), "one or more background subagent admissions failed")
  const childIDs = completedCalls.map((event) => properties(event).metadata?.sessionID)
  assert(childIDs.every(Boolean), "background subagent result omitted child Session ID")
  assert.equal(new Set(childIDs).size, 2, "two independent tasks reused the same child Session")
  sessionIDs.push(...childIDs)
  check(true, "Compose Agent dispatched two independent tasks through V2 subagent calls")

  const children = await Promise.all(
    childIDs.map(async (childID) => {
      const child = status(await api(`/api/session/${childID}`), 200, "read child Session")
      assert.equal(child.data.parentID, rootID)
      assert.equal(child.data.agent, implementerID)
      return child.data
    }),
  )
  assert.equal(children.length, 2)
  for (const [index, childID] of childIDs.entries())
    status(await api(`/api/experimental/session/${childID}/wait`, "POST"), 204, `wait for child task ${index + 1}`)
  check(true, "both child Sessions are parented to the Compose Session and reach idle")

  const alphaContent = await readFile(rootID, alpha)
  const betaContent = await readFile(rootID, beta)
  assert.equal(alphaContent.trim(), 'print("alpha")')
  assert.equal(betaContent.trim(), 'print("beta")')
  check(true, "both delegated tasks created their exact files in the shared /workspace Sandbox")

  const childRows = pg(`SELECT count(*) FROM session_v2 WHERE parent_id=${sqlQuote(rootID)} AND id IN (${childIDs.map(sqlQuote).join(",")})`)
  assert.equal(childRows, "2", "PostgreSQL child Session rows are missing")
  check(true, "PostgreSQL records both child Sessions with the Compose Session as parent")

  if (process.env.COMPOSE_RESTART_CONTAINER) {
    const persistent = status(
      await api("/api/session", "POST", {
        title: `compose-agent-persistence-${nonce}`,
        location: { directory: "/workspace" },
        model,
      }),
      200,
      "create Session for service restart persistence",
    )
    const persistentID = persistent.data.id
    sessionIDs.push(persistentID)
    const persistentAgent = `session/compose-persistent-${nonce}`
    const persistentConfig = { mode: "primary", system: `PERSISTENCE_CANARY_${nonce}` }
    status(
      await api(`/api/session/${persistentID}/agents`, "POST", { id: persistentAgent, config: persistentConfig }),
      200,
      "persist Compose Agent before service restart",
    )
    assert.equal(
      pg(`SELECT count(*) FROM session_agents WHERE session_id=${sqlQuote(persistentID)} AND agent_id=${sqlQuote(persistentAgent)}`),
      "1",
    )

    const restarted = spawnSync("docker", ["restart", process.env.COMPOSE_RESTART_CONTAINER], { encoding: "utf8" })
    assert.equal(restarted.status, 0, `docker restart failed: ${restarted.stderr}`)
    const deadline = Date.now() + 90_000
    let ready = false
    while (Date.now() < deadline) {
      try {
        const health = await api("/api/info")
        if (health.response.ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    assert(ready, "SaaS API did not become ready after container restart")
    const persistedAgents = status(await api(`/api/session/${persistentID}/agents`), 200, "read Agent after service restart")
    assert(persistedAgents.data.some((item) => item.agent.id === persistentAgent && item.agent.system === persistentConfig.system))
    assert.equal(
      pg(`SELECT config::jsonb->>'system' FROM session_agents WHERE session_id=${sqlQuote(persistentID)} AND agent_id=${sqlQuote(persistentAgent)}`),
      persistentConfig.system,
    )
    check(true, "Session Agent API and PostgreSQL row survive a service container restart")
  } else {
    console.log("SKIP: service restart persistence; set COMPOSE_RESTART_CONTAINER to the disposable SaaS test container name")
  }
} finally {
  if (rootID && (artifacts.length || agentPath)) {
    try {
      const cleanup = [...artifacts, agentPath?.replace("/workspace/", "")]
        .filter(Boolean)
        .map((path) => `'${path.replaceAll("'", "'\\''")}'`)
        .join(" ")
      await runShell(rootID, `rm -f ${cleanup}`)
    } catch {}
  }
  for (const id of sessionIDs.slice(1).reverse()) await api(`/api/session/${id}`, "DELETE")
  if (rootID) await api(`/api/session/${rootID}`, "DELETE")
}

if (sessionIDs.length) {
  const ids = sessionIDs.map(sqlQuote).join(",")
  assert.equal(pg(`SELECT count(*) FROM session_v2 WHERE id IN (${ids})`), "0", "test Sessions remained in PostgreSQL after cleanup")
  assert.equal(pg(`SELECT count(*) FROM session_agents WHERE session_id IN (${ids})`), "0", "test Agent rows remained in PostgreSQL after cleanup")
  check(true, "all test Session and Agent rows were removed from PostgreSQL")
}
if (passed.length) console.log(`\n${passed.length} Compose Agent V2 assertions passed.`)
