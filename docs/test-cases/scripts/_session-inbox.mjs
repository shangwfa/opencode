// inbox/README.md T1.2 / T1.3：resume:false 入队不唤醒、inbox 项结构契约。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:15193"
const pg = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const H = { authorization: auth, "content-type": "application/json" }
const q = (sql) => execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
const rows = (sql) => JSON.parse(q(`select coalesce(json_agg(t),'[]') from (${sql}) t`))
const results = []
const t = async (id, fn) => { try { await fn(); results.push(id); console.log(`✓ ${id}`) } catch (e) { console.log(`✗ ${id}: ${String(e.message).slice(0, 130)}`) } }

const id = (await (await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: `inbox-${Date.now()}`, location: { directory: "/workspace" } }) })).json()).data.id

await t("T1.2 resume:false 入队但不唤醒（无 user 消息、inbox 保留）", async () => {
  const r = await fetch(base + `/api/session/${id}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: "INBOX_PENDING_PROBE", resume: false }) })
  assert.ok([200, 202].includes(r.status), `HTTP ${r.status}`)
  await new Promise((x) => setTimeout(x, 1200))
  const inbox = rows(`select * from session_inbox where session_id='${id}'`)
  assert.equal(inbox.length, 1, `inbox 应有 1 项，实际 ${inbox.length}`)
  const users = Number(q(`select count(*) from session_message where session_id='${id}' and type='user'`))
  assert.equal(users, 0, `不应产生 user 消息，实际 ${users}`)
})

await t("T1.3 inbox 项结构契约（id/delivery/type/payload/session_id）", async () => {
  const [item] = rows(`select * from session_inbox where session_id='${id}'`)
  assert.ok(item, "缺 inbox 项")
  assert.match(item.id, /^ms?g_|^[a-z]+_/, `id 格式异常：${item.id}`)
  assert.ok(["steer", "queue"].includes(item.delivery), `delivery 异常：${item.delivery}`)
  assert.equal(item.type, "user", `type 应为 user，实际 ${item.type}`)
  const payload = typeof item.payload === "string" ? JSON.parse(item.payload) : item.payload
  assert.equal(payload.text, "INBOX_PENDING_PROBE", "payload.text 不匹配")
  assert.equal(item.session_id, id)
  assert.equal(item.delivery, "steer", "默认投递应为 steer")
})

await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
console.log(`\ninbox: ${results.length}/2 通过`)
process.exitCode = results.length === 2 ? 0 : 1
