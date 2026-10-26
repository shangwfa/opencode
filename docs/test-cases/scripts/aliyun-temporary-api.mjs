import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"

assert.ok(process.env.PG_URL?.endsWith("-test"))
const base = process.env.BASE
const headers = { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`, "content-type": "application/json" }
const report = { events: [] }
const controller = new AbortController()
let id
let watching
const api = (path, init = {}) => fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(180000) })
try {
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await api("/api/info")).ok) { ready = true; break } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert.ok(ready, "Docker SaaS did not become ready")
  const response = await api("/api/session", { method: "POST", body: JSON.stringify({ title: "aliyun-default-temporary" }) })
  assert.equal(response.status, 200)
  id = (await response.json()).data.id
  report.sessionID = id
  const stream = await fetch(`${base}/api/session/${id}/event`, { headers, signal: controller.signal })
  assert.equal(stream.status, 200)
  watching = (async () => {
    let buffer = ""
    for await (const bytes of stream.body) {
      buffer += new TextDecoder().decode(bytes)
      let end
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!line.startsWith("data:")) continue
        const event = JSON.parse(line.slice(5))
        report.events.push(event)
        if (/shell\.(started|ended)/.test(event.type)) console.log(`公共 SSE ${event.type}`)
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) report.streamError = error.message })
  for (const command of ["printf ALIYUN-TEMPORARY > /workspace/temporary.txt", "cat /workspace/temporary.txt"]) {
    const response = await api(`/api/session/${id}/shell`, { method: "POST", body: JSON.stringify({ command }) })
    assert.equal(response.status, 204)
  }
  const listed = await api(`/api/session/${id}/message?order=asc&limit=200`)
  assert.equal(listed.status, 200)
  const shells = (await listed.json()).data.filter((message) => message.type === "shell")
  assert.equal(shells.length, 2)
  assert.ok(shells.every((message) => message.exit === 0))
  assert.equal(shells[1].output.output, "ALIYUN-TEMPORARY")
  const query = `SELECT json_build_object('provider',provider,'state',state,'remote',remote_name,'keepAlive',keep_alive)::text FROM sandbox WHERE session_id='${id}'`
  report.binding = JSON.parse(execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", query], { encoding: "utf8" }).trim())
  assert.equal(report.binding.provider, "aliyun")
  assert.equal(report.binding.state, "running")
  assert.equal(report.binding.keepAlive, 1)
  report.passed = true
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  if (id) {
    const removed = await api(`/api/session/${id}`, { method: "DELETE" })
    report.cleanupHTTP = removed.status
    if (removed.status !== 204) { report.passed = false; process.exitCode = 1 }
  }
  controller.abort()
  await watching
  await mkdir(process.env.STRESS_OUT, { recursive: true })
  await writeFile(`${process.env.STRESS_OUT}/result.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, error: report.error, binding: report.binding, cleanupHTTP: report.cleanupHTTP }))
}
