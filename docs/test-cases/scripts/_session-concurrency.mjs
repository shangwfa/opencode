// concurrency.md T39.1.1 / T39.3.1 / T39.5.1 / T39.5.3
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:15193"
const pg = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const H = { authorization: auth, "content-type": "application/json" }
const model = { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }
const results = []
const q = (sql) => execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
const t = async (id, fn) => { try { await fn(); results.push(id); console.log(`✓ ${id}`) } catch (e) { console.log(`✗ ${id}: ${String(e.message).slice(0, 130)}`) } }
const create = async () => (await (await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: `conc-${Date.now()}`, model, location: { directory: "/workspace" } }) })).json()).data.id
const shell = async (id, command) => {
  const r = await fetch(base + `/api/session/${id}/shell`, { method: "POST", headers: H, body: JSON.stringify({ command, timeoutSeconds: 120 }) })
  assert.ok([200, 204].includes(r.status), `shell HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return q(`select data from session_message where session_id='${id}' and type='shell' order by time_created desc limit 1`)
}

await t("T39.1.1 长命令执行中 kill-sandbox，后续命令正常重建", async () => {
  const id = await create()
  await shell(id, "echo warmup")
  const long = fetch(base + `/api/session/${id}/shell`, { method: "POST", headers: H, body: JSON.stringify({ command: "sleep 12 && echo long-run", timeoutSeconds: 120 }) })
  await new Promise((r) => setTimeout(r, 2500))
  const kill = await fetch(base + `/api/session/${id}/kill-sandbox`, { method: "POST", headers: H, body: "{}" })
  assert.ok([200, 204].includes(kill.status), `kill-sandbox HTTP ${kill.status}`)
  await long.catch(() => {})
  const out = await shell(id, "echo rebuilt-ok")
  assert.ok(out.includes("rebuilt-ok"), `重建后命令应成功，实际 ${out.slice(0, 120)}`)
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T39.3.1 同 session 并发命令只创建一个沙箱", async () => {
  const id = await create()
  await Promise.all(Array.from({ length: 4 }, () => fetch(base + `/api/session/${id}/shell`, { method: "POST", headers: H, body: JSON.stringify({ command: "echo once" }) })))
  await new Promise((r) => setTimeout(r, 5000))
  const rows = Number(q(`select count(*) from sandbox where session_id='${id}' and state<>'destroyed'`))
  assert.ok(rows <= 1, `活动沙箱行数 ${rows} 应 ≤1`)
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T39.5.1+5.3 删除 session 后沙箱销毁且无孤儿", async () => {
  const id = await create()
  await shell(id, "echo bye")
  const before = Number(q(`select count(*) from sandbox where session_id='${id}'`))
  assert.ok(before >= 1, "应先有沙箱绑定")
  const del = await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
  assert.equal(del.status, 204)
  await new Promise((r) => setTimeout(r, 4000))
  const active = Number(q(`select count(*) from sandbox where session_id='${id}' and state<>'destroyed'`))
  assert.equal(active, 0, `删除后仍有 ${active} 个活动沙箱（孤儿）`)
  const remote = q(`select coalesce(remote_name,'null') from sandbox where session_id='${id}'`)
  assert.ok(!remote || remote.split("\n").every((x) => x === "null"), `remote_name 应清空，实际 ${remote}`)
})

console.log(`\nconcurrency: ${results.length}/3 通过`)
process.exitCode = results.length === 3 ? 0 : 1
