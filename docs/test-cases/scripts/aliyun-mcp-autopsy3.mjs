import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"

const base = process.env.BASE.replace(/\/$/, "")
const headers = { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}` }
const api = (path, init = {}) => fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(240000) })
const model = { providerID: "deepseek", id: "deepseek-flash" }
const created = await api("/api/session", { method: "POST", body: JSON.stringify({ title: "aliyun-mcp-autopsy3" }) })
assert.equal(created.status, 200)
const session = (await created.json()).data
const prompt = async (text) => {
  const response = await api(`/api/session/${session.id}/prompt_stream`, { method: "POST", body: JSON.stringify({ text, model }) })
  assert.equal(response.status, 200, `prompt HTTP ${response.status}`)
  let stream = ""
  for (const reader = response.body.getReader(), decoder = new TextDecoder(); ;) {
    const { value, done } = await reader.read()
    if (done) break
    stream += decoder.decode(value, { stream: true })
  }
  return stream.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
}
const inspect = async (label) => {
  const command = `{ cat /tmp/opencode-mcp/*.log 2>/dev/null; echo ---PROCS---; ps aux | grep -E 'mcp-bridge|server-everything' | grep -v grep; echo ---LS---; ls -la /tmp/opencode-mcp/ 2>/dev/null; } > /workspace/.opencode/autopsy.txt 2>&1`
  await api(`/api/session/${session.id}/shell`, { method: "POST", body: JSON.stringify({ command }) })
  const read = await api(`/api/session/${session.id}/fs/read/.opencode/autopsy.txt`)
  const body = read.status === 200 ? await read.text() : `fs/read HTTP ${read.status}`
  console.log(`INSPECT[${label}]\n${body.slice(0, 2400)}`)
}
const defined = await api(`/api/session/${session.id}/mcps`, { method: "POST", body: JSON.stringify({ name: "everything", config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"] } }) })
assert.ok([200, 204].includes(defined.status), `mcp create HTTP ${defined.status}`)
const warm = await prompt("只回复 ok")
console.log("WARM", warm.filter((event) => event.type === "session.execution.succeeded").length ? "ok" : "failed")
await inspect("after-warm")
const calls = await prompt("请调用 everything 服务器的 echo 工具，参数 message 为 'AUTOPSY3'。无论成败，回复工具原始返回。")
const statuses = []
for (const event of calls) for (const call of event.data?.metadata?.toolCalls ?? []) statuses.push(`${call.tool}:${call.status}`)
console.log("CALLS", JSON.stringify(statuses))
const text = calls.filter((event) => event.type === "session.text.ended").map((event) => event.data?.text ?? "").join(" ")
console.log("TEXT", text.slice(0, 260).replace(/\n/g, " "))
await inspect("after-call")
const report = { sessionID: session.id, statuses, text: text.slice(0, 240) }
await mkdir(process.env.STRESS_OUT ?? "../../artifacts/aliyun-sandbox", { recursive: true })
await writeFile(`${process.env.STRESS_OUT ?? "../../artifacts/aliyun-sandbox"}/mcp-autopsy3.json`, JSON.stringify(report, null, 2))
const del = await api(`/api/session/${session.id}`, { method: "DELETE" })
console.log("CLEANUP", del.status)
