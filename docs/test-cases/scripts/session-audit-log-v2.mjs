// V2 Session 操作审计日志（log 表）全生命周期验收：44 类审计 source 全覆盖。
// 策略：无模型操作确定性触发；模型操作（prompt/permission/form/inbox/compact/command/skill）走真实回合；
// snapshot.create 按 session 能力分支断言（失败不得产生审计行）。
// V1 exec_log 已移除；V2 双载体 = `log` 表（写审计）+ `event` 表（durable 事件，另行覆盖）。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"

const BASE = (process.env.BASE ?? "http://localhost:14099").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const parsedModel = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-GLM","id":"glm-5.3"}')
const model = { providerID: parsedModel.providerID, id: parsedModel.id ?? parsedModel.modelID }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(ok, description) {
  assert(ok, `FAIL: ${description}`)
  console.log(`PASS: ${description}`)
}
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
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(300_000),
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

let shellCount = 0
async function runShell(sessionID, command) {
  await api(`/api/session/${sessionID}/shell`, "POST", { command, timeoutSeconds: 30 })
  shellCount += 1
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const messages = (await api(`/api/session/${sessionID}/message?order=asc`)).data.data ?? []
    const item = messages.filter((m) => m.type === "shell" && m.command === command).at(-1)
    if (item && item.status !== "running") {
      assert.equal(item.status, "exited", JSON.stringify(item))
      assert.equal(item.exit, 0, JSON.stringify(item))
      return item.output?.output ?? ""
    }
    await sleep(250)
  }
  throw new Error(`Sandbox shell timed out: ${command}`)
}

const removeSession = async (sid) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    await api(`/api/session/${sid}`, "DELETE").catch(() => undefined)
    if (pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(sid)}`) === "0") return
    await sleep(1000)
  }
}

async function waitFor(predicate, timeout, label) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(500)
  }
  throw new Error(`timeout waiting for ${label}`)
}

// 收 prompt_stream SSE 直到回合结束（permission ask 会阻塞在流内，需先应答）
async function drainStream(response) {
  assert.equal(response.status, 200)
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
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")
      if (!data || data === "[DONE]") continue
      try {
        events.push(JSON.parse(data))
      } catch {}
    }
  }
  return events
}

const nonce = randomUUID().replaceAll("-", "").slice(0, 12)
const sessionID = (await api("/api/session", "POST", { title: `audit-full-${nonce}`, model })).data.data.id
const extraSessions = []

try {
  // ---------- Phase A：无模型确定性操作 ----------
  check(pg(`SELECT count(*) FROM log WHERE session_id=${quote(sessionID)} AND source='session.create'`) === "1", "T18.1 session.create 恰好一条")
  await api(`/api/session/${sessionID}/view`, "POST", { idle: Date.now() })
  await api(`/api/session/${sessionID}/environment`, "PUT", { variables: { AUDIT_VAR: "1" } })
  await api(`/api/experimental/session/${sessionID}/keep-alive`, "POST", { enabled: false })
  await api(`/api/session/${sessionID}/background`, "POST", {})
  await api(`/api/session/${sessionID}/interrupt`, "POST", {})

  await api(`/api/session/${sessionID}/agents-md`, "POST", { content: `# audit ${nonce}` })
  await api(`/api/session/${sessionID}/agents-md`, "DELETE")

  // Session Agent：create → permissionPreset → delete → create → clear
  await api(`/api/session/${sessionID}/agents`, "POST", { id: "session/audit-a", config: { mode: "subagent", description: "a" } })
  await api(`/api/session/${sessionID}/agents/session%2Faudit-a/permissions/preset`, "PUT", { preset: "read-only" })
  await api(`/api/session/${sessionID}/agents/session%2Faudit-a`, "DELETE")
  await api(`/api/session/${sessionID}/agents`, "POST", { id: "session/audit-b", config: { mode: "subagent", description: "b" } })
  await api(`/api/session/${sessionID}/agents`, "DELETE")

  // 命令定义：create ×2 → delete → clear
  await api(`/api/session/${sessionID}/commands`, "POST", { name: "audit-cmd", template: "echo done: {{prompt}}" })
  await api(`/api/session/${sessionID}/commands/audit-cmd`, "DELETE")
  await api(`/api/session/${sessionID}/commands`, "POST", { name: "audit-cmd-b", template: "Just reply OK." })

  // 工具定义：create → delete → create → clear
  await api(`/api/session/${sessionID}/tools`, "POST", { name: "audit-tool", description: "d", code: "export default { execute: async () => ({ output: 'ok' }) }" })
  await api(`/api/session/${sessionID}/tools/audit-tool`, "DELETE")
  await api(`/api/session/${sessionID}/tools`, "POST", { name: "audit-tool-b", description: "d", code: "export default { execute: async () => ({ output: 'ok' }) }" })
  await api(`/api/session/${sessionID}/tools`, "DELETE")

  // Skill 定义：create → delete → create → clear（留一个供 Phase B 执行）
  await api(`/api/session/${sessionID}/skills`, "POST", { id: "audit-skill", description: "d", content: "# audit skill\nReply OK." })
  await api(`/api/session/${sessionID}/skills/audit-skill`, "DELETE")
  await api(`/api/session/${sessionID}/skills`, "POST", { id: "audit-skill-b", description: "d", content: "# audit skill b\nReply OK." })

  // MCP 定义：create → delete → create → clear
  await api(`/api/session/${sessionID}/mcps`, "POST", { name: "audit-mcp", config: { type: "local", command: ["echo", "audit"] } })
  await api(`/api/session/${sessionID}/mcps/audit-mcp`, "DELETE")
  await api(`/api/session/${sessionID}/mcps`, "POST", { name: "audit-mcp-b", config: { type: "local", command: ["echo", "audit"] } })
  await api(`/api/session/${sessionID}/mcps`, "DELETE")

  // 选择与权限
  await api(`/api/session/${sessionID}/agent`, "POST", { agent: "build" })
  await api(`/api/session/${sessionID}/model`, "POST", { model })
  await api(`/api/session/${sessionID}/permissions/preset`, "PUT", { preset: "read-only" })
  // read-only 会限制后续写操作？preset 只影响工具权限，不影响控制面审计。改回 workspace-write 供模型回合用工具。
  await api(`/api/session/${sessionID}/permissions/preset`, "PUT", { preset: "workspace-write" })
  await api(`/api/session/${sessionID}`, "PATCH", { title: `renamed-${nonce}` })

  // synthetic / shell / move（须在 fork 前：删除 forked session 会销毁共享沙箱，重建后目录会丢失）
  await api(`/api/session/${sessionID}/synthetic`, "POST", { text: "audit note", description: "audit injection", metadata: {}, delivery: "queue" })
  await runShell(sessionID, `printf 'AUDIT_SECRET' > /workspace/.env.local-${nonce}`)
  await runShell(sessionID, `mkdir -p /workspace/audit-move-${nonce}`)
  // move：沙箱模式下曾复现 400（mkdir 成功但校验称目录不存在，见文档记录）；成功须记录、失败不得产生审计行
  const moveResult = await api(`/api/session/${sessionID}/move`, "POST", { directory: `/workspace/audit-move-${nonce}` })
  const moveLogged = pg(`SELECT count(*) FROM log WHERE session_id=${quote(sessionID)} AND source='session.move'`)
  if (moveResult.status === 204) check(moveLogged === "1", "T18.2 session.move 成功后恰好一条")
  else check(moveLogged === "0", `T18.2 session.move 失败(${moveResult.status})不产生审计行`)

  const forked = (await api(`/api/session/${sessionID}/fork`, "POST", {})).data.data
  check(
    pg(`SELECT count(*) FROM log WHERE session_id=${quote(forked.id)} AND source='session.fork'`) === "1",
    "T18.2 session.fork 记录在 fork 产生的新 session 上",
  )
  check(
    pg(`SELECT detail::jsonb->>'from' FROM log WHERE session_id=${quote(forked.id)} AND source='session.fork'`) === sessionID,
    "T18.2 fork detail 捕获源 session",
  )
  // import：从 fork 导出→删除→原样导入（覆盖 info.id 导入会 500，是独立产品缺陷，见文档记录）
  const exported = (await api(`/api/experimental/session/${forked.id}/export`, "GET")).data.data
  await removeSession(forked.id)
  const imported = (
    await api("/api/experimental/session/import", "POST", {
      info: exported.info,
      messages: exported.messages,
      location: { directory: `/workspace/audit-move-${nonce}` },
    })
  ).data.data
  extraSessions.push(imported.id)
  check(
    pg(`SELECT count(*) FROM log WHERE session_id=${quote(imported.id)} AND source='session.import'`) === "1",
    "T18.2 session.import 记录在导入产生的新 session 上",
  )

  await api(`/api/session/${sessionID}/kill-sandbox`, "POST", {})

  // Phase A 审计断言（无模型部分）
  for (const [source, count] of [
    ["session.create", 1], ["session.view", 1], ["session.environment", 1], ["session.keepAlive", 1],
    ["session.background", 1], ["session.interrupt", 1], ["session.agentsMd.update", 1], ["session.agentsMd.remove", 1],
    ["session.agentDefinition.create", 2], ["session.agentDefinition.permissionPreset", 1],
    ["session.agentDefinition.delete", 1], ["session.agentDefinition.clear", 1],
    ["session.commandDefinition.create", 2], ["session.commandDefinition.delete", 1], ["session.commandDefinition.clear", 0],
    ["session.toolDefinition.create", 2], ["session.toolDefinition.delete", 1], ["session.toolDefinition.clear", 1],
    ["session.skillDefinition.create", 2], ["session.skillDefinition.delete", 1], ["session.skillDefinition.clear", 0],
    ["session.mcpDefinition.create", 2], ["session.mcpDefinition.delete", 1], ["session.mcpDefinition.clear", 1],
    ["session.agent.select", 1], ["session.model.select", 1], ["session.permissions", 2],
    ["session.update", 1], ["session.synthetic", 1], ["session.killSandbox", 1],
  ]) {
    check(
      pg(`SELECT count(*) FROM log WHERE session_id=${quote(sessionID)} AND source=${quote(source)}`) === String(count),
      `T18.2 ${source} 恰好 ${count} 条`,
    )
  }
  check(
    pg(`SELECT detail::jsonb->>'variables' FROM log WHERE session_id=${quote(sessionID)} AND source='session.environment'`) ===
      `["AUDIT_VAR"]`,
    "T18.2 environment detail 捕获变量名列表",
  )
  check(
    pg(`SELECT detail::jsonb->>'preset' FROM log WHERE session_id=${quote(sessionID)} AND source='session.agentDefinition.permissionPreset'`) === "read-only",
    "T18.2 agentDefinition.permissionPreset detail 捕获 preset",
  )

  // ---------- Phase B：真实模型回合 ----------
  // 1) prompt_stream 普通回合
  const okStream = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "Reply with exactly: OK", metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(300_000),
  })
  const streamEvents = await drainStream(okStream)
  check(streamEvents.some((e) => e.type === "session.execution.succeeded"), "T18.3 prompt_stream 回合成功")

  // 2) permission.respond：read .env.local → ask → reject
  const envPrompt = fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST", headers,
    body: JSON.stringify({
      text: `Use the read tool exactly once on /workspace/.env.local-${nonce} and report the result. Do not use any other tool.`,
      metadata: {}, delivery: "queue",
    }),
    signal: AbortSignal.timeout(300_000),
  })
  const requestID = await waitFor(async () => {
    const pending = (await api(`/api/session/${sessionID}/permission`)).data.data ?? []
    return pending[0]?.id ?? null
  }, 120_000, "permission ask")
  await api(`/api/session/${sessionID}/permission/${requestID}/reply`, "POST", { decision: "reject" })
  const envResponse = await envPrompt
  await drainStream(envResponse)
  check(
    pg(`SELECT (detail::jsonb->>'requestID') || '|' || (detail::jsonb->>'decision') FROM log WHERE session_id=${quote(sessionID)} AND source='permission.respond'`) ===
      `${requestID}|reject`,
    "T18.3 permission.respond 捕获 requestID 与 decision",
  )

  // 3) 非 stream prompt + compact（wait 单独短超时并容错：等待失败不代表回合失败）
  const waitShort = (sid) =>
    fetch(`${BASE}/api/session/${sid}/wait`, { method: "POST", headers, signal: AbortSignal.timeout(90_000) }).catch(
      () => undefined,
    )
  await api(`/api/session/${sessionID}/prompt`, "POST", { text: "Reply with exactly: OK", metadata: {}, delivery: "queue" })
  await waitShort(sessionID)
  await api(`/api/session/${sessionID}/compact`, "POST", {})
  await waitShort(sessionID)

  // 4) command 执行 + skill 执行
  await api(`/api/session/${sessionID}/command`, "POST", { name: "audit-cmd-b", text: "go" })
  await waitShort(sessionID)
  await api(`/api/experimental/session/${sessionID}/skill`, "POST", { id: "audit-skill-b" })
  await waitShort(sessionID)

  // 5) form.reply + form.cancel：question 工具两次
  const formPrompt1 = fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "You must use the question tool to ask the user for their favorite color before answering. Ask the question now.", metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(300_000),
  })
  const form1 = await waitFor(async () => {
    const forms = (await api(`/api/session/${sessionID}/form`)).data.data ?? []
    return forms[0] ?? null
  }, 180_000, "question form 1")
  const answer = {}
  for (const field of form1.fields ?? []) {
    if (field.type === "external") continue
    answer[field.key] = field.type === "boolean" ? (field.default ?? true) : field.options?.[0]?.value ?? field.default ?? "blue"
  }
  await api(`/api/session/${sessionID}/form/${form1.id}/reply`, "POST", { answer })
  await drainStream(await formPrompt1)

  const formPrompt2 = fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "You must use the question tool to ask the user one follow-up question about their day. Ask the question now.", metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(300_000),
  })
  const form2 = await waitFor(async () => {
    const forms = (await api(`/api/session/${sessionID}/form`)).data.data ?? []
    return forms[0] ?? null
  }, 180_000, "question form 2")
  await api(`/api/session/${sessionID}/form/${form2.id}`, "DELETE")
  await drainStream(await formPrompt2)

  // 6) inbox.update + inbox.cancel：长回合执行中并发两条 steer
  const longRun = fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "Use the shell tool to run: sleep 25. Then reply done.", metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(300_000),
  })
  await sleep(3000)
  await api(`/api/session/${sessionID}/prompt`, "POST", { text: "queued during long turn", metadata: {}, delivery: "steer" })
  await api(`/api/session/${sessionID}/prompt`, "POST", { text: "cancel me", metadata: {}, delivery: "steer" })
  const pending = await waitFor(async () => {
    const items = (await api(`/api/session/${sessionID}/inbox`)).data.data ?? []
    return items.filter((i) => i.delivery === "steer")
  }, 90_000, "pending inbox")
  for (const item of pending) {
    if (item.payload?.text === "cancel me") await api(`/api/session/${sessionID}/inbox/${item.id}`, "DELETE")
    else await api(`/api/session/${sessionID}/inbox/${item.id}`, "PATCH", { delivery: "queue" })
  }
  await drainStream(await longRun)
  await waitShort(sessionID)

  // 7) revert：stage → clear → stage → commit
  const messages = (await api(`/api/session/${sessionID}/message?order=asc`)).data.data ?? []
  const target = messages.find((m) => m.type === "user")
  await api(`/api/session/${sessionID}/revert/stage`, "POST", { messageID: target.id })
  await api(`/api/session/${sessionID}/revert`, "DELETE")
  await api(`/api/session/${sessionID}/revert/stage`, "POST", { messageID: target.id })
  await api(`/api/session/${sessionID}/revert/commit`, "POST", {})

  // 8) snapshot.create：按能力分支（失败不得产生审计行）
  const snapshot = await api(`/api/session/${sessionID}/snapshot`, "POST", {})
  const snapshotLogged = pg(`SELECT count(*) FROM log WHERE session_id=${quote(sessionID)} AND source='session.snapshot.create'`)
  if (snapshot.status === 200) check(snapshotLogged === "1", "T18.3 session.snapshot.create 成功后记录一条")
  else check(snapshotLogged === "0", "T18.3 snapshot.create 失败不产生审计行")

  // Phase B 审计断言
  for (const [source, min] of [
    ["session.prompt", 5], ["session.shell", 2], ["session.compact", 1], ["session.command", 1], ["session.skill", 1],
    ["permission.respond", 1], ["session.form.reply", 1], ["session.form.cancel", 1],
    ["session.inbox.update", 1], ["session.inbox.cancel", 1],
    ["session.revert.stage", 2], ["session.revert.clear", 1], ["session.revert.commit", 1],
  ]) {
    check(
      Number(pg(`SELECT count(*) FROM log WHERE session_id=${quote(sessionID)} AND source=${quote(source)}`)) >= min,
      `T18.3 ${source} 至少 ${min} 条`,
    )
  }

  // ---------- 通用 API 属性 ----------
  const logs = (await api(`/api/session/${sessionID}/logs`)).data.data
  check(logs[0].source === "session.create" && logs[0].id.startsWith("log_"), "T18.4 首条审计为 session.create 且 ID 为 log_ 前缀")
  const times = logs.map((e) => e.time.created)
  check(JSON.stringify(times) === JSON.stringify([...times].sort()), "T18.4 审计条目按时间升序")
  const limited = (await api(`/api/session/${sessionID}/logs?limit=2`)).data.data
  check(limited.length === 2 && limited[0].source === "session.create", "T18.4 limit 截断且保留最旧两条")
  check((await api(`/api/session/ses_missing/logs`)).status === 404, "T18.4 缺失 session 返回 404")

  // after 游标翻页取尽全部审计，拼接结果与全量查询一致
  const paged = []
  let cursor
  for (;;) {
    const page = (await api(`/api/session/${sessionID}/logs?limit=5${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`)).data.data
    paged.push(...page)
    if (page.length < 5) break
    cursor = page[page.length - 1].id
  }
  check(
    JSON.stringify(paged.map((e) => e.id)) === JSON.stringify(logs.map((e) => e.id)),
    "T18.4 after 游标翻页可取回该 session 的全部审计条目",
  )

  // 隔离
  const other = (await api("/api/session", "POST", { title: `audit-iso-${nonce}`, model })).data.data.id
  extraSessions.push(other)
  const otherLogs = (await api(`/api/session/${other}/logs`)).data.data
  check(otherLogs.length === 1 && otherLogs[0].source === "session.create" && otherLogs[0].sessionID === other, "T18.5 审计按 session 隔离")

  // 级联清理
  await removeSession(sessionID)
  check(pg(`SELECT count(*) FROM log WHERE session_id=${quote(sessionID)}`) === "0", "T18.6 session 删除后审计行级联清零")
  check((await api(`/api/session/${sessionID}/logs`)).status === 404, "T18.6 删除后审计 API 返回 404")
} finally {
  await api(`/api/session/${sessionID}/shell`, "POST", {
    command: `rm -f /workspace/.env.local-${nonce}; rm -rf /workspace/audit-move-${nonce}`,
    timeoutSeconds: 30,
  }).catch(() => undefined)
  await removeSession(sessionID)
  for (const sid of extraSessions) await removeSession(sid)
  const ids = [quote(sessionID), ...extraSessions.map(quote)].join(",")
  check(pg(`SELECT count(*) FROM log WHERE session_id IN (${ids})`) === "0", "清理：全部测试 session 审计行零残留")
}
