// error-handling.md 七、错误处理 T7.1–T7.6。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:15193"
const pg = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const results = []
const q = (sql) => execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
const raw = async (method, path, body, ct = "application/json") => {
  const r = await fetch(base + path, { method, headers: { authorization: auth, "content-type": ct }, body: body ?? undefined })
  return { status: r.status, text: await r.text().catch(() => "") }
}
const req = async (method, path, body) => ({ status: (await raw(method, path, body ? JSON.stringify(body) : undefined)).status, json: async () => { try { return JSON.parse((await raw(method, path, body ? JSON.stringify(body) : undefined)).text) } catch { return undefined } } })
const t = async (id, fn) => { try { await fn(); results.push({ id, ok: true }); console.log(`✓ ${id}`) } catch (e) { results.push({ id, ok: false, err: String(e.message).slice(0, 140) }); console.log(`✗ ${id}: ${String(e.message).slice(0, 140)}`) } }
const H = { authorization: auth, "content-type": "application/json" }

await t("T7.1 未配置 provider：会话 200、prompt 接纳、收敛、无 assistant", async () => {
  const r = await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: "err-t71", model: { providerID: "no-such-provider", id: "no-such-model" }, location: { directory: "/workspace" } }) })
  assert.equal(r.status, 200, `create HTTP ${r.status}`)
  const SID = (await r.json()).data.id
  const p = await fetch(base + `/api/session/${SID}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: "hi", metadata: {}, model: { providerID: "no-such-provider", id: "no-such-model" } }) })
  assert.ok([200, 202, 204].includes(p.status), `prompt HTTP ${p.status}`)
  const w = await fetch(base + `/api/experimental/session/${SID}/wait`, { method: "POST", headers: H, body: "{}" })
  assert.equal(w.status, 204, `wait HTTP ${w.status}`)
  const msgs = q(`SELECT type FROM session_message WHERE session_id='${SID}'`)
  assert.ok(msgs.includes("user"), "应有 user 消息")
  assert.ok(!msgs.includes("assistant"), "不应有 assistant 消息")
  await fetch(base + `/api/session/${SID}`, { method: "DELETE", headers: H })
})

await t("T7.2 不存在的 session 发消息 404 结构化错误", async () => {
  const r = await fetch(base + "/api/session/ses_NOTEXIST/prompt", { method: "POST", headers: H, body: JSON.stringify({ text: "hi", metadata: {} }) })
  assert.equal(r.status, 404)
  const j = await r.json()
  assert.ok(j.error || j._tag, "应为结构化错误")
})

await t("T7.3 无效 JSON 请求体 400", async () => {
  const r = await fetch(base + "/api/session", { method: "POST", headers: H, body: "{not json" })
  assert.equal(r.status, 400)
})

await t("T7.4 缺失必填 text 400", async () => {
  const c = await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ location: { directory: "/workspace" } }) })
  const SID = (await c.json()).data.id
  const r = await fetch(base + `/api/session/${SID}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ metadata: {} }) })
  assert.equal(r.status, 400, `prompt HTTP ${r.status}`)
  await fetch(base + `/api/session/${SID}`, { method: "DELETE", headers: H })
})

await t("T7.5 超长 100KB 消息：200 且 <5s 不 hang", async () => {
  const c = await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: "err-t75", model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }, location: { directory: "/workspace" } }) })
  const SID = (await c.json()).data.id
  const big = "x".repeat(100 * 1024)
  const t0 = Date.now()
  const r = await fetch(base + `/api/session/${SID}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: big, metadata: {}, model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" } }) })
  const dt = Date.now() - t0
  assert.ok([200, 202, 204].includes(r.status), `HTTP ${r.status}`)
  assert.ok(dt < 5000, `耗时 ${dt}ms 应 <5000ms`)
  await fetch(base + `/api/session/${SID}`, { method: "DELETE", headers: H })
})

await t("T7.6 assistant finish 非 unknown", async () => {
  const c = await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: "err-t76", model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }, location: { directory: "/workspace" } }) })
  const SID = (await c.json()).data.id
  await fetch(base + `/api/session/${SID}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: "回复完成", metadata: {}, model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" } }) })
  await fetch(base + `/api/experimental/session/${SID}/wait`, { method: "POST", headers: H, body: "{}" })
  const fin = q(`SELECT data FROM session_message WHERE session_id='${SID}' AND type='assistant' ORDER BY time_created DESC LIMIT 1`)
  assert.ok(fin, "应有 assistant 消息")
  const m = fin.match(/"finish"\s*:\s*"([^"]+)"/)
  assert.ok(m, "finish 字段缺失")
  assert.notEqual(m[1], "unknown", `finish 不应为 unknown，实际 ${m[1]}`)
  await fetch(base + `/api/session/${SID}`, { method: "DELETE", headers: H })
})

const pass = results.filter((r) => r.ok).length
console.log(`\nerror-handling: ${pass}/${results.length} 通过`)
process.exitCode = pass === results.length ? 0 : 1
