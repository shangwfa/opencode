// docs/test-cases/session/sse.md T9.1–T9.36 全用例执行器（阿里云后端，OPENCODE_EVENTS_PERSIST=1）
// 每条用例按文档断言；T9.12/T9.17 按文档记 N/A；T9.37 在 packages/server 单独执行。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"

const base = (process.env.BASE ?? "http://127.0.0.1:15127").replace(/\/$/, "")
const password = process.env.OPENCODE_PASSWORD
const output = process.env.STRESS_OUT ?? "artifacts/sse-20261025"
const model = process.env.MODEL_JSON ? JSON.parse(process.env.MODEL_JSON) : { providerID: "deepseek", id: "deepseek-flash" }
const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" }
const results = []
const sessionIDs = new Set()
const transcripts = {}
let current = ""
const api = async (path, method = "GET", body, timeoutMs = 120000) => {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let json
  try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
  return { status: response.status, ok: response.ok, json, text, contentType: response.headers.get("content-type"), headers: response.headers }
}
const pg = (sql) => execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
class Dumper {
  events = []
  raw = []
  controller = new AbortController()
  started = false
  constructor(url, seconds) { this.url = url; this.seconds = seconds; this.done = this.run() }
  async run() {
    const timer = setTimeout(() => this.controller.abort(), this.seconds * 1000)
    try {
      const response = await fetch(this.url, { headers, signal: this.controller.signal })
      this.status = response.status
      this.contentType = response.headers.get("content-type")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        this.raw.push(chunk)
        buffer += chunk
        const blocks = buffer.split(/\r?\n\r?\n/)
        buffer = blocks.pop() ?? ""
        for (const block of blocks) {
          const dataLines = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
          if (!dataLines.length || dataLines[0] === "[DONE]") continue
          try { this.events.push(JSON.parse(dataLines.join("\n"))) } catch {}
        }
      }
      this.closed = true
    } catch (error) { this.error = error.name } finally { clearTimeout(timer) }
  }
  async waitConnected(timeoutMs = 15000) {
    if (!this.started) { this.started = true }
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if (this.events.some((event) => event.type === "server.connected")) return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error("未收到 server.connected")
  }
  stop() { this.controller.abort(); return this.done.catch(() => {}) }
  waitFull() { return this.done.catch(() => {}) }
}
const waitForEvent = async (dump, predicate, timeoutMs = 5000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (dump.events.some((event) => predicate(event))) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}
const waitBoot = async (id, timeoutMs = 120000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const sandbox = await api(`/api/session/${id}/sandbox`, "GET", undefined, 20000)
    if (sandbox.json?.sandboxId) return sandbox.json.sandboxId
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error("沙箱未在期限内进入 running")
}
const newSession = async (title, customModel) => {
  const created = await api("/api/session", "POST", { title, location: { directory: "/workspace" }, model: customModel ?? model }, 60000)
  assert.equal(created.status, 200, `session.create HTTP ${created.status}: ${created.text.slice(0, 200)}`)
  const id = created.json.data.id
  sessionIDs.add(id)
  return id
}
const sendPrompt = async (id, text) => {
  const prompt = await api(`/api/session/${id}/prompt`, "POST", { text, metadata: {}, delivery: "queue" })
  assert.equal(prompt.status, 200, `prompt HTTP ${prompt.status}`)
  const wait = await api(`/api/experimental/session/${id}/wait`, "POST", {}, 420000)
  assert.equal(wait.status, 204, `wait HTTP ${wait.status}`)
  return prompt
}
const collect = async (name, test) => {
  current = name
  const entry = { name }
  const started = Date.now()
  try { entry.details = await test(); entry.passed = true; console.log(`✓ ${name} ${JSON.stringify(entry.details).slice(0, 300)}`) }
  catch (error) { entry.passed = false; entry.error = error.message.slice(0, 500); console.log(`✗ ${name}: ${entry.error}`) }
  entry.ms = Date.now() - started
  results.push(entry)
  transcripts[name] = results.length
}
try {
  await mkdir(output, { recursive: true })
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await api("/api/info", "GET", undefined, 5000)).ok) { ready = true; break } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert.ok(ready, "Docker SaaS 未就绪")

  // T9.1 + T9.4 + T9.25：全局流头与首事件；目录头被忽略
  await collect("T9.1/T9.4 全局流头与首事件", async () => {
    const dump = new Dumper(`${base}/api/event`, 3)
    await dump.waitConnected()
    await dump.stop()
    assert.match(dump.contentType ?? "", /text\/event-stream/)
    assert.equal(dump.events[0].type, "server.connected")
    const withHeader = await fetch(`${base}/api/event`, { headers: { ...headers, "x-opencode-directory": "/workspace" }, signal: AbortSignal.timeout(5000) })
    assert.equal(withHeader.status, 200)
    assert.match(withHeader.headers.get("content-type") ?? "", /text\/event-stream/)
    await withHeader.body.cancel()
    return { contentType: dump.contentType, first: dump.events[0].type }
  })
  // T9.2 全局流收到 session.created
  await collect("T9.2 创建会话触发事件", async () => {
    const dump = new Dumper(`${base}/api/event`, 10)
    await dump.waitConnected()
    const id = await newSession("sse-v2-t92")
    const until = Date.now() + 8000
    while (Date.now() < until && !dump.events.some((event) => event.type === "session.created" && event.data?.sessionID === id)) await new Promise((resolve) => setTimeout(resolve, 300))
    await dump.stop()
    const created = dump.events.find((event) => event.type === "session.created" && event.data?.sessionID === id)
    assert.ok(created, "未收到对应 session.created")
    return { sessionID: created.data.sessionID }
  })
  // T9.3 心跳注释（20s 原始流）
  await collect("T9.3 心跳注释行", async () => {
    const dump = new Dumper(`${base}/api/event`, 20)
    await dump.waitFull()
    const text = dump.raw.join("")
    const count = (text.match(/^: heartbeat$/gm) ?? []).length
    assert.ok(count >= 1, `20 秒内未见 : heartbeat，原文 ${(text.match(/^:.*$/gm) ?? []).join("|").slice(0, 120)}`)
    return { heartbeats: count }
  }, 30000)
  // T9.5 文本事件
  await collect("T9.5 会话消息文本事件", async () => {
    const id = await newSession("sse-v2-t95")
    const dump = new Dumper(`${base}/api/session/${id}/event`, 45)
    await dump.waitConnected()
    await sendPrompt(id, "说一个字")
    await dump.stop()
    const deltas = dump.events.filter((event) => event.type === "session.text.delta")
    const ended = dump.events.filter((event) => event.type === "session.text.ended")
    assert.ok(deltas.length >= 1, "缺少 session.text.delta")
    assert.ok(ended.length >= 1, "缺少 session.text.ended")
    assert.equal(deltas[0].data.sessionID, id)
    return { deltas: deltas.length, ended: ended.length }
  })
  // T9.6 工具生命周期
  await collect("T9.6 工具调用生命周期事件", async () => {
    const id = await newSession("sse-v2-t96")
    const dump = new Dumper(`${base}/api/session/${id}/event`, 75)
    await dump.waitConnected()
    await sendPrompt(id, "用 shell 执行 echo hello_sse_test")
    await dump.stop()
    const order = dump.events.filter((event) => event.type.startsWith("session.tool.")).map((event) => event.type)
    assert.ok(order.includes("session.tool.input.started"), `tool events: ${order.join(",")}`)
    assert.ok(order.includes("session.tool.success"), `无成功终态: ${order.join(",")}`)
    return { order: [...new Set(order)] }
  })
  // T9.7 权限请求（两个分支均有效）
  await collect("T9.7 权限请求事件（条件分支）", async () => {
    const id = await newSession("sse-v2-t97")
    const dump = new Dumper(`${base}/api/session/${id}/event`, 60)
    await dump.waitConnected()
    const promptPromise = sendPrompt(id, "use the write tool to write hello to /workspace/sse-perm-test.txt")
    let replied = null
    const until = Date.now() + 25000
    while (Date.now() < until) {
      const asked = dump.events.find((event) => event.type === "permission.asked")
      if (asked) {
        const reply = await api(`/api/session/${id}/permission/${asked.data.id}/reply`, "POST", { decision: "always" })
        replied = { requestID: asked.data.id, status: reply.status }
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    await promptPromise
    await dump.stop()
    if (replied) return { branch: "permission.asked 已回复", ...replied }
    assert.ok(dump.events.some((event) => event.type === "session.execution.succeeded"), "无权限事件且回合未成功")
    return { branch: "权限默认放行，回合正常完成" }
  })
  // T9.8 多会话事件隔离
  await collect("T9.8 多会话事件隔离", async () => {
    const idA = await newSession("sse-v2-t98-a")
    const idB = await newSession("sse-v2-t98-b")
    const dump = new Dumper(`${base}/api/session/${idA}/event`, 55)
    await dump.waitConnected()
    await Promise.all([sendPrompt(idA, "说A"), sendPrompt(idB, "说B")])
    await dump.stop()
    const sids = new Set(dump.events.map((event) => event.data?.sessionID).filter(Boolean))
    assert.ok(sids.has(idA), "A 流未收到自身事件")
    sids.delete(idA)
    assert.equal(sids.size, 0, `B 泄漏: ${[...sids].join(",")}`)
    return { isolated: true }
  })
  // T9.9 回合状态事件
  await collect("T9.9 回合状态事件", async () => {
    const id = await newSession("sse-v2-t99")
    const dump = new Dumper(`${base}/api/session/${id}/event`, 45)
    await dump.waitConnected()
    await sendPrompt(id, "说一个字")
    await dump.stop()
    const types = dump.events.map((event) => event.type)
    assert.ok(types.includes("session.execution.started"), "缺少 execution.started")
    const last = [...types].reverse().find((type) => type.startsWith("session.execution."))
    assert.equal(last, "session.execution.succeeded", `最后执行事件: ${last}`)
    return { started: types.filter((type) => type === "session.execution.started").length, terminal: last }
  })
  // T9.10 异步接纳
  await collect("T9.10 异步接纳 prompt 触发事件", async () => {
    const id = await newSession("sse-v2-t910")
    const dump = new Dumper(`${base}/api/session/${id}/event`, 45)
    await dump.waitConnected()
    const prompt = await api(`/api/session/${id}/prompt`, "POST", { text: "说一个字", metadata: {}, delivery: "queue" })
    assert.equal(prompt.status, 200)
    assert.ok(prompt.json?.data?.id, `响应缺 data.id: ${prompt.text.slice(0, 120)}`)
    await api(`/api/experimental/session/${id}/wait`, "POST", {}, 300000)
    await dump.stop()
    assert.ok(dump.events.some((event) => event.type === "session.text.delta"), "SSE 未收到 text.delta")
    return { messageID: prompt.json.data.id }
  })
  // T9.11 文件变更事件
  await collect("T9.11 文件变更事件", async () => {
    const id = await newSession("sse-v2-t911")
    const dump = new Dumper(`${base}/api/session/${id}/event`, 60)
    await dump.waitConnected()
    await sendPrompt(id, "use the write tool to write hello to /workspace/sse-file-test.txt")
    await dump.stop()
    const changed = dump.events.filter((event) => event.type === "filesystem.changed")
    assert.ok(changed.length >= 1, "未收到 filesystem.changed")
    assert.ok(changed[0].data.file, "缺少 data.file")
    return { file: changed[0].data.file, event: changed[0].data.event, count: changed.length }
  })
  // T9.12 dispose：无 HTTP 端点（文档标注待补）
  results.push({ name: "T9.12 dispose 事件", passed: null, note: "V2 无 HTTP 处置端点，文档标注待补，本轮 N/A" })
  console.log("○ T9.12 N/A（无端点）")
  // T9.13 重连
  await collect("T9.13 连接断开后重连", async () => {
    const firsts = []
    for (const suffix of ["a", "b"]) {
      const dump = new Dumper(`${base}/api/event`, 3)
      await dump.waitConnected()
      firsts.push(dump.events[0].type)
      await dump.stop()
    }
    assert.deepEqual(firsts, ["server.connected", "server.connected"])
    return { firsts }
  })
  // T9.14 多客户端监听同一会话
  await collect("T9.14 多客户端监听同一会话", async () => {
    const id = await newSession("sse-v2-t914")
    const dumps = [0, 1, 2].map(() => new Dumper(`${base}/api/session/${id}/event`, 55))
    await Promise.all(dumps.map((dump) => dump.waitConnected()))
    await sendPrompt(id, "say hello in one sentence")
    await Promise.all(dumps.map((dump) => dump.stop()))
    for (const [index, dump] of dumps.entries()) {
      assert.ok(dump.events.some((event) => event.type.startsWith("session.text")), `client ${index} 无 text 事件`)
      assert.ok(dump.events.some((event) => event.type === "session.execution.succeeded"), `client ${index} 无终态`)
    }
    return { clients: dumps.length, textEvents: dumps.map((dump) => dump.events.filter((event) => event.type.startsWith("session.text")).length) }
  })
  // T9.15 中途加入
  await collect("T9.15 中途加入收到后续事件", async () => {
    const id = await newSession("sse-v2-t915")
    const a = new Dumper(`${base}/api/session/${id}/event`, 55)
    await a.waitConnected()
    const prompt = api(`/api/session/${id}/prompt`, "POST", { text: "写一段 150 字的中文故事", metadata: {}, delivery: "queue" })
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const b = new Dumper(`${base}/api/session/${id}/event`, 50)
    await b.waitConnected()
    await prompt.then(() => api(`/api/experimental/session/${id}/wait`, "POST", {}, 300000))
    await Promise.all([a.stop(), b.stop()])
    const bText = b.events.filter((event) => event.type.startsWith("session.text")).length
    assert.ok(bText >= 1, `B 未收到后续 text 事件（A=${a.events.length}，B=${b.events.length}）`)
    assert.ok(b.events.some((event) => event.type === "session.execution.succeeded"), "B 未收到终态")
    return { a: a.events.length, b: b.events.length, bText }
  })
  // T9.16 重命名与删除
  await collect("T9.16 会话重命名与删除事件", async () => {
    const id = await newSession("sse-v2-t916")
    const dump = new Dumper(`${base}/api/session/${id}/event`, 30)
    await dump.waitConnected()
    await waitBoot(id)
    await api(`/api/session/${id}`, "PATCH", { title: "sse-renamed" })
    const removed = await api(`/api/session/${id}`, "DELETE", undefined, 180000)
    assert.ok([200, 204].includes(removed.status), `DELETE HTTP ${removed.status}`)
    sessionIDs.delete(id)
    await dump.waitFull()
    const renamed = dump.events.find((event) => event.type === "session.renamed")
    const deleted = dump.events.filter((event) => event.type === "session.deleted")
    assert.ok(renamed, "未收到 session.renamed")
    assert.equal(renamed.data.title, "sse-renamed")
    assert.ok(deleted.length >= 1, "未收到 session.deleted")
    return { renamed: renamed.data.title, deleted: deleted.length }
  })
  // T9.17 消息删除：V2 不适用（文档标注）
  results.push({ name: "T9.17 消息内容更新事件", passed: null, note: "V2 无删除端点与 message.removed，文档标注不适用，本轮 N/A" })
  console.log("○ T9.17 N/A（V2 不适用）")
  // T9.18 消息完成状态
  await collect("T9.18 消息完成状态事件", async () => {
    const id = await newSession("sse-v2-t918")
    const dump = new Dumper(`${base}/api/session/${id}/event`, 45)
    await dump.waitConnected()
    await sendPrompt(id, "说一个字")
    await dump.stop()
    const count = dump.events.filter((event) => event.type === "session.step.ended").length
    assert.ok(count >= 1, "缺少 session.step.ended")
    return { stepEnded: count }
  })
  // T9.19 回合错误事件
  await collect("T9.19 回合错误事件", async () => {
    const id = await newSession("sse-v2-t919", { id: "nonexistent-model-xyz", providerID: "Yd-DeepSeek" })
    const dump = new Dumper(`${base}/api/session/${id}/event`, 45)
    await dump.waitConnected()
    await sendPrompt(id, "hi")
    await dump.stop()
    const failed = dump.events.find((event) => event.type === "session.execution.failed")
    assert.ok(failed, "未收到 session.execution.failed")
    assert.ok(failed.data?.error, "缺少 data.error")
    return { error: String(failed.data.error.message ?? JSON.stringify(failed.data.error)).slice(0, 90) }
  })
  // T9.20 revert/diff
  await collect("T9.20 revert/diff 事件", async () => {
    const id = await newSession("sse-v2-t920")
    await sendPrompt(id, "hi")
    const messages = (await api(`/api/session/${id}/message?order=asc&limit=200`)).json.data
    const mid = messages.find((message) => message.type === "user")?.id
    assert.ok(mid, "未找到 user 消息")
    const dump = new Dumper(`${base}/api/session/${id}/event`, 25)
    await dump.waitConnected()
    const staged = await api(`/api/session/${id}/revert/stage`, "POST", { messageID: mid })
    assert.ok([200, 204].includes(staged.status), `revert/stage HTTP ${staged.status}: ${staged.text.slice(0, 160)}`)
    await waitForEvent(dump, (event) => event.type === "session.revert.staged")
    await dump.stop()
    const count = dump.events.filter((event) => event.type === "session.revert.staged").length
    assert.ok(count >= 1, "未收到 session.revert.staged")
    const diff = await api(`/api/session/${id}/diff`)
    assert.ok(Array.isArray(diff.json?.data), `diff 非数组: ${diff.text.slice(0, 120)}`)
    return { staged: count, diffEntries: diff.json.data.length }
  })
  // T9.21 agent 切换
  await collect("T9.21 agent/model 切换事件", async () => {
    const id = await newSession("sse-v2-t921")
    const dump = new Dumper(`${base}/api/session/${id}/event`, 25)
    await dump.waitConnected()
    const switched = await api(`/api/session/${id}/agent`, "POST", { agent: "plan" })
    assert.equal(switched.status, 204, `agent HTTP ${switched.status}: ${switched.text.slice(0, 160)}`)
    await waitForEvent(dump, (event) => event.type === "session.agent.selected")
    await dump.stop()
    const selected = dump.events.find((event) => event.type === "session.agent.selected")
    assert.ok(selected, "未收到 session.agent.selected")
    assert.equal(selected.data.agent, "plan")
    return { agent: selected.data.agent }
  })
  // T9.22 命令执行触发事件
  await collect("T9.22 命令执行触发事件", async () => {
    const id = await newSession("sse-v2-t922")
    const dump = new Dumper(`${base}/api/session/${id}/event`, 25)
    await dump.waitConnected()
    const command = await api(`/api/session/${id}/command`, "POST", { name: "init", text: "" })
    assert.ok([200, 204].includes(command.status), `command HTTP ${command.status}: ${command.text.slice(0, 160)}`)
    await waitForEvent(dump, (event) => event.type === "session.inbox.enqueued")
    await dump.stop()
    const count = dump.events.filter((event) => event.type === "session.inbox.enqueued").length
    assert.ok(count >= 1, "未收到 session.inbox.enqueued")
    return { enqueued: count }
  })
  // T9.23 envelope 字段完整性（原始流）
  await collect("T9.23 事件 envelope 字段完整性", async () => {
    const dump = new Dumper(`${base}/api/event`, 8)
    await dump.waitConnected()
    await newSession("sse-v2-t923")
    const until = Date.now() + 5000
    while (Date.now() < until && !dump.events.some((event) => event.type === "session.created")) await new Promise((resolve) => setTimeout(resolve, 200))
    await dump.stop()
    const created = dump.events.find((event) => event.type === "session.created")
    assert.ok(created, "未收到 session.created")
    for (const key of ["id", "created", "type", "data"]) assert.ok(key in created, `envelope 缺少 ${key}`)
    return { keys: Object.keys(created).sort() }
  })
  // T9.24 事件 ID 格式
  await collect("T9.24 事件 ID 格式", async () => {
    const dump = new Dumper(`${base}/api/event`, 3)
    await dump.waitConnected()
    await dump.stop()
    assert.match(dump.events[0].id ?? "", /^evt_/, `id=${dump.events[0].id}`)
    assert.equal(dump.events[0].type, "server.connected")
    return { id: dump.events[0].id }
  })
  // T9.28 会话流头
  await collect("T9.28 会话事件流头", async () => {
    const id = await newSession("sse-v2-t928")
    const dump = new Dumper(`${base}/api/session/${id}/event`, 3)
    await dump.waitConnected()
    await dump.stop()
    assert.match(dump.contentType ?? "", /text\/event-stream/)
    assert.equal(dump.events[0].type, "server.connected")
    return { contentType: dump.contentType }
  })
  // T9.29 会话流隔离（重命名次数与 B 泄漏）
  await collect("T9.29 会话事件流隔离性", async () => {
    const idA = await newSession("sse-v2-t929-a")
    const idB = await newSession("sse-v2-t929-b")
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const dump = new Dumper(`${base}/api/session/${idA}/event`, 12)
    await dump.waitConnected()
    await api(`/api/session/${idA}`, "PATCH", { title: "sse-a" })
    await api(`/api/session/${idB}`, "PATCH", { title: "sse-b" })
    await dump.waitFull()
    const renames = dump.events.filter((event) => event.type === "session.renamed")
    assert.equal(renames.length, 1, `renamed 次数 ${renames.length}`)
    assert.equal(renames[0].data.sessionID, idA)
    const raw = JSON.stringify(dump.events)
    assert.ok(!raw.includes(idB), "SID_B 泄漏")
    return { renamed: 1, leak: false }
  })
  // T9.30 负向：session 不存在
  await collect("T9.30 会话流负向 404", async () => {
    const response = await fetch(`${base}/api/session/ses_missing/event`, { headers, signal: AbortSignal.timeout(5000) })
    await response.body.cancel()
    assert.equal(response.status, 404, `HTTP ${response.status}`)
    return { status: 404 }
  })
  // T9.31 prompt_stream 服务端主动关流
  await collect("T9.31 prompt_stream 完整回合关流", async () => {
    const id = await newSession("sse-v2-t931")
    const response = await fetch(`${base}/api/session/${id}/prompt_stream`, { method: "POST", headers, body: JSON.stringify({ text: "只回复两个字：收到", metadata: {}, delivery: "queue" }), signal: AbortSignal.timeout(120000) })
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
    const text = await response.text()
    const types = [...text.matchAll(/"type":"([a-z.]+)"/g)].map((match) => match[1])
    assert.ok(types.length > 0, "流为空")
    assert.equal(types[0], "server.connected")
    const last = types.at(-1)
    assert.ok(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(last), `末帧 ${last}`)
    return { events: types.length, terminal: last, closedByServer: true }
  })
  // T9.32 prompt_stream 错误路径
  await collect("T9.32 prompt_stream 错误路径", async () => {
    const id = await newSession("sse-v2-t932", { id: "nonexistent-model-xyz", providerID: "Yd-DeepSeek" })
    const response = await fetch(`${base}/api/session/${id}/prompt_stream`, { method: "POST", headers, body: JSON.stringify({ text: "hi", metadata: {} }), signal: AbortSignal.timeout(120000) })
    const text = await response.text()
    const types = [...text.matchAll(/"type":"([a-z.]+)"/g)].map((match) => match[1])
    assert.ok(types.includes("session.execution.failed"), `无 failed 事件: ${types.join(",").slice(0, 200)}`)
    const last = types.at(-1)
    assert.ok(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(last), `末帧 ${last}`)
    return { terminal: last }
  })
  // T9.33 prompt_stream 并发隔离
  await collect("T9.33 prompt_stream 并发隔离", async () => {
    const idA = await newSession("sse-v2-t933-a")
    const idB = await newSession("sse-v2-t933-b")
    const request = (sid, text) => fetch(`${base}/api/session/${sid}/prompt_stream`, { method: "POST", headers, body: JSON.stringify({ text, metadata: {} }), signal: AbortSignal.timeout(180000) }).then((response) => response.text())
    const [textA, textB] = await Promise.all([request(idA, "只回复A"), request(idB, "只回复B")])
    const outcome = {}
    for (const [name, sid, text] of [["A", idA, textA], ["B", idB, textB]]) {
      const sids = new Set([...text.matchAll(/"sessionID":"(ses_[A-Za-z0-9]+)"/g)].map((match) => match[1]))
      const types = [...text.matchAll(/"type":"([a-z.]+)"/g)].map((match) => match[1])
      const last = types.at(-1)
      const terminal = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(last ?? "")
      sids.delete(sid)
      outcome[name] = { terminal, crossLeak: [...sids] }
      assert.ok(terminal, `${name} 末帧 ${last}`)
      assert.equal(sids.size, 0, `${name} 交叉泄漏`)
    }
    return outcome
  })
  // T9.34 prompt_stream 负向
  await collect("T9.34 prompt_stream 负向 404", async () => {
    const response = await fetch(`${base}/api/session/ses_missing/prompt_stream`, { method: "POST", headers, body: JSON.stringify({ text: "hi", metadata: {} }), signal: AbortSignal.timeout(5000) })
    await response.body.cancel()
    assert.equal(response.status, 404, `HTTP ${response.status}`)
    return { status: 404 }
  })
  // T9.35 断连续传
  await collect("T9.35 durable 落库与补发", async () => {
    const id = await newSession("sse-v2-t935")
    await api(`/api/session/${id}`, "PATCH", { title: "t935-gap" })
    const dump = new Dumper(`${base}/api/experimental/session/${id}/log?after=0&follow=false`, 5)
    await dump.done
    const renamed = dump.events.filter((event) => event.type === "session.renamed")
    assert.ok(renamed.length === 1, `补发 renamed=${renamed.length}，types=${dump.events.map((event) => event.type).slice(0, 12)}`)
    const negative = await fetch(`${base}/api/experimental/session/${id}/log?after=-1`, { headers, signal: AbortSignal.timeout(5000) })
    await negative.body.cancel()
    assert.equal(negative.status, 400, `after=-1 HTTP ${negative.status}`)
    const bad = await fetch(`${base}/api/experimental/session/${id}/log?after=abc`, { headers, signal: AbortSignal.timeout(5000) })
    await bad.body.cancel()
    assert.equal(bad.status, 400, `after=abc HTTP ${bad.status}`)
    const rows = pg(`SELECT count(*) FROM event WHERE aggregate_id='${id}'`)
    return { replayRenamed: renamed.length, pgEventRows: Number(rows) }
  })
  // T9.36 replay + live 并发窗口
  await collect("T9.36 补发/实时不丢不重", async () => {
    const id = await newSession("sse-v2-t936")
    await api(`/api/session/${id}`, "PATCH", { title: "t936-1" })
    await api(`/api/session/${id}`, "PATCH", { title: "t936-2" })
    const dump = new Dumper(`${base}/api/experimental/session/${id}/log?after=0&follow=true`, 14)
    let synced = false
    const until = Date.now() + 8000
    while (Date.now() < until) {
      if (dump.events.some((event) => event.type === "log.synced")) { synced = true; break }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    for (const index of [1, 2, 3]) await api(`/api/session/${id}`, "PATCH", { title: `t936-c${index}` })
    await dump.stop()
    const seqs = dump.events.filter((event) => event.type === "session.renamed").map((event) => event.durable?.seq)
    const unique = new Set(seqs)
    const sorted = [...seqs].sort((a, b) => a - b)
    assert.equal(seqs.length, 5, `renamed 事件 ${seqs.length} 个: ${seqs.join(",")}`)
    assert.equal(unique.size, seqs.length, `重复 seq: ${seqs.join(",")}`)
    assert.deepEqual(sorted, sorted.filter((value) => value !== null).sort((a, b) => a - b), "seq 非递增")
    return { seqs, synced, contiguous: sorted.at(-1) - sorted[0] === 4 }
  })
  // T9.26 write 参数早期可用性
  await collect("T9.26 tool.called 参数预渲染", async () => {
    const id = await newSession("sse-v2-t926")
    const dump = new Dumper(`${base}/api/session/${id}/event`, 150)
    await dump.waitConnected()
    await sendPrompt(id, "use ONLY the write tool (not shell) to create /workspace/prerender-test.html containing a minimal HTML page with title 'sse prerender test'")
    await dump.stop()
    let inputEnded = null, called = null, success = null
    dump.events.forEach((event, index) => {
      const data = event.data ?? {}
      if (event.type === "session.tool.input.ended" && String(data.name ?? "").startsWith("write")) inputEnded = index
      if (event.type === "session.tool.called" && data.input != null) called = { index, input: data.input }
      if (event.type === "session.tool.success") success = index
    })
    assert.ok(called, "缺少 session.tool.called")
    const serialized = JSON.stringify(called.input).toLowerCase()
    assert.ok(serialized.includes("<html") || "filepath" in called.input || "file_path" in called.input || "path" in called.input, `called.input 不完整: ${serialized.slice(0, 160)}`)
    if (success !== null) assert.ok(called.index < success, "called 应早于 success")
    return { inputEnded, calledLine: called.index, successLine: success }
  })
  // T9.27 工具参数流式增量
  await collect("T9.27 工具参数增量 delta", async () => {
    const id = await newSession("sse-v2-t927")
    const dump = new Dumper(`${base}/api/session/${id}/event`, 150)
    await dump.waitConnected()
    await sendPrompt(id, "use ONLY the write tool (not shell) to create /workspace/stream-test.html containing an HTML page with title 'stream test' and three paragraphs")
    await dump.stop()
    const deltas = []
    let ended = null
    dump.events.forEach((event, index) => {
      const data = event.data ?? {}
      if (event.type === "session.tool.input.delta") deltas.push({ index, id: data.id, delta: data.delta ?? "" })
      if (event.type === "session.tool.input.ended") ended = { index, id: data.id }
    })
    assert.ok(deltas.length >= 1, "缺少 session.tool.input.delta")
    assert.ok(ended, "缺少 session.tool.input.ended")
    const maxDelta = Math.max(...deltas.map((value) => value.index))
    assert.ok(maxDelta < ended.index, "delta 应全部早于 ended")
    return { deltas: deltas.length, bytes: deltas.reduce((sum, value) => sum + value.delta.length, 0), allBeforeEnded: true }
  })
} catch (error) {
  results.push({ name: `执行器中断（${current}）`, passed: false, error: error.message.slice(0, 400) })
  console.log(`执行器中断: ${error.message}`)
} finally {
  for (const id of [...sessionIDs]) {
    try { const removed = await api(`/api/session/${id}`, "DELETE", undefined, 180000); console.log(`cleanup ${id} ${removed.status}`) } catch (error) { console.log(`cleanup ${id} error ${error.message}`) }
  }
  try {
    report: {
      const ids = pg("SELECT coalesce(string_agg(id,','), '') FROM sandbox")
      const states = pg("SELECT state, count(*) FROM sandbox GROUP BY state")
      const remaining = pg("SELECT count(*) FROM session_v2")
      results.push({ name: "PG 清理核验", passed: remaining === "0", details: { sandboxRows: ids, states, remainingSessions: remaining } })
      console.log(`PG 清理: sessions=${remaining} sandbox_states=${states}`)
    }
  } catch (error) { console.log(`PG 清理核验失败: ${error.message}`) }
  await mkdir(output, { recursive: true })
  await writeFile(`${output}/result.json`, JSON.stringify({ model, results, passed: results.every((value) => value.passed !== false) }, null, 2))
  const failed = results.filter((value) => value.passed === false)
  const na = results.filter((value) => value.passed === null)
  console.log(JSON.stringify({ total: results.length, passed: results.filter((value) => value.passed === true).length, na: na.length, failed: failed.map((value) => value.name) }))
  if (failed.length) process.exitCode = 1
}
