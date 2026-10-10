// Targeted verification for the tool.execute.after typed-error preservation fix:
// a permission.evaluate deny must surface the hook message without corrupting the failure channel.
import assert from "node:assert/strict"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14119").replace(/\/$/, "")
const PASSWORD = process.env.OPENCODE_PASSWORD ?? "ab123456"
const MODEL = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-GLM","modelID":"glm-5.3"}')
const headers = { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` }

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180_000) })
  const text = response.status === 204 ? "" : await response.text()
  let data
  try { data = text ? JSON.parse(text) : undefined } catch { data = text }
  return { response, text, data }
}

const created = await api("/api/session", "POST", {
  location: { directory: "/workspace" },
  model: { providerID: MODEL.providerID, id: MODEL.modelID },
  sandbox: { cpu: "1", memory: "2Gi", image: "opencode-opensandbox-session-plugin-verify:local" },
})
assert.equal(created.response.status, 200, created.text)
const sessionID = created.data.data.id
const marker = `PERM_DENY_FIX_${Date.now()}`

const plugin = await api(`/api/session/${sessionID}/plugins`, "POST", {
  name: "perm-deny", description: "deny glob and mutate nothing else",
  source: {
    type: "code",
    code: `export default async () => ({
      "permission.evaluate": (e) => { if (String(e.action ?? "").includes("glob")) { e.effect = "deny"; e.message = "${marker}" } },
      "tool.execute.after": (e) => { if (e.status === "completed" && e.result) e.result.content = String(e.result.output ?? "") + "|AFTER_OK" },
    })`,
  },
})
assert.equal(plugin.response.status, 200, plugin.text)
console.log(`session=${sessionID}`)

const stream = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
  method: "POST", headers, body: JSON.stringify({ text: "Use the glob tool exactly once with pattern *.md. Do not retry. Report the exact error message." }), signal: AbortSignal.timeout(180_000),
})
const body = await stream.text()
assert.equal(stream.status, 200, body.slice(0, 400))
const events = body.split(/\r?\n/).filter((line) => line.startsWith("data:")).flatMap((line) => { try { return [JSON.parse(line.slice(5).trim())] } catch { return [] } })
assert(events.some((event) => event.type === "session.execution.succeeded"), events.map((e) => e.type).join(","))

const messages = await api(`/api/session/${sessionID}/message?order=asc&limit=100`)
const calls = messages.data.data.flatMap((m) => m.type === "assistant" ? (m.content ?? []).filter((p) => p.type === "tool" && p.name === "glob") : [])
const failed = calls.findLast((call) => call.state.status === "error")
assert(failed, `no failed glob call: ${JSON.stringify(calls.map((c) => c.state.status))}`)
const message = String(failed.state.error?.message ?? JSON.stringify(failed.state.error))
assert(message.includes(marker), `deny marker missing from tool failure: ${message}`)
console.log(`PASS permission-deny/typed-error-preserved; tool failure=${message.slice(0, 160)}`)

const deleted = await api(`/api/session/${sessionID}`, "DELETE")
assert([200, 204, 404].includes(deleted.response.status), deleted.text)
