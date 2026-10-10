// HITL 恢复端到端验收：双 Docker SaaS + 真实模型 + 专用 PG（opencode-v2-test）。
// 场景：A pod 会话发起 question → 等待用户 → A 容器重启（进程死亡）→
// B pod 看到 pending form（跨 pod ledger）→ B 回复 → A 重启后恢复执行从答案继续 →
// 验证消息树、SSE、PG 与清理。此脚本只重启 HITL_E2E_RESTART_CONTAINER 指定的专用容器。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

const a = process.env.HITL_E2E_URL_A ?? "http://127.0.0.1:14270"
const b = process.env.HITL_E2E_URL_B ?? "http://127.0.0.1:14271"
const pgURL = process.env.PG_URL
const password = process.env.OPENCODE_PASSWORD
const restartContainer = process.env.HITL_E2E_RESTART_CONTAINER
if (!pgURL || new URL(pgURL).pathname !== "/opencode-v2-test") throw new Error("必须使用专用 opencode-v2-test")
if (!password) throw new Error("必须提供 OPENCODE_PASSWORD")
if (restartContainer !== "opencode-saas-hitl-e2e-a") throw new Error("仅允许重启专用容器 opencode-saas-hitl-e2e-a")
const rawModel = JSON.parse(process.env.V2_MODEL ?? process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}')
const model = { providerID: rawModel.providerID, id: rawModel.id ?? rawModel.modelID ?? rawModel.model }
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const headers = { authorization: auth, "content-type": "application/json" }
const runID = randomUUID()
const artifact = join(process.env.OPENCODE_TEST_ARTIFACT_DIR ?? "/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode", `hitl-recovery-e2e-${runID}`)
await mkdir(artifact, { recursive: true })
const checks = []
const events = []
const controllers = []
const streams = []
let sessionID
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const pg = (sql) => {
  const result = spawnSync("psql", [pgURL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`PG查询失败：${result.stderr}`)
  return result.stdout.trim()
}
const check = (name, condition, detail = "") => {
  assert(condition, `${name}${detail ? `: ${detail}` : ""}`)
  checks.push(name)
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`)
}
async function api(base, path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method, headers, signal: AbortSignal.timeout(300_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let data
  try { data = text ? JSON.parse(text) : undefined } catch { data = text }
  return { status: response.status, body: data }
}
async function waitFor(fn, label, timeout = 240_000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    last = await fn()
    if (last) return last
    await sleep(1_000)
  }
  throw new Error(`等待超时：${label}（last=${JSON.stringify(last)?.slice(0, 300)}）`)
}
async function subscribe(base, id, pod) {
  const controller = new AbortController()
  controllers.push(controller)
  const response = await fetch(`${base}/api/session/${id}/event`, { headers, signal: controller.signal })
  assert.equal(response.status, 200, `SSE HTTP ${response.status}`)
  const task = (async () => {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
        let split
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          const line = frame.split("\n").find((value) => value.startsWith("data: "))
          if (!line) continue
          const event = JSON.parse(line.slice(6))
          events.push({ pod, sessionID: id, event })
          const summary = JSON.stringify(event.data ?? {})
          console.log(`SSE ${pod} ${event.type} ${summary.slice(0, 180)}`)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
    } finally { reader.releaseLock() }
  })()
  task.catch(() => undefined)
  streams.push(task)
  await waitFor(async () => events.some((row) => row.pod === pod && row.sessionID === id && row.event.type === "server.connected"), "SSE就绪", 30_000)
  return controller
}
const formList = (base, id) => api(base, `/api/session/${id}/form`).then((result) => result.body?.data ?? [])

let failure
try {
  // 1. A 创建会话并订阅；发起必须澄清的任务。prompt 响应是整轮 SSE 流，
  //    这里只确认已受理（200），过程经 per-session SSE 实时观察。
  const created = await api(a, "/api/session", "POST", {
    title: `hitl-recovery-e2e-${runID.slice(0, 8)}`,
    model: { ...model },
    permissions: [{ action: "question", resource: "*", effect: "allow" }],
    location: { directory: "/workspace" },
  })
  assert.equal(created.status, 200)
  sessionID = created.body.data.id
  const streamA = await subscribe(a, sessionID, "A")
  const promptResponse = await fetch(`${a}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: `Ask me which greeting to write using the question tool (options: hello / hi), then create greeting.txt in the working directory containing exactly that word. Ask first; do not guess.`,
      metadata: {}, delivery: "queue",
    }),
    signal: AbortSignal.timeout(300_000),
  })
  assert.equal(promptResponse.status, 200, `prompt HTTP ${promptResponse.status}`)
  await promptResponse.body?.cancel()
  void streamA

  // 2. A 等待 question 表单出现（SSE + pending 列表）。
  const form = await waitFor(async () => (await formList(a, sessionID))[0], "A 出现 pending question")
  check("A 产生 question 表单", form?.id?.startsWith("frm_"), form.id)
  const toolCall = events.find((row) => row.pod === "A" && row.event.type === "session.tool.input.started" && row.event.data?.name === "question")
  check("SSE 观察到 question 工具开始", toolCall !== undefined)

  // 3. B（另一 pod）能看到同一 pending 表单（跨 pod ledger）。
  const seenOnB = await waitFor(async () => (await formList(b, sessionID))[0]?.id === form.id, "B 看到同一表单")
  check("B pod 看到同一 pending 表单", seenOnB === true)
  const ledgerCount = pg(`SELECT count(*) FROM hitl_request WHERE id = ${quote(form.id)} AND decision = 'pending'`)
  check("PG ledger 登记 pending", ledgerCount === "1")

  // 4. 订阅 B 的会话 SSE，随后硬重启 A 容器（模拟进程死亡）。
  const streamB = await subscribe(b, sessionID, "B")
  void streamB
  streamA.abort()
  const restart = spawnSync("docker", ["restart", restartContainer], { encoding: "utf8", timeout: 120_000 })
  assert.equal(restart.status, 0, restart.stderr)
  await waitFor(async () => { try { return (await api(a, "/api/info")).status === 200 } catch { return false } }, "A 容器重启就绪", 120_000)
  check("A 容器已重启", true)

  // 5. 重启后：A 恢复执行，question 不重复提问；原表单仍 pending。
  await waitFor(async () => (await formList(a, sessionID))[0]?.id === form.id, "重启后 A 恢复原表单")
  check("重启后原表单仍在 A 恢复", true)
  await subscribe(a, sessionID, "A-restarted")
  const formsAfterRestart = await formList(a, sessionID)
  check("重启后不重复提问（仅一个 pending）", formsAfterRestart.length === 1 && formsAfterRestart[0].id === form.id)

  // 6. B 回复原表单（跨 pod 回复）。
  const fieldKey = form.fields[0]?.key ?? "q0"
  const replied = await api(b, `/api/session/${sessionID}/form/${form.id}/reply`, "POST", { answer: { [fieldKey]: "hello" } })
  check("B pod 回复原表单成功", replied.status === 204)

  // 7. 恢复的轮次从答案继续并完成执行。
  await waitFor(() => events.some((row) => row.pod === "A-restarted" && row.event.type === "session.execution.succeeded"), "A 恢复执行成功", 240_000)
  check("重启后执行从答案继续并成功", true)

  // 8. 消息树：question tool part 已完成且内容含答案；ledger 已收敛。
  const messages = (await api(a, `/api/session/${sessionID}/message?order=asc`)).body.data ?? []
  const questionPart = messages.flatMap((message) => message.content ?? []).find((part) => part.type === "tool" && part.name === "question")
  check("question tool part 终态为 completed", questionPart?.state?.status === "completed", JSON.stringify(questionPart?.state?.status))
  check("答案进入工具结果", JSON.stringify(questionPart?.state?.content ?? []).includes("hello"))
  const ledgerDecision = pg(`SELECT decision FROM hitl_request WHERE id = ${quote(form.id)}`)
  check("PG ledger 决策已落库", ledgerDecision === "answered", ledgerDecision)
  const duplicate = await api(a, `/api/session/${sessionID}/form/${form.id}/reply`, "POST", { answer: { [fieldKey]: "hi" } })
  check("已决表单重复回复被拒绝", duplicate.status === 409)
} catch (error) {
  failure = error
  console.error(String(error))
} finally {
  for (const controller of controllers) controller.abort()
  const outcomes = await Promise.allSettled(streams)
  if (!failure && outcomes.some((result) => result.status === "rejected")) failure = new Error("SSE意外断线")
  if (sessionID && !failure) {
    try {
      const removed = await api(a, `/api/session/${sessionID}`, "DELETE")
      assert.equal(removed.status, 204)
    } catch (error) { failure ??= error }
  }
  try {
    if (sessionID) {
      const residual = pg(`SELECT (SELECT count(*) FROM session_v2 WHERE id = ${quote(sessionID)}) + (SELECT count(*) FROM hitl_request WHERE session_id = ${quote(sessionID)})`)
      check("本轮 Session 与 HITL 零残留", residual === "0", residual)
    }
  } catch (error) { failure ??= error }
  await writeFile(join(artifact, "events.json"), JSON.stringify(events, null, 2))
  await writeFile(join(artifact, "result.json"), JSON.stringify({ runID, sessionID, checks, status: failure ? "failed" : "passed", error: failure ? String(failure) : undefined }, null, 2))
  console.log(`证据目录：${artifact}`)
}
if (failure) process.exitCode = 1
