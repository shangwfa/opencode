import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"

const base = process.env.BASE
const output = process.env.STRESS_OUT
assert.ok(base && output && process.env.PG_URL?.endsWith("-test"))
const headers = { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}` }
const report = { stages: [], snapshots: [], events: [] }
let id
const controller = new AbortController()
let watching
const api = async (path, init = {}) => {
  const started = Date.now()
  const response = await fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(180000) })
  report.stages.push({ path, method: init.method ?? "GET", status: response.status, ms: Date.now() - started })
  assert.ok(response.ok, `${init.method ?? "GET"} ${path}: ${response.status}`)
  return response
}
const sql = (statement) => execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", statement], { encoding: "utf8" }).trim()
const shell = (command) => api(`/api/session/${id}/shell`, { method: "POST", body: JSON.stringify({ command }) })
const inspect = async (label) => {
  await shell(`node -e 'const fs=require("fs"),cp=require("child_process");const logs={};try{for(const name of fs.readdirSync("/tmp/opencode-mcp")){if(name.endsWith(".log"))logs[name]=fs.readFileSync("/tmp/opencode-mcp/"+name,"utf8").slice(-5000)}}catch{}fs.writeFileSync("/workspace/.opencode/diagnose.json",JSON.stringify({processes:cp.execFileSync("ps",["-eo","pid,ppid,args"],{encoding:"utf8"}),tcp:fs.readFileSync("/proc/net/tcp","utf8"),logs}))'`)
  const response = await api(`/api/session/${id}/fs/read/.opencode/diagnose.json`)
  const data = await response.json()
  report.snapshots.push({ label, ...data })
  console.log(`诊断 ${label}: ${Object.keys(data.logs ?? {}).length} 个桥日志`)
}
const prompt = async (text) => {
  const response = await api(`/api/session/${id}/prompt_stream`, { method: "POST", body: JSON.stringify({ text, model: { providerID: "deepseek", id: "deepseek-flash" } }) })
  await response.text()
}
try {
  const response = await api("/api/session", { method: "POST", body: JSON.stringify({ title: "aliyun-mcp-diagnose", sandbox: { cpu: "2", memory: "2Gi", persistMode: "none" } }) })
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
        if (/tool\.(input.started|success|failed)|execution\.|text\.ended|reasoning\.ended|form\./.test(event.type)) {
          const calls = event.data?.metadata?.toolCalls
          console.log(`SSE ${event.type} ${calls ? JSON.stringify(calls) : event.data?.name ?? ""}`)
        }
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) report.streamError = error.message })
  if (process.env.KEEPALIVE === "1") {
    await api(`/api/experimental/session/${id}/keep-alive`, { method: "POST", body: JSON.stringify({ keepAlive: true }) })
  }
  await shell("printf diagnostic-boot-ok")
  report.binding = JSON.parse(sql(`SELECT json_build_object('provider',provider,'remote',remote_name,'state',state)::text FROM sandbox WHERE session_id='${id}'`))
  assert.equal(report.binding.provider, "aliyun")
  console.log(`真实绑定 ${JSON.stringify(report.binding)}`)
  await api(`/api/session/${id}/mcps`, { method: "POST", body: JSON.stringify({ name: "everything", config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"] } }) })
  await prompt("只回复 ok")
  await inspect("after-warm")
  await prompt("仅调用一次 everything 的 echo 工具，message 为 ALIYUN-DIAG。失败则不要重试，也不要调用其他工具；原样报告工具返回。")
  await inspect("after-call")
} catch (error) {
  report.error = error.message
  process.exitCode = 1
} finally {
  controller.abort()
  await watching
  if (id) {
    try { report.cleanupHTTP = (await api(`/api/session/${id}`, { method: "DELETE" })).status } catch (error) { report.cleanupError = error.message }
  }
  await mkdir(output, { recursive: true })
  await writeFile(`${output}/diagnose.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ evidence: output, error: report.error, cleanup: report.cleanupHTTP }))
}
