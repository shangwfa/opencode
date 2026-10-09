// V2 Agent 新增验收共用：HTTP/SSE/远端沙箱/PG，不用 sleep 等待。
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs"

const exec = promisify(execFile)
export const base = process.env.BASE ?? "http://localhost:14096"
export const container = process.env.SAAS_CONTAINER ?? "opencode-saas-test"
export const database = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const requestedModel = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-GLM","id":"glm-5.3-flash"}')
export const model = {
  providerID: requestedModel.providerID,
  id: requestedModel.id ?? requestedModel.model ?? requestedModel.modelID,
}
export const directory = process.env.EVIDENCE_DIR
assert(directory, "必须设置 EVIDENCE_DIR")
mkdirSync(directory, { recursive: true })
export const results = []
export const sessions = []
const watched = new Map()
const decisions = new Map()
let password
let sequence = 0
export const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`)
export const quote = (s) => `'${String(s).replaceAll("'", "''")}'`
export const pg = async (sql) => (await exec("psql", [database, "-X", "-tA", "-v", "ON_ERROR_STOP=1", "-c", sql], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim()
export const save = (name, data) => writeFileSync(`${directory}/${name}.json`, JSON.stringify(data, null, 2))
export const persist = () => save("result", { base, database, model, sessions, results })
export async function authenticate() {
  password = process.env.OPENCODE_PASSWORD
  if (!password) {
    const r = await exec("docker", ["logs", container], { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 })
    password = [...`${r.stdout}\n${r.stderr}`.matchAll(/server password (\S+)/g)].at(-1)?.[1]
  }
  assert(password, "缺少服务口令")
}
export async function raw(path, method = "GET", body, auth = true) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let data
  try { data = text ? JSON.parse(text) : undefined } catch { data = text }
  appendFileSync(`${directory}/http.jsonl`, JSON.stringify({ path, method, status: response.status, at: Date.now(), request: body, response: data }) + "\n")
  return { status: response.status, data }
}
export async function api(path, method = "GET", body) {
  const r = await raw(path, method, body)
  assert(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${(JSON.stringify(r.data) ?? "").slice(0, 400)}`)
  return r.data
}
export function until(label, check, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let busy = false, last = 0
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        const value = await check()
        if (value) { clearInterval(timer); resolve(value); return }
        if (Date.now() - started > timeout) throw new Error(`${label} 超时`)
        if (Date.now() - last > 10_000) { last = Date.now(); log(`${label} · 等待，SSE 持续订阅`) }
      } catch (e) { clearInterval(timer); reject(e) } finally { busy = false }
    }
    const timer = setInterval(tick, 500)
    void tick()
  })
}
export async function watch(sid) {
  if (watched.has(sid)) return
  const controller = new AbortController()
  watched.set(sid, controller)
  const response = await fetch(`${base}/api/session/${sid}/event`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, signal: controller.signal })
  assert.equal(response.status, 200, "会话 SSE")
  log(`SSE 连接 ${sid}`)
  void (async () => {
    let buffer = ""
    const decoder = new TextDecoder()
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          let e
          try { e = JSON.parse(line.slice(5)) } catch { continue }
          appendFileSync(`${directory}/events.jsonl`, JSON.stringify({ sid, at: Date.now(), ...e }) + "\n")
          const d = e.data ?? {}
          if (!/delta|streamed|usage.updated/.test(e.type)) {
            const content = d.text ?? d.error?.message ?? d.content?.filter?.(c => c.type === "text").map(c => c.text).join(" ") ?? d.name ?? d.reason ?? ""
            log(`${sid.slice(-8)} ${e.type} ${String(content).replace(/\s+/g, " ").slice(0, 140)}`)
          }
          if (e.type === "permission.asked") {
            const decision = decisions.get(sid) ?? "once"
            await api(`/api/session/${sid}/permission/${d.id}/reply`, "POST", { decision, ...(decision === "reject" ? { message: "验收拒绝：请停止这个工具并仅用文本说明。" } : {}) })
            log(`${sid.slice(-8)} 权限自动应答 ${decision}`)
          }
          if (e.type === "form.created") {
            for (const form of (await api(`/api/session/${sid}/form`)).data ?? []) {
              if (form.metadata?.kind !== "question") continue
              const answer = {}
              for (const f of form.fields ?? []) {
                if (f.type === "external") continue
                answer[f.key] = f.type === "boolean" ? f.default ?? true : /^(number|integer)$/.test(f.type) ? f.default ?? f.minimum ?? 1 : f.type === "multiselect" ? [f.options?.[0]?.value ?? f.default?.[0]].filter(Boolean) : f.options?.[0]?.value ?? f.default ?? "按推荐方案继续"
              }
              await api(`/api/session/${sid}/form/${form.id}/reply`, "POST", { answer })
              log(`${sid.slice(-8)} 表单自动应答 ${form.id}`)
            }
          }
        }
      }
    } catch (e) { if (!controller.signal.aborted) log(`SSE 断开 ${sid}: ${String(e).slice(0, 100)}`) }
    finally { if (watched.get(sid) === controller) watched.delete(sid) }
  })()
}
export async function fresh(title, extra = {}) {
  const r = await api("/api/session", "POST", { title: `agent-matrix-${title}-${Date.now()}`, location: { directory: "/workspace" }, model, ...extra })
  const sid = r.data.id
  sessions.push({ sid, title, parentID: extra.parentID })
  persist()
  await watch(sid)
  return sid
}
export const permissionDecision = (sid, decision) => decisions.set(sid, decision)
export const agents = async (sid) => (await api(`/api/session/${sid}/agents`)).data
export const put = (sid, id, config) => api(`/api/session/${sid}/agents`, "POST", { id, config })
export async function select(sid, id, config) {
  if (config) await put(sid, id, config)
  await api(`/api/session/${sid}/agent`, "POST", { agent: id })
}
export const messages = async (sid) => (await api(`/api/session/${sid}/message?order=asc`)).data
export const tools = (msgs) => msgs.filter(m => m.type === "assistant").flatMap(m => (m.content ?? []).filter(p => p.type === "tool"))
export const text = (msgs) => msgs.filter(m => m.type === "assistant").flatMap(m => (m.content ?? []).filter(p => p.type === "text").map(p => p.text)).join("\n")
export async function prompt(sid, input, timeout = 180_000, promptOptions = {}) {
  const before = new Set((await messages(sid)).map(m => m.id))
  // 子会话有独立公共 SSE；PG 发现只限本 parent，不扫描或接管其他根会话。
  let busy = false
  const timer = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const children = await pg(`SELECT id FROM session_v2 WHERE parent_id=${quote(sid)}`)
      for (const child of children.split("\n").filter(Boolean)) await watch(child)
    } catch (e) { log(`子 SSE 发现失败：${String(e).slice(0, 100)}`) } finally { busy = false }
  }, 500)
  const events = []
  try {
    const r = await fetch(`${base}/api/session/${sid}/prompt_stream`, { method: "POST", headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, body: JSON.stringify({ text: input, ...promptOptions, metadata: {}, delivery: "queue" }), signal: AbortSignal.timeout(timeout) })
    assert.equal(r.status, 200, "prompt_stream")
    let buffer = ""
    const decoder = new TextDecoder()
    for await (const chunk of r.body) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) if (line.startsWith("data:")) { try { events.push(JSON.parse(line.slice(5))) } catch {} }
    }
    const msgs = (await messages(sid)).filter(m => !before.has(m.id))
    save(`prompt-${++sequence}-${sid}`, { events, messages: msgs })
    return { events, messages: msgs, tools: tools(msgs), text: text(msgs) }
  } finally { clearInterval(timer) }
}
export async function shell(sid, command) {
  await api(`/api/session/${sid}/shell`, "POST", { command, timeoutSeconds: 30 })
  const msg = await until("远端 shell 完成", async () => (await messages(sid)).filter(m => m.type === "shell" && m.command === command && m.status !== "running").at(-1))
  assert.equal(msg.status, "exited", JSON.stringify(msg))
  assert.equal(msg.exit, 0, JSON.stringify(msg))
  return msg.output?.output ?? ""
}
export async function write(sid, path, content) {
  assert(path.startsWith("/workspace/"))
  const data = Buffer.from(content).toString("base64")
  await shell(sid, `mkdir -p ${quote(path.slice(0, path.lastIndexOf("/")))} && printf %s ${quote(data)} | base64 -d > ${quote(path)}`)
}
export async function check(id, label, run, coverage = "partial") {
  log(`T16.${id} ▶ ${label}`)
  const started = Date.now()
  try {
    const evidence = await run()
    results.push({ id, label, status: "passed", coverage, elapsedMs: Date.now() - started, evidence })
    log(`T16.${id} PASS ${label}（${coverage}）`)
  } catch (e) {
    results.push({ id, label, status: "failed", coverage, elapsedMs: Date.now() - started, error: String(e), stack: e.stack })
    log(`T16.${id} FAIL ${label}: ${String(e).slice(0, 260)}`)
  }
  persist()
}
export function blocked(id, reason) {
  results.push({ id, status: "blocked", coverage: "none", reason })
  log(`T16.${id} BLOCKED ${reason}`)
  persist()
}
export async function close(cleanup = false) {
  if (cleanup) for (const { sid, parentID } of sessions) if (!parentID) {
    await raw(`/api/session/${sid}/interrupt`, "POST").catch(() => undefined)
    await raw(`/api/session/${sid}`, "DELETE").catch(() => undefined)
  }
  watched.forEach(c => c.abort())
  watched.clear()
  persist()
}
export { assert, exec }
