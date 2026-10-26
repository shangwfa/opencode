// docs/test-cases/session/ai-conversation.md T4.1–T4.8 全用例执行器（阿里云后端）
// 依据文档 V2 契约：POST /prompt（异步接纳）+ POST /experimental/wait；SSE 全程订阅；PG 后检；清理核验。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"

assert.ok(process.env.PG_URL?.endsWith("-test"), "必须使用专用测试 PG")
const base = (process.env.BASE ?? "http://127.0.0.1:15125").replace(/\/$/, "")
const password = process.env.OPENCODE_PASSWORD
const output = process.env.STRESS_OUT ?? "artifacts/ai-conversation-20261025"
const model = process.env.MODEL_JSON ? JSON.parse(process.env.MODEL_JSON) : { providerID: "deepseek", id: "deepseek-flash" }
const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" }
const report = { model, cases: [], events: [], forms: [], pg: {}, cleanup: {}, codeMode: "T4.8 断言 execute(completed) 与真实模型数据" }
const streams = []
const formAttempts = new Map()
const api = async (path, method = "GET", body, timeoutMs = 360000) => {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  return { status: response.status, ok: response.ok, json: text ? (() => { try { return JSON.parse(text) } catch { return undefined } })() : undefined, text }
}
const pg = (sql) => execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
async function answerForms(id) {
  try {
    const forms = (await api(`/api/session/${id}/form`)).json?.data ?? []
    for (const form of forms) {
      if ((formAttempts.get(form.id) ?? 0) >= 2 || form.fields?.some((field) => field.type === "external")) continue
      const answer = Object.fromEntries((form.fields ?? []).map((field) => [field.key,
        field.type === "boolean" ? field.default ?? true : ["number", "integer"].includes(field.type) ? field.default ?? field.minimum ?? 1
          : field.type === "multiselect" ? [field.options?.[0]?.value ?? field.default?.[0]].filter(Boolean)
            : field.options?.[0]?.value ?? field.default ?? "按推荐方案继续",
      ]))
      formAttempts.set(form.id, (formAttempts.get(form.id) ?? 0) + 1)
      const reply = await api(`/api/session/${id}/form/${form.id}/reply`, "POST", { answer })
      report.forms.push({ sessionID: id, formID: form.id, status: reply.status })
      console.log(`FORM · ${form.id} HTTP ${reply.status}`)
    }
  } catch {}
}
async function watch(id, label) {
  const controller = new AbortController()
  const response = await fetch(`${base}/api/session/${id}/event`, { headers, signal: controller.signal })
  assert.equal(response.status, 200, `SSE HTTP ${response.status}`)
  const done = (async () => {
    let buffer = ""
    const decoder = new TextDecoder()
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let end
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!line.startsWith("data:")) continue
        const event = JSON.parse(line.slice(5))
        report.events.push({ label, sessionID: id, ...event })
        if (event.type === "form.created") void answerForms(id)
        if (event.type === "session.tool.input.started") console.log(`公共 SSE ${label} tool ◇ ${event.data?.name}`)
        if (/execution\.(succeeded|failed|interrupted)|tool\.(success|failed)|form\.(created|cancelled)/.test(event.type ?? ""))
          console.log(`公共 SSE ${label} ${event.type}`)
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) report.streamError = error.message })
  streams.push({ controller, done })
}
async function createSession(title) {
  const created = await api("/api/session", "POST", { title, location: { directory: "/workspace" }, model }, 60000)
  assert.equal(created.status, 200, `session.create HTTP ${created.status}`)
  const id = created.json.data.id
  await watch(id, title)
  return id
}
async function sendPrompt(id, text, expectDataID = true) {
  const started = Date.now()
  const prompt = await api(`/api/session/${id}/prompt`, "POST", { text, metadata: {}, delivery: "queue" })
  const elapsedMs = Date.now() - started
  if (expectDataID) assert.equal(prompt.status, 200, `prompt HTTP ${prompt.status}: ${prompt.text.slice(0, 200)}`)
  const wait = await api(`/api/experimental/session/${id}/wait`, "POST", {}, 420000)
  assert.equal(wait.status, 204, `wait HTTP ${wait.status}`)
  return { promptStatus: prompt.status, messageID: prompt.json?.data?.id ?? null, elapsedMs, waitStatus: wait.status }
}
const messages = async (id) => (await api(`/api/session/${id}/message?order=asc&limit=200`)).json?.data ?? []
const tools = (rows) => rows.flatMap((message) => message.type === "assistant" ? (message.content ?? []).filter((part) => part.type === "tool").map((part) => ({ name: part.name, status: part.state?.status, input: part.state?.input, output: (part.state?.content ?? []).map((item) => item.text).join("\n"), error: part.state?.error?.message })) : [])
const texts = (rows) => rows.flatMap((message) => message.type === "assistant" ? (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text) : [])
const finish = (rows) => rows.filter((message) => message.type === "assistant").map((message) => message.finish).at(-1)
async function record(name, test) {
  const entry = { name }
  try { entry.details = await test(); entry.passed = true; console.log(`✓ ${name} ${JSON.stringify(entry.details)}`) }
  catch (error) { entry.passed = false; entry.error = error.message.slice(0, 600); console.log(`✗ ${name}: ${entry.error}`) }
  report.cases.push(entry)
}
try {
  await mkdir(output, { recursive: true })
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await api("/api/info", "GET", undefined, 5000)).ok) { ready = true; break } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert.ok(ready, "Docker SaaS 未就绪")
  console.log(`模型 ▶ ${JSON.stringify(model)}`)

  const sid = await createSession("T4 AI conversation")
  report.sessionID = sid
  await sendPrompt(sid, "1+1等于几")
  const rows1 = await messages(sid)
  await record("T4.1 简单文本对话", async () => {
    const answer = texts(rows1).join(" ")
    assert.match(answer, /2/, `assistant 文本: ${answer.slice(0, 200)}`)
    assert.ok(["stop", "end-turn", "completed"].includes(String(finish(rows1))), `finish=${finish(rows1)}`)
    return { answer: answer.slice(0, 80), finish: finish(rows1) }
  })
  await sendPrompt(sid, "记住我叫张三")
  await sendPrompt(sid, "我叫什么？")
  const rows2 = await messages(sid)
  await record("T4.2 多轮上下文记忆", async () => {
    const recent = texts(rows2).slice(-2).join(" ")
    assert.match(recent, /张三/, `第二轮回复: ${recent.slice(0, 200)}`)
    return { recent: recent.slice(0, 80) }
  })
  await sendPrompt(sid, "在 /workspace 创建 t4-3.txt 内容是 hello")
  const rows3 = await messages(sid)
  const fsRead = await api(`/api/session/${sid}/fs/read/t4-3.txt`)
  await record("T4.3 写文件工具", async () => {
    const list = tools(rows3).filter((tool) => tool.name === "write")
    assert.ok(list.some((tool) => tool.status === "completed"), `write 状态: ${JSON.stringify(list.map((tool) => tool.status))}`)
    assert.match(fsRead.text, /^hello/, `fs read: ${fsRead.text.slice(0, 100)}`)
    return { write: list.map((tool) => tool.status), fsRead: fsRead.text.slice(0, 20) }
  })
  await sendPrompt(sid, "读 /workspace/t4-3.txt")
  const rows4 = await messages(sid)
  await record("T4.4 读文件工具", async () => {
    const reads = tools(rows4).filter((tool) => tool.name === "read")
    assert.ok(reads.some((tool) => tool.status === "completed"), `read 状态: ${JSON.stringify(reads.map((tool) => tool.status))}`)
    const combined = texts(rows4).join(" ") + reads.map((tool) => tool.output).join(" ")
    assert.match(combined, /hello/, `结果: ${combined.slice(0, 200)}`)
    return { read: reads.map((tool) => tool.status) }
  })
  await sendPrompt(sid, "执行 ls /workspace 命令")
  const rows5 = await messages(sid)
  await record("T4.5 Shell 命令执行", async () => {
    const shells = tools(rows5).filter((tool) => tool.name === "shell")
    assert.ok(shells.some((tool) => tool.status === "completed"), `shell 状态: ${JSON.stringify(shells.map((tool) => tool.status))}`)
    const combined = texts(rows5).join(" ") + shells.map((tool) => tool.output).join(" ")
    assert.match(combined, /t4-3\.txt/, `输出: ${combined.slice(0, 300)}`)
    return { shell: shells.map((tool) => tool.status), input: shells.at(-1)?.input }
  })
  const admission = await sendPrompt(sid, "写一首五言绝句")
  const rows6 = await messages(sid)
  await record("T4.6 异步消息接纳", async () => {
    assert.equal(admission.promptStatus, 200)
    assert.ok(admission.messageID, `响应缺少 data.id: ${JSON.stringify(admission).slice(0, 200)}`)
    assert.ok(admission.elapsedMs < 5000, `prompt 同步耗时 ${admission.elapsedMs}ms，超出异步接纳预期`)
    assert.equal(admission.waitStatus, 204)
    assert.ok(texts(rows6).length > 0, "assistant 内容未落库")
    return { messageID: admission.messageID, elapsedMs: admission.elapsedMs, text: texts(rows6).at(-1)?.slice(0, 60) }
  })
  report.mainSessionTools = tools(rows6).map((tool) => ({ name: tool.name, status: tool.status }))

  const abortID = await createSession("T4 interrupt")
  report.abortSessionID = abortID
  await record("T4.7 中断会话", async () => {
    await api(`/api/session/${abortID}/prompt`, "POST", { text: "请开始写一篇一万字的中文文章，不要先给提纲，持续写正文。", metadata: {}, delivery: "queue" })
    let activeSeen = false
    for (let attempt = 0; attempt < 150; attempt++) {
      const active = (await api("/api/session/active", "GET", undefined, 15000)).json?.data ?? {}
      if (active[abortID]?.type === "running") { activeSeen = true; break }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.ok(activeSeen, "session 未进入 active map")
    const interrupt = await api(`/api/session/${abortID}/interrupt`, "POST", {}, 30000)
    assert.equal(interrupt.status, 200, `interrupt HTTP ${interrupt.status}`)
    assert.equal(interrupt.json?.interrupted, true, `interrupt 响应: ${interrupt.text.slice(0, 200)}`)
    const wait = await api(`/api/experimental/session/${abortID}/wait`, "POST", {}, 120000)
    assert.equal(wait.status, 204, `wait HTTP ${wait.status}`)
    const after = (await api("/api/session/active", "GET", undefined, 15000)).json?.data ?? {}
    assert.equal(after[abortID] ?? null, null, "中断后仍出现在 active map")
    const rows = await messages(abortID)
    return { activeSeen: true, interrupted: true, assistantMessages: rows.filter((message) => message.type === "assistant").length }
  })

  const cmID = await createSession("T4 code mode")
  report.codeModeSessionID = cmID
  await sendPrompt(cmID, "请使用 code mode 的 execute 工具调用 opencode_models 查询可用模型")
  const rowsCM = await messages(cmID)
  await record("T4.8 Code Mode 触发", async () => {
    const executes = tools(rowsCM).filter((tool) => tool.name === "execute")
    assert.ok(executes.some((tool) => tool.status === "completed"), `execute 状态: ${JSON.stringify(executes.map((tool) => ({ status: tool.status, error: tool.error })))}`)
    const done = executes.find((tool) => tool.status === "completed")
    assert.match(String(done.input?.code ?? ""), /opencode\.models/, `入参非 opencode_models 调用: ${String(done.input?.code).slice(0, 200)}`)
    assert.doesNotMatch(done.output, /connection closed/i, `输出含 runner 连接错误: ${done.output.slice(0, 200)}`)
    assert.match(done.output, /(deepseek|models|provider)/i, `输出非真实模型数据: ${done.output.slice(0, 300)}`)
    return { code: String(done.input?.code).slice(0, 120), output: done.output.slice(0, 160) }
  })
  report.passed = report.cases.every((value) => value.passed)
} catch (error) {
  report.error = error.message
  report.passed = false
} finally {
  for (const stream of streams) stream.controller.abort()
  await Promise.allSettled(streams.map((stream) => stream.done))
  try {
    const sessionRows = pg(`SELECT coalesce(json_agg(row_to_json(t)),'[]') FROM (SELECT id, directory, model FROM session_v2 ORDER BY time_created) t`)
    report.pg.sessions = JSON.parse(sessionRows)
    const toolStats = pg(`SELECT coalesce(json_agg(row_to_json(t)),'[]') FROM (SELECT part->>'name' AS name, part->'state'->>'status' AS status, count(*) FROM session_message, jsonb_array_elements(data::jsonb->'content') part WHERE type='assistant' AND part->>'type'='tool' GROUP BY 1,2 ORDER BY 1) t`)
    report.pg.toolCalls = JSON.parse(toolStats)
    report.pg.pending = pg("SELECT count(*) FROM session_pending")  } catch (error) { report.pg.error = error.message }
  for (const id of [report.sessionID, report.abortSessionID, report.codeModeSessionID].filter(Boolean)) {
    try {
      const removed = await api(`/api/session/${id}`, "DELETE", undefined, 180000)
      report.cleanup[id] = { status: removed.status }
      if (![200, 204, 404].includes(removed.status)) report.passed = false
    } catch (error) { report.cleanup[id] = { error: error.message }; report.passed = false }
  }
  try {
    report.pg.afterCleanup = {
      sessions: pg(`SELECT count(*) FROM session_v2 WHERE id IN ('${[report.sessionID, report.abortSessionID, report.codeModeSessionID].filter(Boolean).join("','")}')`),
      sandboxes: pg("SELECT coalesce(json_agg(row_to_json(t)),'[]') FROM (SELECT session_id, state, keep_alive, remote_name IS NOT NULL AS has_remote FROM sandbox ORDER BY session_id) t"),
    }
  } catch (error) { report.pg.afterCleanupError = error.message }
  await mkdir(output, { recursive: true })
  await writeFile(`${output}/result.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map((value) => `${value.name}:${value.passed ? "PASS" : "FAIL"}`), error: report.error, pgToolCalls: report.pg.toolCalls, cleanup: report.pg.afterCleanup }))
  if (!report.passed) process.exitCode = 1
}
