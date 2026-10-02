import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { spawnSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:14196"
const database = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-test"
const headers = {
  "content-type": "application/json",
  ...(process.env.OPENCODE_PASSWORD
    ? { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}` }
    : {}),
}
const model = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}')
const sessions = []
const checks = []
const sql = (query) => {
  const result = spawnSync("psql", [database, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
async function api(path, method = "GET", body, timeout = 180_000) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await response.text()
  assert(response.ok, `${method} ${path}: HTTP ${response.status}, ${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : undefined
}
function check(name, predicate, evidence) {
  assert(predicate, `${name}: ${JSON.stringify(evidence)}`)
  checks.push({ name, evidence })
  console.log(`通过：${name}`)
}
const source = (version) => `import fs from 'node:fs/promises';import {Effect} from 'effect';
let count=0;export default {description:'Sandbox verification probe: writes a file and reports process identity',args:{},async execute(args,context){
count++;await fs.writeFile('/workspace/session-tool-probe.txt','${version}:'+count);
await Effect.runPromise(context.progress({phase:'sandbox-verified'}));
return {title:'Sandbox probe',output:JSON.stringify({version:'${version}',count,cwd:process.cwd(),directory:context.directory,
sessionID:context.sessionID,serverDatabaseVisible:!!process.env.OPENCODE_DATABASE_URL,file:await fs.readFile('/workspace/session-tool-probe.txt','utf8')})};}}`
async function call(id) {
  const before = new Set(
    (await api(`/api/session/${id}/message?order=asc&limit=200`)).data.map((message) => message.id),
  )
  const response = await fetch(`${base}/api/session/${id}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: "必须实际调用一次且仅一次 sandbox_probe 工具，参数 {}。不要调用其他工具，不要询问问题。收到结果后直接报告结果。",
      metadata: {},
      delivery: "queue",
    }),
    signal: AbortSignal.timeout(180_000),
  })
  const stream = await response.text()
  assert(response.ok, `prompt HTTP ${response.status}: ${stream.slice(0, 500)}`)
  const messages = (await api(`/api/session/${id}/message?order=asc&limit=200`)).data.filter(
    (message) => !before.has(message.id),
  )
  const tools = messages.flatMap((message) =>
    message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
  )
  const probes = tools.filter((part) => part.name === "sandbox_probe")
  if (probes.length !== 1 && process.env.REPORT)
    await fs.writeFile(`${process.env.REPORT}.failure.json`, JSON.stringify({ stream, messages }, null, 2))
  assert.equal(probes.length, 1, `本回合应恰有一次 probe: ${JSON.stringify(tools)}`)
  const probe = probes[0]
  assert.equal(probe.state.status, "completed", JSON.stringify(probe))
  const output = typeof probe.state.output === "string" ? probe.state.output : probe.state.content
  const value =
    typeof output === "string"
      ? output
      : Array.isArray(output)
        ? output
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("")
        : ""
  return { probe, messages, stream, value: JSON.parse(value) }
}

try {
  const created = await api("/api/session", "POST", {
    title: `session-tool-sandbox-e2e-${Date.now()}`,
    model,
    location: { directory: "/workspace" },
  })
  const id = created.data.id
  sessions.push(id)
  const tool = await api(`/api/session/${id}/tools`, "POST", {
    name: "sandbox_probe",
    description: "Sandbox probe",
    code: source("v1"),
  })
  check(
    "工具 CRUD 字段与 PG 源码一致",
    tool.name === "sandbox_probe" && tool.code === source("v1") && !!tool.id && tool.time.updated >= tool.time.created,
    { id: tool.id, name: tool.name },
  )
  assert.equal(sql(`select code from session_tools where session_id='${id}' and name='sandbox_probe'`), source("v1"))
  const first = await call(id)
  check(
    "原生工具在会话 Sandbox 执行",
    first.value.cwd === "/workspace" &&
      first.value.directory === "/workspace" &&
      first.value.sessionID === id &&
      !first.value.serverDatabaseVisible &&
      first.value.file === "v1:1",
    first.value,
  )
  check(
    "progress 通过 SSE 输出、title 保持最终 metadata 契约",
    first.stream.includes('"phase":"sandbox-verified"') && first.probe.state.metadata?.title === "Sandbox probe",
    first.probe.state.metadata,
  )
  const second = await call(id)
  check("跨模型请求保留模块状态", second.value.count === 2, second.value)
  await api(`/api/session/${id}/tools`, "POST", {
    name: "sandbox_probe",
    description: "Sandbox probe V2",
    code: source("v2"),
  })
  const third = await call(id)
  check("upsert 切换独立版本 worker", third.value.version === "v2" && third.value.count === 1, third.value)
  const oldID = sql(`select id from sandbox where session_id='${id}' and state='running'`)
  await api(`/api/session/${id}/kill-sandbox`, "POST", {})
  check(
    "kill 关闭物理准入",
    sql(`select state from sandbox_execution_gate where root_session_id='${id}'`) === "closed",
    oldID,
  )
  const recovered = await call(id)
  const newID = sql(`select id from sandbox where session_id='${id}' and state='running'`)
  check(
    "现有镜像重建后自动物化并恢复工具",
    recovered.value.version === "v2" && recovered.value.count === 1 && newID !== oldID,
    { oldID, newID, value: recovered.value },
  )
  check(
    "PG 准入绑定新 Sandbox",
    sql(`select sandbox_id from sandbox_execution_gate where root_session_id='${id}' and state='open'`) === newID,
    newID,
  )
  const persisted = JSON.parse(
    sql(
      `select coalesce(json_agg(data::jsonb),'[]'::json) from session_message where session_id='${id}' and type='assistant'`,
    ),
  )
  const persistedTools = persisted.flatMap((message) =>
    (message.content ?? []).filter((part) => part.type === "tool" && part.name === "sandbox_probe"),
  )
  check(
    "PG 工具终态全部完成",
    persistedTools.length === 4 && persistedTools.every((part) => part.state.status === "completed"),
    {
      count: persistedTools.length,
      states: persistedTools.map((part) => part.state.status),
      messageKeys: persisted.map((message) => Object.keys(message)),
    },
  )
  if (process.env.MODEL_REQUEST_LOG_FILE) {
    const entries = (await fs.readFile(process.env.MODEL_REQUEST_LOG_FILE, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.sessionID === id && entry.kind === "primary")
    check(
      "Code Mode 开启时仍向模型提供原生 session tool",
      entries.length >= 4 &&
        entries.every(
          (entry) =>
            !entry.truncated && entry.toolNames.includes("execute") && entry.toolNames.includes("sandbox_probe"),
        ),
      { requests: entries.length, toolNames: entries[0]?.toolNames },
    )
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
} finally {
  for (const id of sessions) {
    try {
      await api(`/api/session/${id}`, "DELETE")
    } catch (error) {
      console.error(`清理失败 ${id}: ${String(error)}`)
      process.exitCode = 1
    }
  }
  if (process.env.REPORT)
    await fs.writeFile(process.env.REPORT, JSON.stringify({ checks, passed: !process.exitCode }, null, 2))
  console.log(`验收断言通过 ${checks.length} 项`)
}
