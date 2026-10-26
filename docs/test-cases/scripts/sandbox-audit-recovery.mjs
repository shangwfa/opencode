// 真实 API + PG 故障注入；仅用于专用测试库，原生 SDK 只用于模拟云端实例消失。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"

assert.ok(process.env.PG_URL?.endsWith("-sandbox-audit-lifecycle-test"), "必须使用专用测试库")
const base = process.env.BASE ?? "http://127.0.0.1:15140"
const container = process.env.CONTAINER ?? "opencode-sandbox-audit-fix"
const out = process.env.STRESS_OUT ?? "artifacts/sandbox-audit-fix-20261026"
const headers = { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`, "content-type": "application/json" }
const report = { passed: false, cases: [], events: [], cleanup: [], codeMode: "配置 sandbox executor；本用例只测生命周期及 shell API，不包含模型轮次" }
const sessions = []
const streams = []
const pg = (query) => execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }).trim()
const binding = (id) => JSON.parse(pg(`SELECT json_build_object('id',id,'remote',remote_name,'state',state)::text FROM sandbox WHERE session_id='${id}'`))
const api = async (path, method = "GET", body) => {
  const response = await fetch(base + path, { headers, method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) })
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${(response.ok ? "" : await response.text()).slice(0, 500)}`)
  return response.status === 204 ? null : response.json()
}
const record = (name, detail) => { report.cases.push({ name, passed: true, ...detail }); console.log(`✓ ${name}`) }
async function create(title) {
  const id = (await api("/api/session", "POST", { title, sandbox: { persistMode: "snapshot", cpu: "2", memory: "2Gi", image: "base-5wa5" } })).data.id
  sessions.push(id)
  await mkdir(out, { recursive: true })
  await writeFile(`${out}/session.json`, JSON.stringify({ id }))
  const controller = new AbortController()
  const response = await fetch(`${base}/api/session/${id}/event`, { headers, signal: controller.signal })
  assert.equal(response.status, 200)
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
        report.events.push({ sessionID: id, ...event })
        if (!/delta|streamed|usage/.test(event.type)) console.log(`SSE ${id} ${event.type}`)
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) report.streamError = error.message })
  streams.push({ controller, done })
  return id
}
async function shell(id, command, expected) {
  await api(`/api/session/${id}/shell`, "POST", { command })
  const messages = (await api(`/api/session/${id}/message?order=asc&limit=100`)).data
  const result = messages.filter((message) => message.type === "shell").at(-1)
  assert.equal(result?.exit, 0, JSON.stringify(result))
  if (expected) assert.ok(result.output.output.includes(expected), JSON.stringify(result.output))
}
function killRemote(remote) {
  assert.match(remote, /^sbx-[a-zA-Z0-9-]+$/)
  execFileSync("docker", ["exec", "-w", "/app/packages/core", container, "bun", "-e",
    `const {Sandbox}=await import("e2b");const killed=await Sandbox.kill(${JSON.stringify(remote)},{apiKey:process.env.OPENCODE_ALIYUN_API_KEY,apiUrl:process.env.OPENCODE_ALIYUN_API_URL,domain:process.env.OPENCODE_ALIYUN_DOMAIN});if(!killed)throw new Error("实例未被删除")`], { stdio: "pipe" })
}
try {
  const id = await create("sandbox-audit-recovery")
  const marker = `audit-${Date.now()}`
  await shell(id, `printf '%s' '${marker}' > /workspace/audit-marker.txt; cat /workspace/audit-marker.txt`, marker)
  const original = binding(id)
  const saved = (await api(`/api/session/${id}/snapshot`, "POST", {})).data
  // 模拟云端已确认快照后进程崩溃；待恢复的操作必须保持 capture-only 语义。
  pg(`UPDATE sandbox SET state='snapshotting',time_updated=0,command_session_id='capture:oc-crashed:${saved.snapshotID}' WHERE session_id='${id}'`)
  const until = Date.now() + 60000
  while (binding(id).state !== "running") {
    assert.ok(Date.now() < until, "后台未完成 capture-only 恢复")
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert.equal(binding(id).id, original.id)
  await shell(id, "cat /workspace/audit-marker.txt", marker)
  record("仅快照崩溃恢复不停止源实例", { generation: original.id })

  killRemote(original.remote)
  await shell(id, "cat /workspace/audit-marker.txt", marker)
  const restored = binding(id)
  assert.notEqual(restored.id, original.id)
  record("实例消失后从已确认快照恢复文件与新代次", { before: original.id, after: restored.id })

  pg(`INSERT INTO sandbox_command (id,session_id,sandbox_id,command_id,operation_id,time_created,time_updated) VALUES ('audit-orphan-${id}','${id}','${restored.id}','2147483647','audit-orphan',0,0)`)
  await api(`/api/session/${id}/snapshot`, "POST", {})
  assert.equal(pg(`SELECT count(*) FROM sandbox_command WHERE session_id='${id}'`), "0")
  assert.equal(binding(id).state, "running")
  record("新副本视角的孤儿命令终态对账后可继续快照", {})

  const lost = await create("sandbox-audit-no-checkpoint")
  await shell(lost, "echo no-checkpoint", "no-checkpoint")
  const before = binding(lost)
  killRemote(before.remote)
  await api(`/api/session/${lost}/shell`, "POST", { command: "echo must-not-run" })
  const failed = (await api(`/api/session/${lost}/message?order=asc&limit=100`)).data.filter((message) => message.type === "shell").at(-1)
  assert.notEqual(failed?.exit, 0)
  assert.ok(failed?.output?.output.includes("refusing an empty workspace"), JSON.stringify(failed))
  const after = binding(lost)
  assert.equal(after.id, before.id)
  assert.equal(after.state, "destroyed")
  assert.ok(after.remote.startsWith("lost:"))
  await api(`/api/session/${lost}`, "DELETE")
  record("无恢复点保留丢失标记、拒绝空工作区且允许显式删除", { generation: before.id })
  report.passed = true
} catch (error) { report.error = error.message; console.error(`✗ ${error.message}`) }
finally {
  for (const id of sessions) {
    try {
      const response = await fetch(`${base}/api/session/${id}`, { headers, method: "DELETE", signal: AbortSignal.timeout(180000) })
      assert.ok(response.ok || response.status === 404, `清理 HTTP ${response.status}`)
      report.cleanup.push({ id, status: response.status })
    } catch (error) { report.cleanup.push({ id, error: error.message }); report.passed = false }
  }
  for (const stream of streams) stream.controller.abort()
  await Promise.all(streams.map((stream) => stream.done))
  report.remaining = JSON.parse(pg("SELECT json_build_object('sessions',(SELECT count(*) FROM session_v2),'commands',(SELECT count(*) FROM sandbox_command),'snapshots',(SELECT count(*) FROM aliyun_snapshot))::text"))
  if (Object.values(report.remaining).some((value) => value !== 0) || report.streamError) report.passed = false
  await mkdir(out, { recursive: true })
  await writeFile(`${out}/result.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, remaining: report.remaining, error: report.error }))
}
if (!report.passed) process.exitCode = 1
