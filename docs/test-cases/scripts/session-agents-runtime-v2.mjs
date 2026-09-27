import assert from "node:assert/strict"

const BASE = (process.env.BASE ?? "http://localhost:14096").replace(/\/$/, "")
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const rawModel = process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'
const parsedModel = JSON.parse(rawModel)
const MODEL = { providerID: parsedModel.providerID, id: parsedModel.id ?? parsedModel.modelID }
const timeout = Number(process.env.SESSION_AGENT_TIMEOUT_MS ?? 120_000)

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

let sessionID
try {
  const created = await api("/api/session", "POST", {
    title: "session-agent-runtime-v2",
    location: { directory: "/workspace" },
    model: MODEL,
  })
  assert.equal(created.response.status, 200, created.text)
  sessionID = created.data.data.id

  const agentID = "session/marker"
  const saved = await api(`/api/session/${sessionID}/agents`, "POST", {
    id: agentID,
    config: {
      description: "Deterministic Session Agent runtime test",
      mode: "primary",
      system: "For every user request, reply with exactly SESSION_AGENT_RUNTIME_OK and nothing else.",
    },
  })
  assert.equal(saved.response.status, 200, saved.text)

  const switched = await api(`/api/session/${sessionID}/agent`, "POST", { agent: agentID })
  assert.equal(switched.response.status, 204, switched.text)

  const streamed = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "Reply now.", metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(timeout),
  })
  if (streamed.status !== 200)
    throw new Error(`prompt_stream HTTP ${streamed.status}: ${(await streamed.text()).slice(0, 500)}`)
  assert.match(streamed.headers.get("content-type") ?? "", /text\/event-stream/i)

  const events = []
  const reader = streamed.body.getReader()
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
  const types = events.map((event) => event.type)
  assert(types.includes("session.execution.succeeded"), `missing success event; received: ${types.join(", ")}`)
  assert(!types.includes("session.execution.failed"), "prompt execution failed")

  const messages = await api(`/api/session/${sessionID}/message?order=asc`)
  assert.equal(messages.response.status, 200, messages.text)
  const assistantText = (messages.data.data ?? [])
    .filter((message) => message.type === "assistant")
    .flatMap((message) => (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text))
    .join("\n")
  assert.match(assistantText, /SESSION_AGENT_RUNTIME_OK/, "assistant output did not reflect Session Agent system prompt")

  const fork = await api(`/api/session/${sessionID}/fork`, "POST", {})
  assert.equal(fork.response.status, 200, fork.text)
  const forkID = fork.data.data.id
  try {
    const forkAgents = await api(`/api/session/${forkID}/agents`)
    assert.equal(forkAgents.response.status, 200, forkAgents.text)
    assert(
      !(forkAgents.data.data ?? []).some((item) => item.agent.id === agentID && item.source === "session"),
      "fork inherited a Session Agent override",
    )
  } finally {
    await api(`/api/session/${forkID}`, "DELETE")
  }
  console.log(`PASS: primary Agent output and fork isolation verified; ${events.length} SSE events; model=${MODEL.providerID}/${MODEL.id}`)
} finally {
  if (sessionID) await api(`/api/session/${sessionID}`, "DELETE")
}
