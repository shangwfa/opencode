// V2 HITL/Form API E2E: HTTP contract, question tool round-trip, SSE, PG messages,
// permission approval, and process-local pending-state behavior after restart.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"

const BASE = (process.env.BASE ?? "http://localhost:14096").replace(/\/$/, "")
const PASSWORD = process.env.OPENCODE_PASSWORD
const PG_URL = process.env.PG_URL
const RESTART_CONTAINER = process.env.RESTART_CONTAINER ?? "opencode-saas-test"
if (!PASSWORD || !PG_URL) throw new Error("OPENCODE_PASSWORD and PG_URL are required (source test-env.sh 3)")
const rawModel = JSON.parse(process.env.V2_MODEL ?? process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}')
const model = { providerID: rawModel.providerID, id: rawModel.id ?? rawModel.modelID ?? rawModel.model }
const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`
const headers = { authorization: auth, "content-type": "application/json" }
const sid = `hitl-v2-${randomUUID().slice(0, 8)}`
const checks = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(ok, name, detail = "") {
  assert(ok, `${name}${detail ? `: ${detail}` : ""}`)
  checks.push(name)
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`)
}

async function api(path, method = "GET", body, extraHeaders = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...headers, ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(300_000),
  })
  const text = response.status === 204 ? "" : await response.text()
  let data
  try { data = text ? JSON.parse(text) : undefined } catch { data = text }
  return { status: response.status, data, text }
}

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
function pg(sql) {
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`)
  return result.stdout.trim()
}

async function removePriorRuns() {
  const ids = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-c",
    "SELECT id FROM session_v2 WHERE title LIKE 'hitl-question-v2-%'"], { encoding: "utf8" })
  if (ids.status !== 0) throw new Error(`cannot find prior test sessions: ${ids.stderr}`)
  for (const id of ids.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))
    await api(`/api/session/${id}`, "DELETE").catch(() => undefined)
}

async function waitFor(predicate, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await sleep(750)
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function listenSSE(sessionID) {
  const controller = new AbortController()
  const response = await fetch(`${BASE}/api/session/${sessionID}/event`, {
    headers: { authorization: auth, accept: "text/event-stream" },
    signal: controller.signal,
  })
  assert.equal(response.status, 200, `session SSE HTTP ${response.status}`)
  const events = []
  const ready = new Promise((resolve, reject) => {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    ;(async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const blocks = buffer.split(/\r?\n\r?\n/)
          buffer = blocks.pop() ?? ""
          for (const block of blocks) {
            const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim()
            if (!data || data === "[DONE]") continue
            let event
            try { event = JSON.parse(data) } catch { continue }
            events.push(event)
            const d = event.data ?? {}
            if (event.type === "session.execution.started") console.log("SSE exec ▶ started")
            else if (event.type === "session.reasoning.ended") console.log(`SSE think · ${String(d.text ?? "").slice(0, 140)}`)
            else if (event.type === "session.tool.input.started") console.log(`SSE tool ◇ ${d.name ?? "?"}`)
            else if (event.type === "session.tool.success") console.log("SSE tool ✓")
            else if (event.type === "session.tool.failed") console.log(`SSE tool ✗ ${JSON.stringify(d.error ?? "").slice(0, 160)}`)
            else if (event.type === "form.created") { console.log(`SSE form ◇ ${d.form?.id ?? ""}`); resolve() }
            else if (event.type === "form.replied") console.log(`SSE form ✓ ${d.id ?? ""}`)
            else if (event.type === "form.cancelled") console.log(`SSE form ✗ ${d.id ?? ""}`)
            else if (event.type === "session.text.ended") console.log(`SSE text · ${String(d.text ?? "").slice(0, 180)}`)
            else if (event.type === "session.execution.succeeded") console.log("SSE exec ✔ succeeded")
            else if (event.type === "session.execution.failed") console.log(`SSE exec ✗ ${JSON.stringify(d.error ?? "").slice(0, 180)}`)
            else if (event.type === "session.execution.interrupted") console.log(`SSE exec ⏸ ${d.reason ?? "?"}`)
          }
        }
        resolve()
      } catch (error) {
        if (!controller.signal.aborted) reject(error)
      }
    })()
  })
  // Wait until the subscription is established before issuing the action.
  await sleep(250)
  return { events, controller, ready }
}

let createdSession = false
let sessionID
let isolatedSessionID
try {
  await removePriorRuns()
  const created = await api("/api/session", "POST", {
    title: `hitl-question-v2-${sid}`,
    location: { directory: "/workspace" },
    model,
  })
  assert.equal(created.status, 200, created.text)
  sessionID = created.data.data.id
  createdSession = true
  check(Boolean(sessionID), "V2 session create returns session ID")

  // V2 Form resource contract: pending -> answered, validation, exactly-once settlement.
  const direct = await api(`/api/session/${sessionID}/form`, "POST", {
    title: "Form contract",
    fields: [{ key: "choice", type: "string", title: "Choice", required: true, options: [{ value: "a", label: "A" }] }],
    metadata: { test: sid },
  })
  assert.equal(direct.status, 200, direct.text)
  const formID = direct.data.data.id
  check(formID?.startsWith("frm_"), "Form create returns frm_ ID")
  const listed = await api(`/api/session/${sessionID}/form`)
  check(listed.status === 200 && listed.data.data.some((form) => form.id === formID), "pending Form is listed by Session API")
  const detail = await api(`/api/session/${sessionID}/form/${formID}`)
  check(detail.status === 200 && detail.data.data.state.status === "pending", "Form detail exposes state.status=pending")
  const invalid = await api(`/api/session/${sessionID}/form/${formID}/reply`, "POST", { answer: { choice: "not-an-option" } })
  check(invalid.status === 400, "invalid Form answer rejected", `HTTP ${invalid.status}`)
  const replied = await api(`/api/session/${sessionID}/form/${formID}/reply`, "POST", { answer: { choice: "a" } })
  check(replied.status === 204, "Form reply returns 204")
  const answered = await api(`/api/session/${sessionID}/form/${formID}`)
  check(answered.status === 200 && answered.data.data.state.status === "answered" && answered.data.data.state.answer.choice === "a", "Form answer persisted in process state")
  const duplicateReply = await api(`/api/session/${sessionID}/form/${formID}/reply`, "POST", { answer: { choice: "a" } })
  check(duplicateReply.status === 409, "settling an answered Form again conflicts", `HTTP ${duplicateReply.status}`)
  const pendingAfterAnswer = await api(`/api/session/${sessionID}/form`)
  check(!pendingAfterAnswer.data.data.some((form) => form.id === formID), "answered Form disappears from pending list")

  const multiForm = await api(`/api/session/${sessionID}/form`, "POST", {
    title: "Multi-field and partial answer",
    fields: [
      { key: "language", type: "string", title: "Language", required: true, options: [{ value: "go", label: "Go" }] },
      { key: "features", type: "multiselect", title: "Features", options: [{ value: "logs", label: "Logs" }, { value: "auth", label: "Auth" }] },
      { key: "note", type: "string", title: "Optional note" },
    ],
  })
  assert.equal(multiForm.status, 200, multiForm.text)
  const multiID = multiForm.data.data.id
  const partial = await api(`/api/session/${sessionID}/form/${multiID}/reply`, "POST", {
    answer: { language: "go", features: ["logs"], note: "" },
  })
  check(partial.status === 204, "multi-field Form accepts select, multiselect, and optional empty answer")
  const multiDetail = await api(`/api/session/${sessionID}/form/${multiID}`)
  check(multiDetail.data.data.state.answer.features[0] === "logs" && multiDetail.data.data.state.answer.note === "", "multi-field answer is returned in detail")

  const isolated = await api("/api/session", "POST", {
    title: `hitl-question-v2-isolation-${sid}`,
    location: { directory: "/workspace" },
    model,
  })
  assert.equal(isolated.status, 200, isolated.text)
  isolatedSessionID = isolated.data.data.id
  const isolatedForm = await api(`/api/session/${isolatedSessionID}/form`, "POST", {
    title: "Other Session Form", fields: [{ key: "x", type: "string", title: "X" }],
  })
  assert.equal(isolatedForm.status, 200, isolatedForm.text)
  check(!(await api(`/api/session/${sessionID}/form`)).data.data.some((item) => item.id === isolatedForm.data.data.id), "Form list is isolated by Session ID")

  const cancelForm = await api(`/api/session/${sessionID}/form`, "POST", {
    title: "Cancel contract",
    fields: [{ key: "confirm", type: "boolean", title: "Confirm" }],
  })
  assert.equal(cancelForm.status, 200, cancelForm.text)
  const cancelID = cancelForm.data.data.id
  check((await api(`/api/session/${sessionID}/form/${cancelID}`, "DELETE")).status === 204, "Form cancel returns 204")
  const cancelled = await api(`/api/session/${sessionID}/form/${cancelID}`)
  check(cancelled.data.data.state.status === "cancelled", "cancelled Form has terminal state")

  // V2 question tool uses Form; observe the session event stream before prompting and auto-answer.
  const agentID = "session/hitl-v2-harness"
  const agent = await api(`/api/session/${sessionID}/agents`, "POST", {
    id: agentID,
    config: {
      mode: "primary",
      description: "Deterministic HITL test harness",
      system: "Follow the user's instructions exactly. If asked a question, call the question tool immediately and wait for the user's answer. After receiving the answer, create exactly the requested file with the selected value. Never ask any other questions. Do not use shell to create the file.",
    },
  })
  assert.equal(agent.status, 200, agent.text)
  assert.equal((await api(`/api/session/${sessionID}/agent`, "POST", { agent: agentID })).status, 204)
  const sse = await listenSSE(sessionID)
  const promptPromise = fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "Before doing anything, ask me one question using the question tool: choose python or javascript. Wait for my answer. Then create /workspace/hitl-choice.txt containing only the answer.", metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(240_000),
  }).then(async (response) => {
    const text = await response.text()
    if (response.status !== 200) throw new Error(`prompt_stream HTTP ${response.status}: ${text.slice(0, 500)}`)
    return text
  })
  const questionForm = await waitFor(async () => {
    const response = await api(`/api/session/${sessionID}/form`)
    return response.status === 200 ? response.data.data.find((form) => form.metadata?.kind === "question") : undefined
  }, "question tool Form")
  check(questionForm.fields.length >= 1, "question tool created Form with fields", questionForm.id)
  const answer = {}
  for (const field of questionForm.fields) {
    if (field.type === "external") continue
    if (field.type === "boolean") answer[field.key] = true
    else if (field.type === "number" || field.type === "integer") answer[field.key] = field.default ?? field.minimum ?? 1
    else if (field.type === "multiselect") answer[field.key] = field.options?.length ? [field.options[0].value] : []
    else answer[field.key] = field.options?.[0]?.value ?? "python"
  }
  const questionReply = await api(`/api/session/${sessionID}/form/${questionForm.id}/reply`, "POST", { answer })
  check(questionReply.status === 204, "question Form automatically answered through V2 API")
  await promptPromise
  // The prompt stream ends on the terminal event itself; the parallel session
  // SSE stream may deliver it a tick later, so poll briefly instead of racing.
  await waitFor(() => Promise.resolve(sse.events.some((event) => event.type === "session.execution.succeeded")), "session SSE execution success", 15_000).catch((error) => console.log(`warn: ${error.message}`))
  const sessionEvents = sse.events
  sse.controller.abort()
  check(sessionEvents.some((event) => event.type === "session.tool.input.started" && event.data?.name === "question"), "session SSE observed question tool start")
  check(sessionEvents.some((event) => event.type === "form.replied"), "session SSE observed form.replied")
  check(sessionEvents.some((event) => event.type === "session.execution.succeeded"), "session SSE observed execution success")
  const messages = await api(`/api/session/${sessionID}/message?order=asc`)
  assert.equal(messages.status, 200, messages.text)
  const questionParts = (messages.data.data ?? []).flatMap((message) => message.content ?? []).filter((part) => part.type === "tool" && part.name === "question")
  check(questionParts.some((part) => /python|javascript/i.test(JSON.stringify(part))), "PG-backed Session messages contain question tool answer")
  const assistantText = (messages.data.data ?? []).filter((message) => message.type === "assistant").flatMap((message) => (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text)).join("\n")
  check(/python|javascript/i.test(assistantText), "assistant response reflects selected answer")
  const messageRows = pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(sessionID)}`)
  check(Number(messageRows) > 0, "PG persists the V2 Session message/tool tree", `session_message rows=${messageRows}`)
  const shellWatermark = pg(`SELECT coalesce(max(seq),0) FROM session_message WHERE session_id=${quote(sessionID)}`)
  const shellCommand = "cat /workspace/hitl-choice.txt"
  const shellStarted = await api(`/api/session/${sessionID}/shell`, "POST", { command: shellCommand })
  check(shellStarted.status === 204, "V2 shell API accepts artifact verification command")
  const shellResult = await waitFor(() => {
    const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-c",
      `SELECT coalesce(data::jsonb->'output'->>'output','') FROM session_message WHERE session_id=${quote(sessionID)} AND type='shell' AND seq>${shellWatermark} AND data::jsonb->>'status'='exited' ORDER BY seq DESC LIMIT 1`], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }, "shell artifact verification", 60_000)
  check(/^(python|javascript)$/i.test(shellResult.trim()), "sandbox artifact matches answer", shellResult.trim())

  // V2 permission APIs use action/resources + decision and are process-local while pending.
  const patched = await api(`/api/session/${sessionID}`, "PATCH", {
    permissions: [{ action: "bash", resource: "*", effect: "ask" }],
  })
  check([200, 204].includes(patched.status), "Session permission ask rule accepted", `HTTP ${patched.status}`)
  const requested = await api(`/api/session/${sessionID}/permission`, "POST", {
    action: "bash",
    resources: ["echo hitl-v2"],
    save: [],
    metadata: { test: sid },
  })
  check(requested.status === 200 && requested.data.data.effect === "ask", "permission evaluation yields ask")
  const permissionList = await api(`/api/session/${sessionID}/permission`)
  const permissionID = permissionList.data.data.find((item) => item.metadata?.test === sid)?.id
  check(Boolean(permissionID), "pending permission request is listed for its Session")
  const permissionReply = await api(`/api/session/${sessionID}/permission/${permissionID}/reply`, "POST", { decision: "once" })
  check(permissionReply.status === 204, "V2 permission once reply returns 204")
  const permissionAfter = await api(`/api/session/${sessionID}/permission`)
  check(!permissionAfter.data.data.some((item) => item.id === permissionID), "replied permission leaves pending list")

  // Restart contract (PG SaaS): pending Form/Permission live in the durable
  // HITL ledger; after a process restart the same requests come back and can
  // still be settled under their original IDs.
  const restartForm = await api(`/api/session/${sessionID}/form`, "POST", {
    title: "Restart pending contract",
    fields: [{ key: "answer", type: "string", title: "Answer" }],
  })
  assert.equal(restartForm.status, 200, restartForm.text)
  const restartFormID = restartForm.data.data.id
  const restartPermission = await api(`/api/session/${sessionID}/permission`, "POST", {
    action: "bash", resources: ["restart-probe"], save: [], metadata: { test: `${sid}-restart` },
  })
  assert.equal(restartPermission.data.data.effect, "ask", `restart permission expected ask, got ${JSON.stringify(restartPermission.data)}`)
  const pendingPermissionID = (await api(`/api/session/${sessionID}/permission`)).data.data.find((item) => item.metadata?.test === `${sid}-restart`)?.id
  check(Boolean(pendingPermissionID), "restart probe has pending Form and permission request")
  console.log("等待 185 秒验证 pending Form/Permission 在进程存活时不被时间清理")
  await sleep(185_000)
  check((await api(`/api/session/${sessionID}/form`)).data.data.some((form) => form.id === restartFormID), "pending Form survives 185-second wait")
  check((await api(`/api/session/${sessionID}/permission`)).data.data.some((item) => item.id === pendingPermissionID), "pending Permission survives 185-second wait")

  const restart = spawnSync("docker", ["restart", RESTART_CONTAINER], { encoding: "utf8", timeout: 120_000 })
  assert.equal(restart.status, 0, `docker restart failed: ${restart.stderr}`)
  await waitFor(async () => {
    const state = spawnSync("docker", ["inspect", "--format", "{{.State.Health.Status}}", RESTART_CONTAINER], { encoding: "utf8" })
    if (state.stdout.trim() !== "healthy") return false
    return (await api(`/api/session/${sessionID}`)).status === 200
  }, "SaaS readiness and Session after restart", 120_000)
  check(true, "isolated SaaS container restarted and became ready")
  check((await api(`/api/session/${sessionID}`)).status === 200, "Session remains durable across process restart")
  check((await api(`/api/session/${sessionID}/form`)).data.data.some((form) => form.id === restartFormID), "pending Form is restored from the HITL ledger after restart")
  const restoredForm = await api(`/api/session/${sessionID}/form/${restartFormID}`)
  check(restoredForm.status === 200 && restoredForm.data.data.state.status === "pending", "original Form ID stays pending after restart")
  const settledAfterRestart = await api(`/api/session/${sessionID}/form/${restartFormID}/reply`, "POST", { answer: { answer: "after-restart" } })
  check(settledAfterRestart.status === 204, "original Form can be settled under its original ID after restart")
  const restoredPermission = (await api(`/api/session/${sessionID}/permission`)).data.data.find((item) => item.id === pendingPermissionID)
  check(Boolean(restoredPermission), "pending permission is restored from the HITL ledger after restart")
  const permissionSettled = await api(`/api/session/${sessionID}/permission/${pendingPermissionID}/reply`, "POST", { decision: "once" })
  check(permissionSettled.status === 204, "original permission request can be settled after restart")
  check(Number(pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(sessionID)}`)) > 0, "PG Session message history remains after SaaS restart")
  console.log(`RESULT ${JSON.stringify({ pass: checks.length, fail: 0, sessionID, model, evidence: "HTTP + session SSE + PostgreSQL + isolated container restart" })}`)
} finally {
  if (createdSession) {
    if (isolatedSessionID) await api(`/api/session/${isolatedSessionID}`, "DELETE").catch(() => undefined)
    for (let attempt = 0; attempt < 10; attempt++) {
      await api(`/api/session/${sessionID}`, "DELETE").catch(() => undefined)
      if (pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(sessionID)}`) === "0") break
      await sleep(1000)
    }
    const remaining = pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(sessionID)}`)
    check(remaining === "0", "test Session and dependent records cleaned from PG", `rows=${remaining}`)
    if (isolatedSessionID) {
      const isolatedRemaining = pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(isolatedSessionID)}`)
      check(isolatedRemaining === "0", "isolation Session cleaned from PG", `rows=${isolatedRemaining}`)
    }
  }
}
