// Complements sandbox-idle-reap-v2: false/true preferences, killed rows and fresh activity.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"

assert.ok(process.env.PG_URL?.endsWith("-lifecycle-test"), "需要独立生命周期测试库")
const base = process.env.BASE
const headers = { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`, "content-type": "application/json" }
const report = { cases: [], events: [], cleanup: [], codeMode: "shell API 用例，不包含模型轮次" }
const sessions = []
const streams = []
const pg = (query) => execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }).trim()
const api = async (path, method = "GET", body) => {
  const r = await fetch(base + path, { headers, method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) })
  assert.ok(r.ok, `${method} ${path} HTTP ${r.status}`)
  return r.status === 204 ? null : r.json()
}
async function create(name, keepAlive) {
  const snapshot = name === "unkept-stale"
  const marker = `idle-snapshot-${Date.now()}`
  const id = (await api("/api/session", "POST", { title: `aliyun-idle-extra-${name}`,
    ...(snapshot ? { sandbox: { persistMode: "snapshot", cpu: "2", memory: "2Gi", image: "base-5wa5" } } : {}),
  })).data.id
  sessions.push(id)
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
        if (/shell|sandbox/.test(event.type)) console.log(`公共 SSE ${name} ${event.type}`)
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) report.streamError = error.message })
  streams.push({ controller, done })
  if (keepAlive) await api(`/api/experimental/session/${id}/keep-alive`, "POST", { enabled: true, boot: true })
  await api(`/api/session/${id}/shell`, "POST", { command: snapshot
    ? `printf '%s' '${marker}' >/workspace/idle-reap-marker.txt; cat /workspace/idle-reap-marker.txt`
    : `echo idle-extra-${name}` })
  const shells = (await api(`/api/session/${id}/message?order=asc&limit=100`)).data.filter((message) => message.type === "shell")
  assert.equal(shells.at(-1)?.exit, 0)
  const before = JSON.parse(pg(`SELECT json_build_object('id',id,'remote',remote_name,'state',state,'keepAlive',keep_alive)::text FROM sandbox WHERE session_id='${id}'`))
  assert.equal(before.state, "running")
  return { name, id, before, ...(snapshot ? { marker } : {}) }
}
try {
  const values = []
  for (const [name, kept] of [["unkept-stale", false], ["kept-stale", true], ["killed-stale", false], ["fresh", false]]) values.push(await create(name, kept))
  for (const value of values) {
    if (value.name === "fresh") continue
    pg(`UPDATE sandbox SET time_updated=0${value.name === "killed-stale" ? ",state='killed'" : ""} WHERE session_id='${value.id}'`)
  }
  const started = Date.now()
  console.log("空闲补测 ▶ 等待 45 秒，覆盖阿里云至少两次 15 秒扫描")
  await new Promise((resolve) => setTimeout(resolve, 45000))
  for (const value of values) {
    const after = JSON.parse(pg(`SELECT json_build_object('id',id,'state',state,'keepAlive',keep_alive,'timeUpdated',time_updated,'remote',remote_name)::text FROM sandbox WHERE session_id='${value.id}'`))
    const expected = value.name === "fresh" ? "running" : "destroyed"
    const passed = after.state === expected && after.keepAlive === value.before.keepAlive && (expected !== "destroyed" || after.remote === null)
    report.cases.push({ ...value, after, expected, passed, waitedMs: Date.now() - started })
    console.log(`${passed ? "✓ PASS" : "✗ FAIL"} ${value.name}: ${after.state}, keepAlive=${after.keepAlive}（预期 ${expected}）`)
  }
  const retained = values.find((value) => value.marker)
  assert.ok(retained)
  const saved = (await api(`/api/session/${retained.id}/snapshot`)).data
  assert.equal(saved.state, "ready")
  await api(`/api/session/${retained.id}/shell`, "POST", { command: "cat /workspace/idle-reap-marker.txt" })
  const restored = (await api(`/api/session/${retained.id}/message?order=asc&limit=100`)).data.filter((message) => message.type === "shell").at(-1)
  assert.equal(restored.exit, 0)
  assert.equal(restored.output.output.trim(), retained.marker)
  const current = JSON.parse(pg(`SELECT json_build_object('id',id,'state',state,'remote',remote_name)::text FROM sandbox WHERE session_id='${retained.id}'`))
  assert.notEqual(current.id, retained.before.id)
  assert.equal(current.state, "running")
  assert.equal((await api(`/api/session/${retained.id}/snapshot`)).data.restoredCount, 1)
  report.cases.push({ name: "idle snapshot restores the real marker in a new generation", passed: true, snapshot: saved, current })
  console.log("✓ PASS idle snapshot: 回收前已保存，恢复后文件内容与新 generation 核验通过")
  report.passed = report.cases.every((value) => value.passed)
} catch (error) { report.error = error.message; report.passed = false }
finally {
  for (const id of sessions) {
    try { await api(`/api/session/${id}`, "DELETE"); report.cleanup.push({ id, state: pg(`SELECT state FROM sandbox WHERE session_id='${id}'`) }) }
    catch (error) { report.cleanup.push({ id, error: error.message }); report.passed = false }
  }
  for (const stream of streams) stream.controller.abort()
  await Promise.allSettled(streams.map((stream) => stream.done))
  await mkdir(process.env.STRESS_OUT, { recursive: true })
  await writeFile(`${process.env.STRESS_OUT}/result.json`, JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
}
