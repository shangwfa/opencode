import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"

assert.ok(process.env.PG_URL?.endsWith("-test"), "必须使用专用测试 PG")
const bases = [process.env.BASE, process.env.BASE_SECOND]
assert.ok(bases.every(Boolean), "需要两个 Docker SaaS 地址")
const headers = { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`, "content-type": "application/json" }
const report = { events: [], bindings: [], codeMode: "本用例使用 shell API，不含模型轮次" }
const streams = []
let id
const api = async (index, path, method = "GET", body) => {
  const response = await fetch(bases[index] + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path === "/api/info" ? 5000 : 360000) })
  assert.ok(response.ok, `${method} ${path} HTTP ${response.status}: ${response.ok ? "" : await response.text()}`)
  return response.status === 204 ? null : response.json()
}
const pg = (query) => execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", query], { encoding: "utf8" }).trim()
const binding = () => {
  const value = JSON.parse(pg(`SELECT json_build_object('id',id,'provider',provider,'remote',remote_name,'state',state)::text FROM sandbox WHERE session_id='${id}'`))
  report.bindings.push(value)
  return value
}
async function watch(index) {
  const controller = new AbortController()
  const response = await fetch(`${bases[index]}/api/session/${id}/event`, { headers, signal: controller.signal })
  assert.equal(response.status, 200)
  const done = (async () => {
    let buffer = ""
    const decoder = new TextDecoder()
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true })
      let end
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!line.startsWith("data:")) continue
        const event = JSON.parse(line.slice(5))
        report.events.push(event)
        if (!/delta|streamed|usage/.test(event.type)) console.log(`公共 SSE ${event.type}`)
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) throw error })
  streams.push({ controller, done })
}
async function shell(index, command, expected) {
  await api(index, `/api/session/${id}/shell`, "POST", { command })
  const messages = (await api(index, `/api/session/${id}/message?order=asc&limit=200`)).data
  const result = messages.filter((message) => message.type === "shell").at(-1)
  assert.equal(result.exit, 0)
  if (expected !== undefined) assert.equal(result.output.output.trim(), expected)
}
async function model(index, marker) {
  console.log(`模型验收 ▶ ${marker}`)
  const forms = setInterval(async () => {
    try {
      const forms = (await api(index, `/api/session/${id}/form`)).data ?? []
      for (const form of forms) {
        if (form.fields?.some((field) => field.type === "external")) continue
        const answer = Object.fromEntries((form.fields ?? []).map((field) => [field.key,
          field.type === "boolean" ? true : ["number", "integer"].includes(field.type) ? field.default ?? field.minimum ?? 1
            : field.type === "multiselect" ? [field.options?.[0]?.value ?? field.default?.[0]].filter(Boolean)
              : field.options?.[0]?.value ?? field.default ?? "按推荐方案继续",
        ]))
        await api(index, `/api/session/${id}/form/${form.id}/reply`, "POST", { answer })
      }
    } catch {}
  }, 1500)
  try {
    const response = await fetch(`${bases[index]}/api/session/${id}/prompt_stream`, { method: "POST", headers,
      body: JSON.stringify({ model: { providerID: "deepseek", id: "deepseek-flash" }, text: `请调用 execute 工具执行代码 return 2 ** 10，然后将数字和标记 ${marker} 作为最终回复。` }), signal: AbortSignal.timeout(300000) })
    assert.equal(response.status, 200)
    const text = await response.text()
    const events = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
    assert.ok(events.some((event) => event.type === "session.tool.input.started" && event.data?.name === "execute"))
    assert.ok(events.some((event) => event.type === "session.tool.success"))
    assert.ok(!events.some((event) => /failed/.test(event.type)))
    const answer = events.filter((event) => event.type === "session.text.ended").map((event) => event.data?.text ?? "").join(" ")
    assert.match(answer, /1024/)
    report.codeMode = "恢复前后真实 execute 均返回 1024"
    ;(report.modelTurns ??= []).push({ marker, events })
  } finally { clearInterval(forms) }
}
try {
  for (const [index] of bases.entries()) {
    console.log(`快照验收 ▶ 等待 Docker SaaS ${index}`)
    let ready = false
    for (let attempt = 0; attempt < 120; attempt++) {
      try { await api(index, "/api/info"); ready = true; break } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    assert.ok(ready, `Docker SaaS ${index} 未就绪`)
    console.log(`快照验收 ✓ Docker SaaS ${index} 就绪`)
  }
  console.log("快照验收 ▶ 创建会话")
  id = (await api(0, "/api/session", "POST", { title: "aliyun-independent-auto-snapshot", sandbox: { persistMode: "snapshot", cpu: "2", memory: "2Gi", image: "base-5wa5" } })).data.id
  report.sessionID = id
  await watch(0)
  await shell(0, "mkdir -p /workspace/snapshot-e2e; printf '中文独立快照\\n' > /workspace/snapshot-e2e/text.txt; printf '\\000\\001\\177\\200\\377' > /workspace/snapshot-e2e/data.bin; sha256sum /workspace/snapshot-e2e/* > /workspace/snapshot-e2e/checksums")
  const original = binding()
  assert.equal(original.provider, "aliyun")
  assert.equal(original.state, "running")
  // Explicit online snapshot must not destroy or replace the workspace.
  const online = await api(0, `/api/session/${id}/snapshot`, "POST", {})
  assert.equal(online.data.state, "ready")
  assert.equal(binding().id, original.id)
  await shell(0, "printf '停止前的新文件' > /workspace/snapshot-e2e/latest.txt")
  if (process.env.VERIFY_CODEMODE === "1") await model(0, "BEFORE-SNAPSHOT")
  // Public stop automatically captures a NEW snapshot before terminating the VM.
  await api(0, `/api/session/${id}/kill-sandbox`, "POST", {})
  assert.equal(binding().state, "destroyed")
  const saved = (await api(0, `/api/session/${id}/snapshot`)).data
  assert.equal(saved.state, "ready")
  assert.notEqual(saved.id, online.data.snapshotID)
  // Another process, no runtime cache or pod affinity, performs restoration.
  await watch(1)
  await shell(1, "sha256sum -c /workspace/snapshot-e2e/checksums && cat /workspace/snapshot-e2e/latest.txt")
  const restored = binding()
  assert.equal(restored.state, "running")
  assert.notEqual(restored.id, original.id)
  assert.notEqual(restored.remote, original.remote)
  await shell(1, "cat /workspace/snapshot-e2e/text.txt", "中文独立快照")
  await shell(1, "cat /workspace/snapshot-e2e/latest.txt", "停止前的新文件")
  if (process.env.VERIFY_CODEMODE === "1") await model(1, "AFTER-RESTORE")
  assert.equal((await api(1, `/api/session/${id}/snapshot`)).data.restoredCount, 1)
  report.stats = (await api(1, `/api/session/${id}/snapshot/stats`)).data
  assert.equal(report.stats.restoredTotal, 1)
  report.snapshots = JSON.parse(pg(`SELECT coalesce(json_agg(row_to_json(t)),'[]') FROM (SELECT id,snapshot_id,state,restored_count FROM aliyun_snapshot WHERE session_id='${id}') t`))
  assert.equal(report.snapshots.length, 2)
  assert.ok(report.snapshots.every((value) => value.state === "ready" && value.snapshot_id))
  report.passed = true
} catch (error) { report.error = error.message; report.passed = false; process.exitCode = 1 }
finally {
  if (id) {
    try {
      await api(1, `/api/session/${id}`, "DELETE")
      assert.equal(pg(`SELECT count(*) FROM aliyun_snapshot WHERE session_id='${id}'`), "0")
      assert.equal(pg(`SELECT count(*) FROM session_v2 WHERE id='${id}'`), "0")
      report.cleanup = "会话与快照记录已清理"
    } catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1 }
  }
  for (const stream of streams) stream.controller.abort()
  await Promise.allSettled(streams.map((stream) => stream.done))
  await mkdir(process.env.STRESS_OUT, { recursive: true })
  await writeFile(`${process.env.STRESS_OUT}/result.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, error: report.error, cleanup: report.cleanup, cleanupError: report.cleanupError }))
}
