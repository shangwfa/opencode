import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://localhost:14096").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const auth = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(auth ? { authorization: `Basic ${Buffer.from(auth).toString("base64")}` } : {}),
}
const chosenModel = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}')
const model = { providerID: chosenModel.providerID, id: chosenModel.id ?? chosenModel.modelID }
const nonce = randomUUID().replaceAll("-", "").slice(0, 12)
const timeout = Number(process.env.TEAM_AGENT_TIMEOUT_MS ?? 180_000)
const sidList = []
const agents = [
  ["lead", "primary", "Act as team lead. Produce a concise work order; for summary tasks synthesize all supplied outputs."],
  ["analyst", "primary", "Analyze the request. State requirements, edge cases, and acceptance criteria. Do not implement code."],
  ["coder", "subagent", "Implement the requested Python function. Return executable code and handle division by zero."],
  ["reviewer", "subagent", "Review the supplied implementation. Return [APPROVED] if correct, otherwise [NEEDS_FIX] and actionable issues."],
]

function pg(sql) {
  if (!PG_URL) throw new Error("PG_URL is required")
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`)
  return result.stdout.trim()
}

const quote = (value) => `'${value.replaceAll("'", "''")}'`

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

function expect(result, code, context) {
  assert.equal(result.response.status, code, `${context}: ${result.text}`)
  return result.data
}

let sid
try {
  const created = expect(await api("/api/session", "POST", {
    title: `team-agent-v2-${nonce}`,
    location: { directory: "/workspace" },
    model,
  }), 200, "create Session")
  sid = created.data?.data?.id ?? created.data?.id
  assert(sid, `Session response did not include an ID: ${JSON.stringify(created.data)}`)
  sidList.push(sid)
  assert(sid, "Session ID missing")

  for (const [name, mode, system] of agents) {
    expect(await api(`/api/session/${sid}/agents`, "POST", {
      id: `session/${name}-${nonce}`,
      config: {
        mode,
        description: `${name} team role`,
        system: `${system} Respond directly in text; do not call tools.`,
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      },
    }), 200, `create ${name}`)
  }
  // Use stable role identifiers in the rest of the test.
  // Session Agent IDs are immutable fixture values, so select the nonce-qualified IDs.
  const agentID = (name) => `session/${name}-${nonce}`
  const saved = pg(`SELECT count(*) FROM session_agents WHERE session_id=${quote(sid)} AND agent_id IN (${agents.map(([name]) => quote(agentID(name))).join(",")})`)
  assert.equal(saved, "4", "expected four V2 Session Agent rows")
  const modes = pg(`SELECT count(*) FILTER (WHERE config::jsonb->>'mode'='primary') || ':' || count(*) FILTER (WHERE config::jsonb->>'mode'='subagent') FROM session_agents WHERE session_id=${quote(sid)} AND agent_id IN (${agents.map(([name]) => quote(agentID(name))).join(",")})`)
  assert.equal(modes, "2:2")
  console.log("PASS: four role Agents are configured and persisted in PostgreSQL")

  // Select each explicit V2 Session Agent before its prompt.
  const turnAs = async (id, label, text) => {
    expect(await api(`/api/session/${sid}/agent`, "POST", { agent: id }), 204, `select ${label}`)
    const response = await fetch(`${BASE}/api/session/${sid}/prompt_stream`, {
      method: "POST", headers,
      body: JSON.stringify({ text, metadata: {}, delivery: "queue" }),
      signal: AbortSignal.timeout(timeout),
    })
    if (response.status !== 200) throw new Error(`prompt_stream ${label} HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/i)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const events = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ""
      for (const block of blocks) {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
        if (!data || data === "[DONE]") continue
        try { events.push(JSON.parse(data)) } catch {}
      }
    }
    const types = events.map((event) => event.type)
    const failures = events.filter((event) => event.type === "session.tool.failed" || event.type === "session.step.failed" || event.type === "session.execution.interrupted")
    assert(
      types.includes("session.execution.succeeded"),
      `${label} lacked success event: ${types.join(",")}; failure events=${JSON.stringify(failures).slice(0, 2000)}`,
    )
    assert(!types.includes("session.execution.failed"), `${label} execution failed`)
    const messages = expect(await api(`/api/session/${sid}/message?order=asc`), 200, "read messages")
    const items = messages.data?.data ?? messages.data ?? []
    const assistant = items.filter((item) => item.type === "assistant").at(-1)
    assert(assistant, `missing assistant message for ${label}`)
    assert.equal(assistant.agent, id, `assistant message was not attributed to ${label}`)
    const textOut = (assistant.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n")
    console.log(`PASS: ${label} completed via V2 SSE (${events.length} events)`)
    return textOut
  }
  const roleTurn = (name, text) => turnAs(agentID(name), name, text)

  const request = "Design a Python function divide(a, b). State requirements, edge cases, and acceptance criteria."
  const workOrder = await roleTurn("lead", `Create a short work order for this task; do not execute it: ${request}`)
  const analysis = await roleTurn("analyst", `${request}\n\nTeam work order:\n${workOrder}`)
  assert(/验收|acceptance|边界|edge|zero|除零|divide/i.test(analysis), `analyst response omitted requirements or boundary criteria: ${analysis}`)
  const implementation = await roleTurn("coder", `Implement divide(a, b) from this specification. Return Python code and handle division by zero.\n\n${analysis}`)
  assert(/def\s+divide/.test(implementation), `coder response omitted def divide: ${implementation}`)
  assert(/zero|0|除零|ValueError|ZeroDivisionError/i.test(implementation), `coder response omitted division-by-zero handling: ${implementation}`)
  let review = await roleTurn("reviewer", `Review this implementation for correctness and zero division behavior. If correct, include [APPROVED]; otherwise [NEEDS_FIX] and concrete issues.\n\n${implementation}`)
  if (review.includes("[NEEDS_FIX]") && !review.includes("[APPROVED]")) {
    const repaired = await roleTurn("coder", `Repair this implementation based on the review, returning the complete corrected code.\n\nImplementation:\n${implementation}\n\nReview:\n${review}`)
    review = await roleTurn("reviewer", `Re-review the corrected implementation. Include [APPROVED] or [NEEDS_FIX] and explain briefly.\n\n${repaired}`)
    assert(review.includes("[APPROVED]"), `review still did not approve after repair: ${review}`)
    console.log("PASS: conditional reviewer → coder repair → reviewer loop")
  } else if (review.includes("[APPROVED]")) {
    console.log("SKIP: repair loop was not triggered because first review approved")
  } else {
    throw new Error(`reviewer returned neither [APPROVED] nor [NEEDS_FIX]: ${review}`)
  }

  const summary = await roleTurn("lead", `Summarize requirements, final implementation, and review verdict.\nAnalysis:\n${analysis}\nImplementation:\n${implementation}\nReview:\n${review}`)
  assert(summary.trim(), "lead summary is empty")
  const reused = await roleTurn("coder", "Implement a Python function multiply(a, b) returning a * b. Return the complete function.")
  assert(/def\s+multiply/.test(reused), `coder reuse response did not include multiply: ${reused}`)
  await roleTurn("lead", `Update the team delivery summary to include this additional function:\n${reused}`)

  const task = "Create a small Python function divide(a, b) that handles division by zero and state its acceptance criteria."
  const planText = await roleTurn(
    "lead",
    `Plan a dynamic team for this task. Return ONLY valid JSON (no markdown) in this exact shape: {"roles":[{"name":"shortEnglishName","description":"one sentence","mode":"primary or subagent","system":"role-specific instructions"}],"order":["role name"]}. Define 3 roles: the first is planning/analysis with mode primary, the middle implements with mode subagent, and the final reviews with mode subagent. Require the final role to include [APPROVED] or [NEEDS_FIX]. Every role must answer in text and must not use tools. Task: ${task}`,
  )
  const jsonText = planText.match(/\{[\s\S]*\}/)?.[0]
  assert(jsonText, `dynamic planner did not return JSON: ${planText}`)
  const team = JSON.parse(jsonText)
  assert(Array.isArray(team.roles) && team.roles.length === 3, "dynamic planner must define exactly three roles")
  assert(Array.isArray(team.order) && team.order.length === team.roles.length, "dynamic planner order length mismatch")
  const roleNames = team.roles.map((role) => role.name)
  assert.equal(new Set(roleNames).size, roleNames.length, "dynamic planner returned duplicate role names")
  assert(team.roles.every((role) => /^[a-z][a-z0-9-]{1,31}$/.test(role.name)), "dynamic role names must be lowercase English identifiers")
  assert(team.roles.every((role) => typeof role.description === "string" && role.description && typeof role.system === "string" && role.system))
  assert(team.roles.every((role) => role.mode === "primary" || role.mode === "subagent"), "dynamic planner returned an invalid mode")
  assert.equal(team.roles[0].mode, "primary", "dynamic first role must be primary")
  assert(team.roles.slice(1).every((role) => role.mode === "subagent"), "dynamic downstream roles must be subagents")
  assert.deepEqual([...team.order].sort(), [...roleNames].sort(), "dynamic order must include each role exactly once")
  console.log(`PASS: dynamic planner produced a valid ${team.roles.length}-role JSON plan`)

  const dynamicID = new Map()
  for (const role of team.roles) {
    const id = `session/dynamic-${role.name}-${nonce}`
    dynamicID.set(role.name, id)
    expect(await api(`/api/session/${sid}/agents`, "POST", {
      id,
      config: {
        mode: role.mode,
        description: role.description,
        system: `${role.system} Answer directly in text; do not call tools.`,
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      },
    }), 200, `create dynamic role ${role.name}`)
  }
  const dynamicIDs = [...dynamicID.values()]
  const dynamicRows = pg(`SELECT count(*) FROM session_agents WHERE session_id=${quote(sid)} AND agent_id IN (${dynamicIDs.map(quote).join(",")})`)
  assert.equal(dynamicRows, String(team.roles.length), "dynamic Agent definitions were not all persisted")
  console.log("PASS: dynamically planned roles were created through V2 API and persisted in PostgreSQL")

  const output = new Map()
  for (const [index, name] of team.order.entries()) {
    const role = team.roles.find((item) => item.name === name)
    const context = index === 0
      ? `User task: ${task}\nPerform your planning/analysis role and return your findings.`
      : `User task: ${task}\nUpstream team output:\n${team.order.slice(0, index).map((prev) => `## ${prev}\n${output.get(prev)}`).join("\n\n")}\nPerform your ${role.description} role. Return your concrete result.`
    output.set(name, await turnAs(dynamicID.get(name), `dynamic ${name}`, context))
    assert(output.get(name).trim(), `dynamic role ${name} returned empty output`)
  }
  const finalRole = team.order.at(-1)
  assert(/\[APPROVED\]|\[NEEDS_FIX\]/.test(output.get(finalRole)), "dynamic final reviewer omitted its quality-gate verdict")
  const dynamicSummary = await turnAs(
    dynamicID.get(team.order[0]),
    `dynamic ${team.order[0]} summary`,
    `Summarize the dynamic team results for this task, including the review verdict.\n${team.order.map((name) => `## ${name}\n${output.get(name)}`).join("\n\n")}`,
  )
  assert(dynamicSummary.trim(), "dynamic team summary was empty")
  const dynamicMessages = pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(sid)} AND type='assistant' AND data::jsonb->>'agent' IN (${dynamicIDs.map(quote).join(",")})`)
  assert(Number(dynamicMessages) >= team.roles.length + 1, "dynamic role turns/summary were not persisted in PostgreSQL")
  console.log(`PASS: dynamic dependency order and summary persisted (${dynamicMessages} assistant messages)`)

  const rows = pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(sid)} AND type='assistant'`)
  assert(Number(rows) >= 7 + team.roles.length + 1, `expected static plus dynamic assistant messages, found ${rows}`)
  console.log(`PASS: V2 session_message contains ${rows} assistant turn records`)
} finally {
  if (sid) await api(`/api/session/${sid}`, "DELETE")
}

if (sidList.length) {
  const ids = sidList.map(quote).join(",")
  assert.equal(pg(`SELECT count(*) FROM session_v2 WHERE id IN (${ids})`), "0", "test Session remained after cleanup")
  assert.equal(pg(`SELECT count(*) FROM session_agents WHERE session_id IN (${ids})`), "0", "test Agent rows remained after cleanup")
  console.log("PASS: Session and Agent fixtures were removed from PostgreSQL")
}
