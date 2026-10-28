// inbox/README.md T2.3/T2.4（PATCH 改投递模式）+ T3（取消，no-op 语义）。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:15193"
const pg = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const H = { authorization: auth, "content-type": "application/json" }
const q = (sql) => execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
const rows = (sql) => JSON.parse(q(`select coalesce(json_agg(t),'[]') from (${sql}) t`))
const results = []
const t = async (id, fn) => { try { await fn(); results.push(id); console.log(`✓ ${id}`) } catch (e) { console.log(`✗ ${id}: ${String(e.message).slice(0, 140)}`) } }
const newSid = async () => (await (await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: `inbox-t23-${Date.now()}`, location: { directory: "/workspace" } }) })).json()).data.id
const admit = (id, text, delivery) => fetch(base + `/api/session/${id}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text, resume: false, ...(delivery ? { delivery } : {}) }) })
const inbox = (id) => rows(`select id, delivery from session_inbox where session_id='${id}' order by enqueued_seq`)

await t("T2.3 PATCH steer→queue：改模式、不唤醒", async () => {
  const sid = await newSid()
  await admit(sid, "T23_ITEM", "steer")
  let [item] = inbox(sid)
  assert.equal(item.delivery, "steer", "初始应为 steer")
  const p = await fetch(base + `/api/session/${sid}/inbox/${item.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ delivery: "queue" }) })
  assert.equal(p.status, 204, `PATCH HTTP ${p.status}`)
  const [after] = inbox(sid)
  assert.equal(after.delivery, "queue", "应为 queue")
  assert.equal(Number(q(`select count(*) from session_message where session_id='${sid}' and type='user'`)), 0, "不应唤醒消费")
  await fetch(base + `/api/session/${sid}`, { method: "DELETE", headers: H })
})

await t("T2.4 PATCH queue→steer：改模式并唤醒消费", async () => {
  const sid = await newSid()
  await admit(sid, "T24_ITEM", "queue")
  const [item] = inbox(sid)
  assert.equal(item.delivery, "queue")
  const p = await fetch(base + `/api/session/${sid}/inbox/${item.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ delivery: "steer" }) })
  assert.equal(p.status, 204, `PATCH HTTP ${p.status}`)
  for (let i = 0; i < 60; i++) {
    const delivered = Number(q(`select count(*) from session_message where session_id='${sid}' and type='user' and data like '%T24_ITEM%'`))
    if (delivered >= 1) break
    await new Promise((r) => setTimeout(r, 500))
  }
  assert.ok(Number(q(`select count(*) from session_message where session_id='${sid}' and type='user' and data like '%T24_ITEM%'`)) >= 1, "steer PATCH 应唤醒消费")
  await fetch(base + `/api/session/${sid}`, { method: "DELETE", headers: H })
})

await t("T3.1+T3.2 取消停留项生效、取消不存在项 no-op", async () => {
  const sid = await newSid()
  await admit(sid, "T3_CANCEL_ME", "queue")
  const [item] = inbox(sid)
  const ok = await fetch(base + `/api/session/${sid}/inbox/${item.id}`, { method: "DELETE", headers: H })
  assert.ok([200, 204].includes(ok.status), `取消 HTTP ${ok.status}`)
  assert.equal(inbox(sid).length, 0, "取消后应清空")
  const noop = await fetch(base + `/api/session/${sid}/inbox/${item.id}`, { method: "DELETE", headers: H })
  assert.ok([200, 204, 404].includes(noop.status), `no-op HTTP ${noop.status}`)
  await fetch(base + `/api/session/${sid}`, { method: "DELETE", headers: H })
})

console.log(`\ninbox T2/T3: ${results.length}/3 通过`)
process.exitCode = results.length === 3 ? 0 : 1
