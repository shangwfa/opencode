// 双 Pod + PG 的确定性 /command 验收；模型探针通过门闩控制在途请求，不依赖真实模型延迟。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"

const bases = [process.env.BASE, process.env.BASE_SECONDARY]
const pg = process.env.PG_URL
assert.ok(bases.every(Boolean), "需要 BASE 和 BASE_SECONDARY")
assert.ok(pg && new URL(pg).pathname.endsWith("-test"), "必须使用专用测试 PG")
const out = process.env.QUEUE_OUT ?? "artifacts/queue-dispatch-20261027/http"
mkdirSync(out, { recursive: true })
const headers = {
  authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`,
  "content-type": "application/json",
}
const model = { providerID: "queue-probe", id: "probe" }
const sessions = []
const events = []
const requests = []
const results = []
const gates = new Map()
const watchers = []
let hold
let executeSent = false

const save = (name, value) => writeFileSync(`${out}/${name}.json`, JSON.stringify(value, null, 2))
const quote = (value) => `'${value.replaceAll("'", "''")}'`
const query = (statement) => execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", statement], { encoding: "utf8" }).trim()
// PG 桥把 JSON 列存为文本，读回时需要逐行解码，否则断言会读到字符串而不是对象。
const rows = (table, id) =>
  JSON.parse(query(`SELECT COALESCE(json_agg(t), '[]') FROM (SELECT * FROM ${table} WHERE session_id=${quote(id)}) t`))
    .map((row) => ({ ...row, data: typeof row.data === "string" ? JSON.parse(row.data) : row.data }))
const waitFor = async (fn, label, budget = 30_000) => {
  const end = Date.now() + budget
  do {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < end)
  throw new Error(`等待超时：${label}`)
}
const api = async (pod, method, path, body) => {
  const response = await fetch(`${bases[pod]}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  })
  const text = response.status === 204 ? "" : await response.text()
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${text.slice(0, 600)}`)
  return text ? JSON.parse(text) : undefined
}
const mock = Bun.serve({
  hostname: "0.0.0.0", port: Number(process.env.QUEUE_MODEL_PORT ?? 18194),
  async fetch(request) {
    try {
      const body = await request.json()
      const index = requests.push(body)
      const user = body.messages?.filter((message) => message.role === "user").at(-1)
      const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "")
      const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: `queue-${index}`, object: "chat.completion.chunk", model: "probe", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      return new Response(new ReadableStream({
        async start(controller) {
          try {
            controller.enqueue(new TextEncoder().encode(chunk({ role: "assistant", reasoning_content: "验证排队调度时序。" })))
            if (hold && text.includes(hold)) {
              const marker = hold
              hold = undefined
              await new Promise((resolve) => gates.set(marker, resolve))
            }
            const tool = text.includes("QUEUE_CODEMODE_PROBE") && !executeSent
            if (tool) {
              executeSent = true
              controller.enqueue(new TextEncoder().encode(chunk({ tool_calls: [{ index: 0, id: "queue-execute", type: "function", function: { name: "execute", arguments: JSON.stringify({ code: "return 1024" }) } }] })))
            } else controller.enqueue(new TextEncoder().encode(chunk({ content: `QUEUE_OK_${index}` })))
            controller.enqueue(new TextEncoder().encode(chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n"))
            controller.close()
          } catch (error) { controller.error(error) }
        },
      }), { headers: { "content-type": "text/event-stream" } })
    } catch (error) { return new Response(String(error), { status: 500 }) }
  },
})

async function watch(id, pod) {
  const abort = new AbortController()
  const response = await fetch(`${bases[pod]}/api/session/${id}/event`, { headers, signal: abort.signal })
  assert.equal(response.status, 200)
  let ready
  const connected = new Promise((resolve) => { ready = resolve })
  const task = (async () => {
    let buffer = ""
    const decoder = new TextDecoder()
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true })
      let end
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
        if (!data) continue
        const event = JSON.parse(data)
        // 公共事件自带 id（evt_…），会话标识另存，避免被展开覆盖。
        events.push({ pod, sessionID: id, type: event.type, data: event.data })
        if (event.type === "server.connected") ready()
        if (/session\.(execution\.|text.ended|reasoning.ended|tool\.)|form\./.test(event.type) && !event.type.endsWith(".delta"))
          console.log(`SSE Pod${pod} ${id} ${event.type} ${String(event.data?.text ?? event.data?.name ?? event.data?.reason ?? "").slice(0, 140)}`)
        if (event.type === "form.created") throw new Error("确定性模型不应请求表单")
      }
    }
  })().catch((error) => { if (!abort.signal.aborted) throw error })
  // 立即注册拒绝处理，最终仍由 finally 检查订阅是否失败。
  task.catch(() => {})
  watchers.push({ abort, task })
  await Promise.race([connected, task.then(() => { throw new Error("SSE 在 connected 前退出") })])
}
async function create(name) {
  const session = await api(0, "POST", "/api/session", { title: `queue-http-${name}`, model, location: { directory: "/workspace" } })
  const id = session.data.id
  sessions.push(id)
  await Promise.all([watch(id, 0), watch(id, 1)])
  save("sessions", sessions)
  await api(0, "POST", `/api/session/${id}/commands`, { name: "queue-check", template: "QUEUE_COMMAND_$ARGUMENTS" })
  return id
}
const command = (id, pod, marker) => api(pod, "POST", `/api/session/${id}/command`, { name: "queue-check", text: marker, delivery: "queue" })
const release = (marker) => { const resolve = gates.get(marker); assert.ok(resolve, `缺少门闩 ${marker}`); gates.delete(marker); resolve() }
const stops = (id) => rows("session_message", id).filter((message) => message.type === "assistant" && message.data.finish === "stop").length
const completed = (id, count) => waitFor(() => stops(id) >= count && rows("session_inbox", id).length === 0 && rows("session_execution_lease", id).length === 0, `${id} 至少完成 ${count} 次回答且幂等收尾`)
const verifyCommand = async (id, marker) => {
  const messages = rows("session_message", id)
  assert.equal(messages.filter((message) => message.type === "user" && message.data.text === `QUEUE_COMMAND_${marker}`).length, 1, "命令展开且仅投递一次")
  assert.equal(rows("session_inbox", id).length, 0, "收件箱应清空")
  // 终态事件与行落库存在毫秒级竞态：以有界等待取代瞬时断言。
  await waitFor(() => events.some((event) => event.sessionID === id && event.type === "session.execution.succeeded"), "公共 SSE 观察到执行成功", 15_000)
  save(id, { messages, inbox: rows("session_inbox", id), leases: rows("session_execution_lease", id) })
}

let passed = false
try {
  for (const pod of [0, 1]) {
    const id = await create(`idle-${pod}`)
    await api(0, "POST", `/api/session/${id}/shell`, { command: "echo QUEUE_SHELL_NOTICE", timeoutSeconds: 30 })
    const shell = rows("session_message", id).find((message) => message.type === "shell")
    assert.ok(shell && shell.data.status === "exited" && shell.data.exit === 0, "真实 shell 必须成功，不能把启动失败通知当成成功通知")
    const pending = rows("session_inbox", id)
    assert.equal(pending.length, 1, "真实 shell 通知应留在收件箱")
    assert.equal(pending[0].delivery, "steer")
    await command(id, pod, `IDLE_${pod}`)
    await completed(id, 2)
    await verifyCommand(id, `IDLE_${pod}`)
    results.push({ name: `真实 shell 通知后 Pod${pod} 执行 queue 命令`, passed: true })
    save("checks", results)
  }

  {
    const id = await create("active-cross-pod")
    hold = "QUEUE_HOLD_ACTIVE"
    await api(0, "POST", `/api/session/${id}/prompt`, { text: hold, model })
    await waitFor(() => gates.has("QUEUE_HOLD_ACTIVE"), "Pod A 的模型请求进入门闩")
    const lease = rows("session_execution_lease", id)
    assert.equal(lease.length, 1)
    await command(id, 1, "CROSS_POD")
    assert.ok(rows("session_inbox", id).some((row) => row.delivery === "queue"))
    assert.equal(rows("session_execution_lease", id)[0].owner_id, lease[0].owner_id)
    release("QUEUE_HOLD_ACTIVE")
    await completed(id, 2)
    await verifyCommand(id, "CROSS_POD")
    results.push({ name: "Pod A 执行中由 Pod B 入队，原执行者收敛后消费且不重复", passed: true })
    save("checks", results)
  }

  {
    const id = await create("interrupt")
    hold = "QUEUE_HOLD_INTERRUPT"
    await api(0, "POST", `/api/session/${id}/prompt`, { text: hold, model })
    await waitFor(() => gates.has("QUEUE_HOLD_INTERRUPT"), "中断用例模型进入门闩")
    await command(id, 1, "AFTER_STOP")
    const interrupted = await api(0, "POST", `/api/session/${id}/interrupt`)
    assert.equal(interrupted.data?.interrupted ?? interrupted.interrupted, true)
    await waitFor(() => rows("session_execution_lease", id).length === 0, "用户中断完成并释放租约")
    const count = requests.length
    release("QUEUE_HOLD_INTERRUPT")
    // 这里只验证有界静默；不把有限观察宣称为“永不重启”。
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert.equal(requests.length, count)
    assert.ok(rows("session_inbox", id).some((row) => row.delivery === "queue"))
    save(`${id}-parked`, { messages: rows("session_message", id), inbox: rows("session_inbox", id) })
    const beforeWake = stops(id)
    await command(id, 1, "EXPLICIT_WAKE")
    await completed(id, beforeWake + 2)
    await verifyCommand(id, "AFTER_STOP")
    await verifyCommand(id, "EXPLICIT_WAKE")
    results.push({ name: "跨 Pod 入队后用户停止，queue 保留，显式新命令才恢复", passed: true })
    save("checks", results)
  }

  {
    const id = await create("codemode")
    await api(0, "POST", `/api/session/${id}/prompt`, { text: "QUEUE_CODEMODE_PROBE", model })
    await completed(id, 1)
    const messages = rows("session_message", id)
    const tools = messages.flatMap((message) => message.data.content ?? []).filter((part) => part.type === "tool")
    assert.ok(tools.some((part) => part.name === "execute" && part.state?.status === "completed" && JSON.stringify(part).includes("1024")), "Code Mode execute 必须在沙箱实际完成")
    assert.equal(query(`SELECT count(*) FROM sandbox WHERE session_id=${quote(id)} AND provider='opensandbox'`), "1")
    save(id, { messages, tools })
    results.push({ name: "Code Mode 默认开启且 execute 在真实会话沙箱返回 1024", passed: true })
  }
  passed = true
} catch (error) {
  console.error(error.stack)
  save("failure", { message: String(error), stack: error.stack })
  process.exitCode = 1
} finally {
  for (const resolve of gates.values()) resolve()
  gates.clear()
  save("requests", requests)
  save("events", events)
  const cleanup = []
  for (const id of sessions) {
    try { await api(0, "DELETE", `/api/session/${id}`); cleanup.push({ id, deleted: true }) }
    catch (error) { cleanup.push({ id, error: String(error) }); passed = false; process.exitCode = 1 }
  }
  for (const watcher of watchers) watcher.abort.abort()
  const exits = await Promise.allSettled(watchers.map((watcher) => watcher.task))
  if (exits.some((exit) => exit.status === "rejected")) { passed = false; process.exitCode = 1 }
  mock.stop(true)
  save("result", { passed, results, cleanup, subscriptions: exits.map((exit) => exit.status) })
  console.log(JSON.stringify({ passed, results, cleanup }))
}
