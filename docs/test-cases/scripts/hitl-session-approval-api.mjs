// 当前 Session always：双 Docker SaaS + HTTP/SSE + 专用 PG 验收。
// 不验证 pending 跨 pod 回复或执行恢复，避免将授权持久化误计为完整 HITL HA。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

const a = process.env.HITL_APPROVAL_URL_A ?? "http://127.0.0.1:14270"
const b = process.env.HITL_APPROVAL_URL_B ?? "http://127.0.0.1:14271"
const pgURL = process.env.PG_URL
const container = process.env.HITL_APPROVAL_RESTART_CONTAINER
const password = process.env.OPENCODE_PASSWORD
if (!pgURL || new URL(pgURL).pathname !== "/opencode-v2-test") throw new Error("必须使用专用 opencode-v2-test")
if (!password) throw new Error("必须提供 OPENCODE_PASSWORD")
if (container !== "opencode-saas-hitl-approval-a")
  throw new Error("仅允许重启本套件专用容器 opencode-saas-hitl-approval-a")
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const headers = { authorization: auth, "content-type": "application/json" }
const runID = randomUUID()
const directory = join(
  process.env.OPENCODE_TEST_ARTIFACT_DIR ?? "/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode",
  `hitl-session-approval-${runID}`,
)
await mkdir(directory, { recursive: true })
const sessions = []
const checks = []
const events = []
const httpEvidence = []
const pgEvidence = []
const controllers = []
const streams = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const pg = (sql) => {
  const result = spawnSync("psql", [pgURL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`PG查询失败：${result.stderr}`)
  const value = result.stdout.trim()
  pgEvidence.push({ sql, value })
  return value
}
const check = (name, condition) => {
  assert(condition, name)
  checks.push(name)
  console.log(`PASS ${name}`)
}
async function api(base, path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(60_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const result = { status: response.status, body: text ? JSON.parse(text) : undefined }
  httpEvidence.push({ base, path, method, ...result })
  return result
}
async function waitUntil(fn, label, timeout = 90_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(250)
  }
  throw new Error(`等待超时：${label}`)
}
async function subscribe(base, sessionID, pod) {
  const controller = new AbortController()
  controllers.push(controller)
  const response = await fetch(`${base}/api/session/${sessionID}/event`, { headers, signal: controller.signal })
  assert.equal(response.status, 200)
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
          const data = frame.split("\n").find((line) => line.startsWith("data: "))
          if (!data) continue
          const event = JSON.parse(data.slice(6))
          events.push({ pod, sessionID, event })
          console.log(`SSE ${pod} ${sessionID} ${event.type} ${JSON.stringify(event.data ?? {})}`)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
    } finally {
      reader.releaseLock()
    }
  })()
  // 即时注册拒绝处理；验收末尾仍通过settled结果判断意外断线。
  task.catch(() => undefined)
  streams.push(task)
  await waitUntil(
    () => events.some((row) => row.pod === pod && row.sessionID === sessionID && row.event.type === "server.connected"),
    "SSE就绪",
  )
  return controller
}
async function create(base, suffix, extra = {}) {
  const result = await api(base, "/api/session", "POST", {
    title: `hitl-session-approval-${runID}-${suffix}`,
    permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    ...extra,
  })
  assert.equal(result.status, 200)
  const id = result.body.data.id
  sessions.push(id)
  return id
}
const approvalPath = (id) => `/api/session/${id}/permission/approval`
async function ask(base, id, save) {
  const result = await api(base, `/api/session/${id}/permission`, "POST", {
    action: "shell",
    resources: ["pwd"],
    ...(save === undefined ? {} : { save }),
  })
  assert.equal(result.status, 200)
  return result.body.data
}
let failure
try {
  const first = await create(a, "a")
  const other = await create(b, "b")
  const streamA = await subscribe(a, first, "A")
  await subscribe(b, other, "B")
  const request = await ask(a, first, ["pwd"])
  check("初次请求需要审批", request.effect === "ask")
  const replied = await api(a, `/api/session/${first}/permission/${request.id}/reply`, "POST", { decision: "always" })
  check("always回复成功", replied.status === 204)
  await waitUntil(
    () => events.some((row) => row.event.type === "permission.replied" && row.event.data?.requestID === request.id),
    "审批SSE",
  )
  check(
    "订阅期间观察到asked和replied",
    events.some((row) => row.event.type === "permission.asked" && row.event.data?.id === request.id),
  )
  const listed = await api(b, approvalPath(first))
  check("B实例读取A持久化的Session授权", listed.status === 200 && listed.body.data.length === 1)
  const approval = listed.body.data[0]
  check("授权审计来源正确", approval.sessionID === first && approval.sourceRequestID === request.id)
  check(
    "PG保存Session范围授权",
    pg(
      `SELECT count(*) FROM session_permission_approval WHERE session_id=${quote(first)} AND source_request_id=${quote(request.id)} AND action='shell' AND resource='pwd'`,
    ) === "1",
  )
  check("B实例授权评估立即生效", (await ask(b, first)).effect === "allow")
  const child = await create(b, "child", { parentID: first })
  await subscribe(b, child, "B-child")
  const childRequest = await ask(b, child)
  check(
    "子Session不继承父Session的always授权",
    childRequest.effect === "ask" && (await api(a, approvalPath(child))).body.data.length === 0,
  )
  await api(b, `/api/session/${child}/permission/${childRequest.id}/reply`, "POST", { decision: "reject" })
  // V2拒绝空Session fork；切换Agent通过正式事件投影形成历史，不直接改PG消息。
  const switched = await api(a, `/api/session/${first}/agent`, "POST", { agent: "build" })
  check("fork前通过API生成有效历史", switched.status === 204)
  const forked = await api(a, `/api/session/${first}/fork`, "POST", {})
  check("fork创建成功", forked.status === 200)
  const fork = forked.body.data.id
  sessions.push(fork)
  const streamFork = await subscribe(a, fork, "A-fork")
  const forkRequest = await ask(a, fork)
  check(
    "fork不复制原Session的always授权",
    forkRequest.effect === "ask" && (await api(b, approvalPath(fork))).body.data.length === 0,
  )
  await api(a, `/api/session/${fork}/permission/${forkRequest.id}/reply`, "POST", { decision: "reject" })
  const otherRequest = await ask(b, other)
  check("其他Session仍需审批", otherRequest.effect === "ask")
  check("其他Session没有保存授权", (await api(a, approvalPath(other))).body.data.length === 0)
  const wrong = await api(b, `${approvalPath(other)}/${approval.id}`, "DELETE")
  check("跨Session撤销不影响原授权", wrong.status === 204 && (await api(a, approvalPath(first))).body.data.length === 1)
  const once = await api(b, `/api/session/${other}/permission/${otherRequest.id}/reply`, "POST", { decision: "once" })
  check(
    "once不保存授权",
    once.status === 204 &&
      pg(`SELECT count(*) FROM session_permission_approval WHERE session_id=${quote(other)}`) === "0",
  )
  const deny = await api(a, `/api/session/${first}`, "PATCH", {
    permissions: [{ action: "shell", resource: "*", effect: "deny" }],
  })
  check("配置deny更新成功", deny.status === 204)
  check("已保存授权不能覆盖deny", (await ask(b, first)).effect === "deny")
  await api(a, `/api/session/${first}`, "PATCH", { permissions: [{ action: "shell", resource: "*", effect: "ask" }] })
  streamA.abort()
  streamFork.abort()
  const restart = spawnSync("docker", ["restart", container], { encoding: "utf8", timeout: 60_000 })
  assert.equal(restart.status, 0, restart.stderr)
  await waitUntil(async () => {
    try {
      return (await api(a, "/api/info")).status === 200
    } catch {
      return false
    }
  }, "容器重启就绪")
  await subscribe(a, first, "A-restarted")
  check("容器重启后原Session授权仍在", (await api(a, approvalPath(first))).body.data[0]?.id === approval.id)
  check("容器重启后授权评估继续生效", (await ask(a, first)).effect === "allow")
  check("正确Session撤销成功", (await api(b, `${approvalPath(first)}/${approval.id}`, "DELETE")).status === 204)
  check("撤销后另一pod重新要求审批", (await ask(a, first)).effect === "ask")
  check(
    "PG撤销数据收敛",
    pg(`SELECT count(*) FROM session_permission_approval WHERE session_id=${quote(first)}`) === "0",
  )
  const pending = await ask(b, other, ["pwd"])
  await api(b, `/api/session/${other}`, "PATCH", { permissions: [{ action: "shell", resource: "*", effect: "deny" }] })
  const blocked = await api(b, `/api/session/${other}/permission/${pending.id}/reply`, "POST", { decision: "always" })
  check("待审批期间更新deny拒绝批准", blocked.status === 403)
  check("拒绝批准不落持久授权", (await api(a, approvalPath(other))).body.data.length === 0)
  await api(b, `/api/session/${other}/permission/${pending.id}/reply`, "POST", { decision: "reject" })
  await waitUntil(
    () =>
      events.some(
        (row) => row.pod === "B" && row.event.type === "permission.replied" && row.event.data?.requestID === pending.id,
      ),
    "B实例拒绝事件",
  )
  check(
    "Session SSE事件不串流",
    events.every((row) => row.event.type === "server.connected" || row.event.data?.sessionID === row.sessionID),
  )
} catch (error) {
  failure = error
  console.error(String(error))
} finally {
  for (const controller of controllers) controller.abort()
  const outcomes = await Promise.allSettled(streams)
  if (!failure && outcomes.some((result) => result.status === "rejected")) failure = new Error("SSE意外断线")
  for (const id of [...sessions].reverse()) {
    try {
      const removed = await api(a, `/api/session/${id}`, "DELETE")
      assert.equal(removed.status, 204)
    } catch (error) {
      failure ??= error
    }
  }
  try {
    const ids = sessions.map(quote).join(",")
    if (ids)
      check(
        "本轮Session及授权清理干净",
        pg(
          `SELECT (SELECT count(*) FROM session_v2 WHERE id IN (${ids})) + (SELECT count(*) FROM session_permission_approval WHERE session_id IN (${ids}))`,
        ) === "0",
      )
  } catch (error) {
    failure ??= error
  }
  await writeFile(join(directory, "events.json"), JSON.stringify(events, null, 2))
  await writeFile(join(directory, "http.json"), JSON.stringify(httpEvidence, null, 2))
  await writeFile(join(directory, "pg.json"), JSON.stringify(pgEvidence, null, 2))
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(
      { runID, sessions, checks, status: failure ? "failed" : "passed", error: failure ? String(failure) : undefined },
      null,
      2,
    ),
  )
  console.log(`证据目录：${directory}`)
}
if (failure) process.exitCode = 1
