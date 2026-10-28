// concurrency-isolation.md T6.1/T6.3/T6.4 核心隔离 + saas-stability T13.3/T13.9 HTTP 层。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:15193"
const pg = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const model = { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }
const H = { authorization: auth, "content-type": "application/json" }
const results = []
const q = (sql) => execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
const t = async (id, fn) => { try { await fn(); results.push({ id, ok: true }); console.log(`✓ ${id}`) } catch (e) { results.push({ id, ok: false, err: String(e.message).slice(0, 140) }); console.log(`✗ ${id}: ${String(e.message).slice(0, 140)}`) } }
const create = async (title) => (await (await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title, model, location: { directory: "/workspace" } }) })).json()).data.id

await t("T6.1 并发创建 6 session 全成功", async () => {
  const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => create(`conc-iso-${Date.now()}-${i}`)))
  assert.equal(new Set(ids).size, 6, "应 6 个唯一会话")
  assert.ok(ids.every(Boolean) && ids.every((x) => x.startsWith("ses_")), "会话 ID 合法")
  for (const id of ids) await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T6.3 并发消息均被接纳（200/202/204）", async () => {
  const SID = await create(`conc-msg-${Date.now()}`)
  const codes = await Promise.all(Array.from({ length: 5 }, (_, i) => fetch(base + `/api/session/${SID}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: `msg-${i}`, metadata: {} }) }).then((r) => r.status)))
  assert.ok(codes.every((c) => [200, 202, 204].includes(c)), `全部接纳，实际 ${codes}`)
  await fetch(base + `/api/experimental/session/${SID}/wait`, { method: "POST", headers: H, body: "{}" })
  const users = Number(q(`SELECT count(*) FROM session_message WHERE session_id='${SID}' AND type='user'`))
  assert.ok(users >= 1, "至少 1 条 user 落库")
  await fetch(base + `/api/session/${SID}`, { method: "DELETE", headers: H })
})

await t("T6.4 并发创建各自独立 sandbox（PG 绑定唯一）", async () => {
  const ids = await Promise.all(Array.from({ length: 3 }, (_, i) => create(`conc-sbx-${Date.now()}-${i}`)))
  // 触发沙箱初始化（shell 命令）
  await Promise.all(ids.map((id) => fetch(base + `/api/session/${id}/shell`, { method: "POST", headers: H, body: JSON.stringify({ command: "echo sandbox-init" }) })))
  await new Promise((r) => setTimeout(r, 8000))
  const binds = q(`SELECT DISTINCT session_id FROM sandbox WHERE session_id IN (${ids.map((x) => `'${x}'`).join(",")})`)
  assert.equal(binds.split("\n").filter(Boolean).length, 3, `应各自绑定，实际 ${binds}`)
  for (const id of ids) await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T13.3 同 session 并发首条只 1 sandbox", async () => {
  const SID = await create(`saas-13-${Date.now()}`)
  await Promise.all(Array.from({ length: 4 }, () => fetch(base + `/api/session/${SID}/shell`, { method: "POST", headers: H, body: JSON.stringify({ command: "echo once" }) })))
  await new Promise((r) => setTimeout(r, 8000))
  const n = Number(q(`SELECT count(*) FROM sandbox WHERE session_id='${SID}'`))
  assert.ok(n <= 2, `sandbox 行数 ${n} 应≤2（创建+代次）`)
  await fetch(base + `/api/session/${SID}`, { method: "DELETE", headers: H })
})

const pass = results.filter((r) => r.ok).length
console.log(`\nconcurrency-isolation+saas-stability: ${pass}/${results.length} 通过`)
process.exitCode = pass === results.length ? 0 : 1
