import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"

const base = process.env.BASE.replace(/\/$/, "")
const headers = { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}` }
const api = (path, init = {}) => fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(300000) })
const model = { providerID: "deepseek", id: "deepseek-flash" }
const created = await api("/api/session", { method: "POST", body: JSON.stringify({ title: "aliyun-mcp-autopsy2" }) })
assert.equal(created.status, 200)
const session = (await created.json()).data
const prompt = async (text) => {
  const response = await api(`/api/session/${session.id}/prompt_stream`, { method: "POST", body: JSON.stringify({ text, model }) })
  assert.equal(response.status, 200)
  let stream = ""
  for (const reader = response.body.getReader(), decoder = new TextDecoder(); ;) {
    const { value, done } = await reader.read()
    if (done) break
    stream += decoder.decode(value, { stream: true })
  }
  return stream.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
}
const defined = await api(`/api/session/${session.id}/mcps`, { method: "POST", body: JSON.stringify({ name: "everything", config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"] } }) })
assert.ok([200, 204].includes(defined.status))
const inspect = async (label) => {
  const command = "cat /tmp/opencode-mcp/*.log 2>/dev/null | tail -30; echo ---PROCS---; ps aux | grep -E 'mcp-bridge|server-everything' | grep -v grep; echo ---PORTS---; (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | head -12"
  await api(`/api/session/${session.id}/shell`, { method: "POST", body: JSON.stringify({ command: `printf '%s' '${command.replaceAll("'", `'\\''`)}' > /tmp/inspect.sh; bash /tmp/inspect.sh` }) })
  const read = await api(`/api/session/${session.id}/fs/read/.opencode/output`)
  void read
  // shell output arrives via durable log; fetch the last shell result instead
  const log = await api(`/api/experimental/session/${session.id}/log?follow=false&after=0`)
  const events = (await log.text()).split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
  const ended = events.filter((event) => event.type === "session.shell.ended").at(-1)
  console.log(`INSPECT[${label}]`, (ended?.data?.output?.output ?? "").slice(-1800))
}
await prompt("只回复 ok")
await inspect("after-warm")
const calls = await prompt("请调用 everything 服务器的 echo 工具，参数 message 为 'AUTOPSY'，无论成败都回复工具的原始返回。")
const used = []
for (const event of calls) {
  if (event.type === "session.tool.input.started" && event.data?.name) used.push(event.data.name)
  for (const call of event.data?.metadata?.toolCalls ?? []) used.push(`${call.tool}:${call.status}`)
}
console.log("CALLS", JSON.stringify([...new Set(used)]))
await inspect("after-call")
const text = calls.filter((event) => event.type === "session.text.ended").map((event) => event.data?.text ?? "").join(" ")
console.log("TEXT", text.slice(0, 300))
const report = { sessionID: session.id, calls: [...new Set(used)], text: text.slice(0, 200) }
await mkdir(process.env.STRESS_OUT ?? "../../artifacts/aliyun-sandbox", { recursive: true })
await writeFile(`${process.env.STRESS_OUT ?? "../../artifacts/aliyun-sandbox"}/mcp-autopsy2.json`, JSON.stringify(report, null, 2))
const del = await api(`/api/session/${session.id}`, { method: "DELETE" })
console.log("CLEANUP", del.status)
