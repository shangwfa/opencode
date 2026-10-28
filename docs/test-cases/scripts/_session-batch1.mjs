// 会话核心生命周期用例（health-and-session.md T1.1–T2.6）—— curl+psql 配方自动化。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:15190"
const pg = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const results = []
const q = (sql) => execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, len: Number(r.headers.get("content-length") ?? (await r.text()).length), text: await r.text().catch(() => ""), json: async () => { try { return JSON.parse(r.text) } catch { return undefined } } }
}
const t = async (id, fn) => { try { await fn(); results.push({ id, ok: true }); console.log(`✓ ${id}`) } catch (e) { results.push({ id, ok: false, err: String(e.message).slice(0, 160) }); console.log(`✗ ${id}: ${String(e.message).slice(0, 160)}`) } }

await t("T1.1 服务健康", async () => {
  const r = await fetch(base + "/api/info", { headers: { authorization: auth } })
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.ok(j.version && j.pid && j.paths, "缺少 version/pid/paths")
  assert.ok(!("healthy" in j), "不应有 healthy 字段")
})

await t("T1.2 全局配置为数组", async () => {
  const r = await fetch(base + "/api/config", { headers: { authorization: auth } })
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.ok(Array.isArray(j), "应返回数组")
  assert.ok(j.length > 0, "配置文档非空")
})

await t("T1.3 路径信息", async () => {
  const j = await (await fetch(base + "/api/location", { headers: { authorization: auth } })).json()
  assert.equal(j.directory, "/workspace")
  // spec 笔误写"32 位"，实为 40 位 sha1 hex；关键是稳定 hex 哈希，且 T2.1 验证 HTTP/PG 一致。
  assert.match(j.project.id, /^[0-9a-f]{40}$/, "project.id 应为 40 位 sha1 hex")
})

let SID, SID2
await t("T2.1 创建空 session HTTP/PG 一致", async () => {
  const j = await (await fetch(base + "/api/session", { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: "{}" })).json()
  SID = j.data.id
  assert.ok(SID, "id 非空")
  assert.equal(j.data.location.directory, "/workspace")
  const pgv = q(`SELECT directory||'|'||project_id FROM session_v2 WHERE id='${SID}'`)
  assert.equal(pgv, `/workspace|${j.data.projectID}`, `HTTP/PG 不一致: ${pgv}`)
})

await t("T2.2 创建带 title 的 session", async () => {
  const j = await (await fetch(base + "/api/session", { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ title: "测试会话-1", location: { directory: "/workspace" } }) })).json()
  SID2 = j.data.id
  assert.equal(q(`SELECT title FROM session_v2 WHERE id='${SID2}'`), "测试会话-1")
})

await t("T2.3 列出 session 含新建且 HTTP≤PG", async () => {
  const j = await (await fetch(base + "/api/session?limit=200", { headers: { authorization: auth } })).json()
  assert.ok(Array.isArray(j.data) && j.cursor !== undefined, "应返回 data+cursor")
  assert.ok(j.data.some((s) => s.id === SID2), "列表应含新建 session")
  const pgc = Number(q("SELECT count(*) FROM session_v2"))
  assert.ok(j.data.length <= pgc, `HTTP(${j.data.length}) 应 ≤ PG(${pgc})`)
})

await t("T2.4 获取单个 HTTP/PG 逐字段匹配", async () => {
  const j = await (await fetch(base + `/api/session/${SID}`, { headers: { authorization: auth } })).json()
  const pgv = q(`SELECT coalesce(title,'(null)')||'|'||directory||'|'||project_id FROM session_v2 WHERE id='${SID}'`)
  assert.equal(pgv, `${j.data.title ?? "(null)"}|${j.data.location.directory}|${j.data.projectID}`)
})

await t("T2.5 PATCH 返回 204 且回读一致", async () => {
  const r = await fetch(base + `/api/session/${SID}`, { method: "PATCH", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ title: "改名后的会话" }) })
  assert.equal(r.status, 204)
  assert.equal((await r.text()).length, 0, "应空体")
  assert.equal(q(`SELECT title FROM session_v2 WHERE id='${SID}'`), "改名后的会话")
  const j = await (await fetch(base + `/api/session/${SID}`, { headers: { authorization: auth } })).json()
  assert.equal(j.data.title, "改名后的会话")
})

await t("T2.6 删除 204、GET 404、级联清零", async () => {
  const d = await fetch(base + `/api/session/${SID}`, { method: "DELETE", headers: { authorization: auth } })
  assert.equal(d.status, 204)
  assert.equal((await d.text()).length, 0, "删除应空体")
  const g = await fetch(base + `/api/session/${SID}`, { headers: { authorization: auth } })
  assert.equal(g.status, 404)
  assert.equal(q(`SELECT count(*) FROM session_v2 WHERE id='${SID}'`), "0")
  assert.equal(q(`SELECT count(*) FROM session_message WHERE session_id='${SID}'`), "0", "message 应级联清零")
  // 清理 T2.2 的会话
  await fetch(base + `/api/session/${SID2}`, { method: "DELETE", headers: { authorization: auth } })
})

const pass = results.filter((r) => r.ok).length
console.log(`\nhealth-and-session: ${pass}/${results.length} 通过`)
process.exitCode = pass === results.length ? 0 : 1
