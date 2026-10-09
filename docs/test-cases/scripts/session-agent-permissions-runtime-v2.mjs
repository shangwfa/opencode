import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"

const BASE = (process.env.BASE ?? "http://localhost:14096").replace(/\/$/, "")
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const rawModel = process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'
const parsedModel = JSON.parse(rawModel)
const MODEL = { providerID: parsedModel.providerID, id: parsedModel.id ?? parsedModel.modelID }
const nonce = randomUUID().replaceAll("-", "").slice(0, 12)
const timeout = Number(process.env.PERMISSION_E2E_TIMEOUT_MS ?? 120_000)
const PG_URL = process.env.PG_URL
const failures = []
const sessions = []
const pending = []
const savedIDs = []
const eventWatchers = []

function brief(value, limit = 140) {
  return String(value ?? "").replace(/\s+/g, " ").slice(0, limit)
}

function presentEvent(event, sessionID) {
  const data = event.data ?? event.properties ?? {}
  const prefix = `[SSE ${sessionID}]`
  switch (event.type) {
    case "session.execution.started": console.log(`${prefix} exec ▶ 执行开始`); break
    case "session.reasoning.ended": console.log(`${prefix} think · ${brief(data.text)}`); break
    case "session.tool.input.started": console.log(`${prefix} tool ◇ ${data.name ?? "?"}`); break
    case "session.tool.success": console.log(`${prefix} tool ✓ ${brief((data.content ?? []).filter?.((item) => item.type === "text").map((item) => item.text).join(" "))}`); break
    case "session.tool.failed":
    case "session.tool.error": console.log(`${prefix} tool ✗ ${brief(data.error?.message ?? data.error)}`); break
    case "form.created": console.log(`${prefix} form ◇ ${data.id ?? ""}`); break
    case "form.replied": console.log(`${prefix} form ✓ ${data.id ?? ""}`); break
    case "form.cancelled": console.log(`${prefix} form ✗ ${data.id ?? ""}`); break
    case "session.text.ended": console.log(`${prefix} text · ${brief(data.text)}`); break
    case "session.execution.succeeded": console.log(`${prefix} exec ✔ 执行成功`); break
    case "session.execution.failed": console.log(`${prefix} exec ✗ ${brief(data.error?.message)}`); break
    case "session.execution.interrupted": console.log(`${prefix} exec ⏸ (${data.reason ?? "?"})`); break
  }
}

function watchSession(sessionID) {
  const controller = new AbortController()
  const task = (async () => {
    const response = await fetch(`${BASE}/api/session/${sessionID}/event`, {
      headers: { ...headers, accept: "text/event-stream" },
      signal: controller.signal,
    })
    if (response.status !== 200) throw new Error(`SSE HTTP ${response.status} for ${sessionID}`)
    console.log(`[SSE ${sessionID}] 已订阅 GET /api/session/${sessionID}/event`)
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
        const raw = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
        if (!raw || raw === "[DONE]") continue
        try { presentEvent(JSON.parse(raw), sessionID) } catch {}
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) console.error(`[SSE ${sessionID}] watcher failed: ${String(error)}`)
  })
  eventWatchers.push({ controller, task })
}

async function autoAnswerForms(sessionID, stopped) {
  const failedReplies = new Map()
  while (!stopped()) {
    try {
      const list = await api(`/api/session/${sessionID}/form`)
      for (const form of list.data?.data ?? []) {
        if (form.metadata?.kind !== "question") continue
        const answer = {}
        for (const field of form.fields ?? []) {
          if (field.type === "external") continue
          if (field.type === "boolean") answer[field.key] = field.default ?? true
          else if (field.type === "number" || field.type === "integer") answer[field.key] = field.default ?? field.minimum ?? 1
          else if (field.type === "multiselect") answer[field.key] = [field.options?.[0]?.value ?? field.default?.[0]].filter(Boolean)
          else answer[field.key] = field.options?.[0]?.value ?? field.default ?? "由验收器代答：请按推荐方案继续"
        }
        if ((failedReplies.get(form.id) ?? 0) >= 2) continue
        const replied = await api(`/api/session/${sessionID}/form/${form.id}/reply`, "POST", { answer })
        if (replied.status === 400) failedReplies.set(form.id, (failedReplies.get(form.id) ?? 0) + 1)
        else if (replied.response.ok) console.log(`[SSE ${sessionID}] form ✓ 自动代答 ${form.id}`)
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
}

async function consumePrompt(response, sessionID) {
  if (response.status !== 200) throw new Error(`prompt_stream HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
  let stopped = false
  const answers = autoAnswerForms(sessionID, () => stopped)
  try {
    return await readEvents(response)
  } finally {
    stopped = true
    await answers
  }
}

function pg(sql) {
  if (!PG_URL) throw new Error("PG_URL is required for runtime permission E2E PostgreSQL assertions")
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`psql verification failed: ${result.stderr}`)
  return result.stdout.trim()
}

function sqlQuote(value) {
  return `'${value.replaceAll("'", "''")}'`
}

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

function runCase(label, operation) {
  return operation()
    .then((detail) => console.log(`PASS: ${label}${detail ? ` — ${detail}` : ""}`))
    .catch((error) => {
      failures.push({ label, error })
      console.error(`FAIL: ${label}: ${String(error)}`)
    })
}

function expectStatus(result, status, label) {
  assert.equal(result.response.status, status, `${label}: ${result.text}`)
  return result.data
}

async function newSession(title) {
  const created = await api("/api/session", "POST", {
    title,
    location: { directory: "/workspace" },
    model: MODEL,
  })
  expectStatus(created, 200, "create runtime permission Session")
  const sessionID = created.data.data.id
  sessions.push(sessionID)
  watchSession(sessionID)
  return sessionID
}

async function createAgent(sessionID, id, system, permissions) {
  const result = await api(`/api/session/${sessionID}/agents`, "POST", {
    id,
    config: { mode: "primary", system, permissions },
  })
  expectStatus(result, 200, `create ${id}`)
  const switched = await api(`/api/session/${sessionID}/agent`, "POST", { agent: id })
  expectStatus(switched, 204, `switch ${id}`)
}

async function runShell(sessionID, command) {
  const started = await api(`/api/session/${sessionID}/shell`, "POST", { command })
  expectStatus(started, 204, "start shell verification")
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const list = await api(`/api/session/${sessionID}/message?order=asc`)
    const shell = (list.data?.data ?? []).filter((item) => item.type === "shell" && item.command === command).at(-1)
    if (shell && shell.status !== "running") {
      assert.equal(shell.status, "exited", shell.output?.output)
      assert.equal(shell.exit, 0, shell.output?.output)
      return shell.output?.output ?? ""
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`shell verification timeout: ${command}`)
}

async function fixture(sessionID) {
  const fileName = `permissions-canary-${nonce}.txt`
  // Generate content in the sandbox so the fixture secret is absent from Session history.
  await runShell(sessionID, `head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \\n' > '/workspace/${fileName}'`)
  const response = await fetch(`${BASE}/api/session/${sessionID}/fs/read/${encodeURIComponent(fileName)}`, {
    headers,
    signal: AbortSignal.timeout(timeout),
  })
  assert.equal(response.status, 200, `read canary fixture HTTP ${response.status}`)
  const value = new TextDecoder().decode(await response.arrayBuffer()).trim()
  assert.match(value, /^[0-9a-f]{48}$/, `unexpected canary file content: ${value}`)
  return { fileName, value }
}

async function prompt(sessionID, text) {
  const response = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(timeout),
  })
  if (response.status !== 200) throw new Error(`prompt_stream HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
  const events = await consumePrompt(response, sessionID)
  const messages = await api(`/api/session/${sessionID}/message?order=asc`)
  expectStatus(messages, 200, "read Session messages")
  const history = messages.data?.data ?? []
  const lastUser = history.findLastIndex((message) => message.type === "user")
  const transcript = history
    .slice(lastUser + 1)
    .filter((message) => message.type === "assistant")
    .flatMap((message) => (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text))
    .join("\n")
  return { events, transcript }
}

async function readEvents(response) {
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/i)
  const events = []
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
        events.push(JSON.parse(data))
      } catch {}
    }
  }
  return events
}

function toolIDs(events, name) {
  return new Set(
    events
      .filter((event) => event.type === "session.tool.input.started")
      .filter((event) => (event.properties ?? event.data ?? {}).name === name)
      .map((event) => (event.properties ?? event.data ?? {}).id),
  )
}

function toolSucceeded(events, name) {
  const ids = toolIDs(events, name)
  return events.some((event) => event.type === "session.tool.success" && ids.has((event.properties ?? event.data ?? {}).id))
}

function toolFailed(events, name) {
  const ids = toolIDs(events, name)
  return events.some((event) => ["session.tool.error", "session.tool.failed"].includes(event.type) && ids.has((event.properties ?? event.data ?? {}).id))
}

async function waitForPermission(sessionID, action, resource, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await api(`/api/session/${sessionID}/permission`)
    expectStatus(list, 200, "poll pending permission requests")
    const request = (list.data?.data ?? []).find(
      (item) => item.action === action && item.resources?.includes(resource),
    )
    if (request) return request
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`timed out waiting for ${action} permission request on ${resource}`)
}

async function evaluate(sessionID, agent, action, resource) {
  const result = await api(`/api/session/${sessionID}/permission`, "POST", {
    action,
    resources: [resource],
    agent,
  })
  expectStatus(result, 200, `evaluate ${action} ${resource}`)
  return result.data.data
}

try {
  await runCase("tool filtering hides denied tools from a real model request", async () => {
    const sessionID = await newSession("permission tool filtering")
    const { fileName, value } = await fixture(sessionID)
    const agent = `session/no-tools-${nonce}`
    await createAgent(sessionID, agent, "You do not have permission to access files. Do not guess file contents; reply ACCESS_BLOCKED.", [
      { action: "*", resource: "*", effect: "deny" },
    ])
    const result = await prompt(sessionID, `Read ${fileName} and tell me its exact contents.`)
    assert(!result.events.some((event) => event.type === "session.tool.input.started"), "a tool was offered/called despite catch-all deny")
    assert(!result.transcript.includes(value), "denied tool result leaked the canary into assistant transcript")
  })

  await runCase("path-specific read deny blocks sandbox file access", async () => {
    const sessionID = await newSession("permission path deny")
    const { fileName, value } = await fixture(sessionID)
    const agent = `session/path-deny-${nonce}`
    await createAgent(sessionID, agent, "Use the read tool on the requested path. Do not use another tool or guess its contents.", [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "read", resource: fileName, effect: "deny" },
    ])
    assert.equal((await evaluate(sessionID, agent, "read", fileName)).effect, "deny")
    const result = await prompt(sessionID, `Read ${fileName} and return the exact contents.`)
    assert(toolIDs(result.events, "read").size > 0, "read tool was not exposed/called; resource-level enforcement was not exercised")
    assert(!result.transcript.includes(value), "sandbox read returned content explicitly denied by Agent permissions")
    assert(toolFailed(result.events, "read"), "denied sandbox read did not emit a tool error")
  })

  await runCase("allowed sandbox read executes and returns the canary", async () => {
    const sessionID = await newSession("permission path allow")
    const { fileName, value } = await fixture(sessionID)
    const agent = `session/read-allow-${nonce}`
    await createAgent(sessionID, agent, "Use the read tool for the requested path and return its exact contents.", [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
    ])
    const result = await prompt(sessionID, `Read ${fileName} and return its exact contents.`)
    assert(toolSucceeded(result.events, "read"), "read tool did not succeed")
    assert(result.transcript.includes(value), "assistant response did not include the allowed canary")
  })

  await runCase("always approval persists, allows a later request, and reaches the sandbox write", async () => {
    const sessionID = await newSession("permission always")
    const agent = `session/always-${nonce}`
    const outputFile = `permission-always-${nonce}.txt`
    const output = `ALWAYS_APPROVED_${nonce}`
    await createAgent(sessionID, agent, "Use the write tool to create exactly the file and content requested.", [
      { action: "*", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "ask" },
    ])
    const asked = await api(`/api/session/${sessionID}/permission`, "POST", {
      action: "edit",
      resources: [outputFile],
      save: [outputFile],
      agent,
    })
    expectStatus(asked, 200, "create always approval request")
    assert.equal(asked.data.data.effect, "ask")
    const requestID = asked.data.data.id
    const replied = await api(`/api/session/${sessionID}/permission/${requestID}/reply`, "POST", { decision: "always" })
    expectStatus(replied, 204, "reply always")

    const saved = await api("/api/permission/saved")
    expectStatus(saved, 200, "list saved permissions")
    const item = saved.data.data.find((entry) => entry.action === "edit" && entry.resource === outputFile)
    assert(item, "always did not persist the requested action/resource")
    savedIDs.push(item.id)
    assert.equal(
      pg(`SELECT id || '|' || action || '|' || resource FROM permission WHERE id = ${sqlQuote(item.id)}`),
      `${item.id}|edit|${outputFile}`,
      "always approval row in PostgreSQL differs from the API result",
    )
    assert.equal((await evaluate(sessionID, agent, "edit", outputFile)).effect, "allow")
    assert.equal((await evaluate(sessionID, agent, "edit", `elsewhere-${nonce}.txt`)).effect, "ask")

    const result = await prompt(sessionID, `Create ${outputFile} containing exactly ${output}.`)
    assert(toolSucceeded(result.events, "write"), "saved approval did not allow write")
    assert.equal((await runShell(sessionID, `cat '/workspace/${outputFile}'`)).trim(), output, "saved-approval write side effect differs")

    const removed = await api(`/api/permission/saved/${item.id}`, "DELETE")
    expectStatus(removed, 204, "remove temporary saved permission")
    assert.equal(pg(`SELECT count(*) FROM permission WHERE id = ${sqlQuote(item.id)}`), "0", "saved permission row remained in PostgreSQL after deletion")
    savedIDs.splice(savedIDs.indexOf(item.id), 1)
  })

  await runCase("once approval resumes the real write without persisting a saved rule", async () => {
    const sessionID = await newSession("permission once execution")
    const agent = `session/once-${nonce}`
    const outputFile = `permission-once-${nonce}.txt`
    const output = `ONCE_APPROVED_${nonce}`
    await createAgent(sessionID, agent, "Use the write tool to create exactly the requested file and content.", [
      { action: "edit", resource: "*", effect: "ask" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "execute", resource: "*", effect: "deny" },
    ])

    const responsePromise = fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: `Create ${outputFile} containing exactly ${output}.`, metadata: {}, delivery: "queue" }),
      signal: AbortSignal.timeout(timeout),
    })
    const response = await responsePromise
    const eventsPromise = consumePrompt(response, sessionID)
    const request = await waitForPermission(sessionID, "edit", outputFile)
    pending.push({ sessionID, requestID: request.id })
    const replied = await api(`/api/session/${sessionID}/permission/${request.id}/reply`, "POST", { decision: "once" })
    expectStatus(replied, 204, "reply once to the real write request")
    pending.splice(pending.findIndex((item) => item.requestID === request.id), 1)

    const events = await eventsPromise
    assert(toolSucceeded(events, "write"), "once approval did not resume and complete the real write tool")
    assert.equal((await runShell(sessionID, `cat '/workspace/${outputFile}'`)).trim(), output)
    assert.equal(
      pg(`SELECT count(*) FROM permission WHERE project_id = (SELECT project_id FROM session_v2 WHERE id = ${sqlQuote(sessionID)}) AND action = 'edit' AND resource = ${sqlQuote(outputFile)}`),
      "0",
      "once approval unexpectedly persisted a saved permission",
    )
  })

  await runCase("reject with feedback recovers without writing the protected file", async () => {
    const sessionID = await newSession("permission reject recovery")
    const agent = `session/reject-${nonce}`
    const outputFile = `permission-rejected-${nonce}.txt`
    await createAgent(sessionID, agent, "Use the write tool once. If rejected, do not retry; explain that the file was not changed.", [
      { action: "edit", resource: "*", effect: "ask" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "execute", resource: "*", effect: "deny" },
    ])
    const responsePromise = fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: `Write BLOCKED to ${outputFile}.`, metadata: {}, delivery: "queue" }),
      signal: AbortSignal.timeout(timeout),
    })
    const response = await responsePromise
    const eventsPromise = consumePrompt(response, sessionID)
    const request = await waitForPermission(sessionID, "edit", outputFile)
    pending.push({ sessionID, requestID: request.id })
    const replied = await api(`/api/session/${sessionID}/permission/${request.id}/reply`, "POST", {
      decision: "reject",
      message: "The write is denied. Do not retry; explain that the file was not changed.",
    })
    expectStatus(replied, 204, "reject permission with feedback")
    pending.splice(pending.findIndex((item) => item.requestID === request.id), 1)
    const events = await eventsPromise
    assert(events.some((event) => event.type === "session.execution.succeeded"), "model did not recover to a successful final response")
    assert(toolFailed(events, "write"), "rejected write did not become a tool error")
    assert.equal((await runShell(sessionID, `test ! -e '/workspace/${outputFile}' && echo ABSENT`)).trim(), "ABSENT")
  })

  await runCase("external_directory policy and SaaS workspace confinement", async () => {
    const sessionID = await newSession("permission external directory")
    const agent = `session/external-${nonce}`
    await createAgent(sessionID, agent, "Use the write tool on the exact path requested. Report the actual tool result.", [
      { action: "external_directory", resource: "*", effect: "deny" },
      { action: "external_directory", resource: `/tmp/permission-e2e-${nonce}*`, effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "execute", resource: "*", effect: "deny" },
    ])
    assert.equal((await evaluate(sessionID, agent, "external_directory", `/tmp/permission-e2e-${nonce}.txt`)).effect, "allow")
    assert.equal((await evaluate(sessionID, agent, "external_directory", "/etc/passwd")).effect, "deny")
    const outside = `/tmp/permission-e2e-${nonce}.txt`
    const result = await prompt(sessionID, `Use write to create ${outside} containing OUTSIDE.`)
    assert(toolFailed(result.events, "write"), "sandbox path escape did not fail")
    assert(result.events.some((event) => (event.properties ?? event.data ?? {}).error?.message?.includes("Path escapes the location")), "path failure was not the expected workspace containment error")
    assert.equal((await runShell(sessionID, `test ! -e '${outside}' && echo ABSENT`)).trim(), "ABSENT")
    await runShell(sessionID, "test -d /workspace && echo WORKSPACE_OK")
  })

  await runCase("home-relative Agent permission resources expand to the configured home path", async () => {
    const sessionID = await newSession("permission home expansion")
    const agent = `session/home-${nonce}`
    const suffix = `permission-home-${nonce}`
    await createAgent(sessionID, agent, "For write requests, use the write tool on the exact requested path and report its actual result.", [
      { action: "read", resource: `~/${suffix}/*`, effect: "allow" },
      { action: "external_directory", resource: `$HOME/${suffix}/*`, effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
    ])
    const listed = await api(`/api/session/${sessionID}/agents`)
    expectStatus(listed, 200, "read effective Session Agents")
    const effective = listed.data.data.find((item) => item.agent.id === agent)?.agent
    assert(effective, "home-path Session Agent is absent from effective list")
    const readRule = effective.permissions.find((rule) => rule.action === "read" && rule.resource.includes(suffix))
    const externalRule = effective.permissions.find((rule) => rule.action === "external_directory" && rule.resource.includes(suffix))
    assert(readRule?.resource.startsWith("/"), `tilde resource did not expand to an absolute home path: ${readRule?.resource}`)
    assert(externalRule?.resource.startsWith("/"), `HOME resource did not expand to an absolute home path: ${externalRule?.resource}`)
    assert(!readRule.resource.startsWith("~/") && !externalRule.resource.startsWith("$HOME/"))
    assert.equal((await evaluate(sessionID, agent, "read", `${readRule.resource.slice(0, -1)}canary.txt`)).effect, "allow")
    assert.equal((await evaluate(sessionID, agent, "external_directory", `${externalRule.resource.slice(0, -1)}canary.txt`)).effect, "allow")
    const homeTarget = `${externalRule.resource.slice(0, -1)}sandbox-boundary.txt`
    const attempted = await prompt(sessionID, `Use write to create ${homeTarget} containing HOME_BOUNDARY.`)
    assert(toolFailed(attempted.events, "write"), "Sandbox accepted a write outside /workspace under the expanded HOME path")
    assert(
      attempted.events.some((event) => (event.properties ?? event.data ?? {}).error?.message?.includes("Path escapes the location")),
      "expanded HOME path did not fail at the SaaS workspace boundary",
    )
    const stored = JSON.parse(pg(`SELECT config FROM session_agents WHERE session_id = ${sqlQuote(sessionID)} AND agent_id = ${sqlQuote(agent)}`))
    assert.equal(stored.permissions[0].resource, `~/${suffix}/*`, "PostgreSQL should retain the portable configured resource")
    assert.equal(stored.permissions[1].resource, `$HOME/${suffix}/*`, "PostgreSQL should retain the portable configured resource")
  })

  await runCase("reserved-looking Agent IDs round-trip through the current V2 API and PostgreSQL", async () => {
    const sessionID = await newSession("permission agent identifier compatibility")
    const ids = ["title", "compaction", "summary"]
    for (const id of ids) {
      const created = await api(`/api/session/${sessionID}/agents`, "POST", {
        id,
        config: { mode: "primary", system: `Session override probe for ${id}.`, permissions: [] },
      })
      expectStatus(created, 200, `create Agent ID ${id}`)
    }
    const listed = await api(`/api/session/${sessionID}/agents`)
    expectStatus(listed, 200, "list reserved-looking Session Agents")
    for (const id of ids) {
      const item = listed.data.data.find((entry) => entry.agent.id === id)
      assert.equal(item?.source, "session", `Agent ID ${id} did not round-trip as a Session definition`)
    }
    assert.equal(
      pg(`SELECT count(*) FROM session_agents WHERE session_id = ${sqlQuote(sessionID)} AND agent_id IN (${ids.map(sqlQuote).join(",")})`),
      String(ids.length),
      "reserved-looking Agent IDs were not persisted exactly once",
    )
  })

  await runCase("subagent caller permission and child Agent read deny are enforced in a real child Session", async () => {
    const sessionID = await newSession("permission subagent policy")
    const { fileName, value } = await fixture(sessionID)
    const childAgent = `permission-reader-${nonce}`
    const agentPath = `/workspace/.opencode/agents/${childAgent}.md`
    await runShell(
      sessionID,
      `mkdir -p /workspace/.opencode/agents && cat > '${agentPath}' <<'AGENT_EOF'\n---\nmode: subagent\ndescription: permission-isolated reader\npermissions:\n  - action: read\n    resource: "*"\n    effect: deny\n  - action: "*"\n    resource: "*"\n    effect: deny\n---\nUse the read tool for requested files. If the tool is unavailable or denied, say the file cannot be read. Never guess file contents.\nAGENT_EOF`,
    )
    const refreshed = await api(`/api/session/${sessionID}/agents/refresh`, "POST")
    expectStatus(refreshed, 200, "refresh sandbox Agent registry")
    assert(refreshed.data.data.some((item) => item.agent.id === childAgent && item.source === "sandbox"), "sandbox subagent Agent was not discovered")

    const caller = `session/delegate-${nonce}`
    await createAgent(sessionID, caller, `For file-reading requests, you MUST delegate to ${childAgent} through the subagent tool. Do not call read or shell yourself.`, [
      { action: "*", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "allow" },
    ])
    assert.equal((await evaluate(sessionID, caller, "subagent", childAgent)).effect, "allow")
    const result = await prompt(sessionID, `Ask subagent ${childAgent} to read ${fileName} and return its exact content.`)
    const calls = toolIDs(result.events, "subagent")
    assert(calls.size > 0, "primary Agent did not invoke the permitted subagent tool")
    const terminal = result.events.find((event) => event.type === "session.tool.success" && calls.has((event.properties ?? event.data ?? {}).id))
    assert(terminal, "subagent call did not complete successfully")
    const childID = (terminal.properties ?? terminal.data).metadata?.sessionID
    assert(childID, "subagent tool success did not identify its child Session")
    sessions.push(childID)
    const child = await api(`/api/session/${childID}`)
    expectStatus(child, 200, "read child Session")
    assert.equal(child.data.data.parentID, sessionID)
    assert.equal(child.data.data.agent, childAgent)
    const childAgents = await api(`/api/session/${childID}/agents`)
    expectStatus(childAgents, 200, "read child effective Agents")
    const effectiveChild = childAgents.data.data.find((item) => item.agent.id === childAgent)
    assert.equal(effectiveChild?.source, "sandbox", "child Session did not resolve the sandbox Agent")
    assert.equal(effectiveChild.agent.permissions.filter((rule) => rule.action === "read").at(-1)?.effect, "deny")
    assert.equal((await evaluate(childID, childAgent, "read", fileName)).effect, "deny", "child Session did not enforce its own read policy")
    const childMessages = await api(`/api/session/${childID}/message?order=asc`)
    expectStatus(childMessages, 200, "read child messages")
    const childContent = (childMessages.data.data ?? [])
      .filter((message) => message.type === "assistant")
      .flatMap((message) => message.content ?? [])
    assert(!childContent.some((part) => part.type === "tool" && part.state.status === "completed"), "child executed a tool despite its all-tools deny")
    assert(!JSON.stringify(childContent).includes(value), "denied child read leaked the canary")
    assert(!result.transcript.includes(value), "parent received data denied to its child Agent")

    const deniedCaller = `session/delegate-denied-${nonce}`
    await createAgent(sessionID, deniedCaller, `You MUST call subagent ${childAgent} for file requests. Do not call any other tool.`, [
      { action: "*", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "subagent", resource: childAgent, effect: "deny" },
    ])
    assert.equal((await evaluate(sessionID, deniedCaller, "subagent", childAgent)).effect, "deny")
    const childrenBefore = await api(`/api/session?parentID=${encodeURIComponent(sessionID)}`)
    expectStatus(childrenBefore, 200, "list children before denied delegation")
    const denied = await prompt(sessionID, `Delegate the request to ${childAgent} to read ${fileName}.`)
    assert(toolIDs(denied.events, "subagent").size > 0, "resource-level denied subagent was hidden rather than execution-checked")
    assert(toolFailed(denied.events, "subagent"), "caller subagent deny did not fail the delegated tool call")
    const childrenAfter = await api(`/api/session?parentID=${encodeURIComponent(sessionID)}`)
    expectStatus(childrenAfter, 200, "list children after denied delegation")
    assert.deepEqual(
      (childrenAfter.data.data ?? []).map((item) => item.id).sort(),
      (childrenBefore.data.data ?? []).map((item) => item.id).sort(),
      "a denied subagent call created a child Session",
    )
  })

  await runCase("parallel background subagent calls create isolated child Sessions", async () => {
    const sessionID = await newSession("permission parallel subagents")
    const childAgent = `permission-reader-${nonce}`
    await runShell(
      sessionID,
      `mkdir -p /workspace/.opencode/agents && cat > '/workspace/.opencode/agents/${childAgent}.md' <<'AGENT_EOF'\n---\nmode: subagent\ndescription: permission-isolated background worker\npermissions:\n  - action: read\n    resource: "*"\n    effect: deny\n---\nFollow the task prompt and return its requested completion token. Never guess file contents.\nAGENT_EOF`,
    )
    const refreshed = await api(`/api/session/${sessionID}/agents/refresh`, "POST")
    expectStatus(refreshed, 200, "refresh sandbox Agent registry for parallel test")
    assert(refreshed.data.data.some((item) => item.agent.id === childAgent), "parallel sandbox Agent was not discovered")
    const caller = `session/parallel-${nonce}`
    await createAgent(sessionID, caller, `When asked for two tasks, invoke the subagent tool exactly twice with agent ${childAgent}, background=true, one call per task. Do not perform the tasks yourself.`, [
      { action: "*", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "allow" },
    ])
    const result = await prompt(sessionID, `Launch two independent background subtasks in this turn using ${childAgent}: task alpha must return ALPHA_DONE; task beta must return BETA_DONE. Start both before reporting.`)
    const calls = [...toolIDs(result.events, "subagent")]
    assert.equal(calls.length, 2, `expected two subagent tool invocations, got ${calls.length}`)
    const terminals = calls.map((id) => result.events.find((event) => event.type === "session.tool.success" && (event.properties ?? event.data ?? {}).id === id))
    assert(terminals.every(Boolean), "at least one background subagent admission failed")
    const childIDs = terminals.map((event) => (event.properties ?? event.data).metadata?.sessionID)
    assert(childIDs.every(Boolean), "a background subagent tool result omitted its Session ID")
    assert.equal(new Set(childIDs).size, 2, "parallel calls reused one child Session")
    sessions.push(...childIDs)
    const children = await Promise.all(childIDs.map(async (id) => {
      const item = await api(`/api/session/${id}`)
      expectStatus(item, 200, `read parallel child Session ${id}`)
      return item.data.data
    }))
    assert(children.every((child) => child.parentID === sessionID && child.agent === childAgent), "parallel child Session ownership/Agent mismatch")
    const waits = await Promise.all(childIDs.map((id) => api(`/api/experimental/session/${id}/wait`, "POST")))
    waits.forEach((wait, index) => expectStatus(wait, 204, `wait for parallel child ${index + 1}`))
    const histories = await Promise.all(childIDs.map((id) => api(`/api/session/${id}/message?order=asc`)))
    histories.forEach((history, index) => {
      expectStatus(history, 200, `read parallel child history ${index + 1}`)
      assert(history.data.data.some((message) => message.type === "assistant"), `parallel child ${index + 1} produced no assistant response`)
    })
  })
} finally {
  for (const watcher of eventWatchers) watcher.controller.abort()
  await Promise.allSettled(eventWatchers.map((watcher) => watcher.task))
  for (const item of pending) {
    await api(`/api/session/${item.sessionID}/permission/${item.requestID}/reply`, "POST", { decision: "reject" })
  }
  for (const id of savedIDs) await api(`/api/permission/saved/${id}`, "DELETE")
  for (const id of sessions) await api(`/api/session/${id}`, "DELETE")
}

if (failures.length) {
  console.error(`\n${failures.length} permission runtime case(s) failed.`)
  process.exitCode = 1
} else {
  console.log("\nAll remaining Session Agent permission runtime cases passed.")
}
