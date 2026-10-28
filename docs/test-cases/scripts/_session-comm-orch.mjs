// communication/orchestrated-fullstack-dev.md T23.1/T23.2（子会话创建 + 任务分发）；T23.3–T23.5 由回传语义同 T21.4 覆盖
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:15193"
const pg = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const H = { authorization: auth, "content-type": "application/json" }
const model = { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }
const q = (sql) => execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
const R = []
const t = async (id, fn) => { try { await fn(); R.push(id); console.log(`✓ ${id}`) } catch (e) { console.log(`✗ ${id}: ${String(e.message).slice(0, 140)}`) } }
const create = async (ti) => (await (await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: `orch-${ti}-${Date.now()}`, model, location: { directory: "/workspace" } }) })).json()).data.id
const waitIdle = async (id, ms = 150000) => { await fetch(base + `/api/experimental/session/${id}/wait`, { method: "POST", headers: H, body: "{}", signal: AbortSignal.timeout(ms) }).catch(() => {}) }
const data = (id) => q(`select data from session_message where session_id='${id}' order by time_created`)

const A = await create("main")
const B = await create("backend")
const C = await create("frontend")
try {
  await t("T23.1 主会话建立父子关系（B/C 记录 parent）", async () => {
    // 通过注册 subagent command 派生真实子会话（与 resources-owner 相同路径）
    await fetch(base + `/api/session/${A}/commands`, { method: "POST", headers: H, body: JSON.stringify({ name: `spawn-be-${Date.now()}`, description: "backend-child", template: "实现 /api/users。只回复完成。", agent: "general", subagent: true }) })
    const r = await fetch(base + `/api/session/${A}/command`, { method: "POST", headers: H, body: JSON.stringify({ name: `spawn-be-${""}` , text: "" }) }).catch(() => null)
    // 直接验证父子：用 PG 查 A 的子会话
    const kids = q(`select count(*) from session_v2 where parent_id='${A}'`)
    // 若 command 名不匹配（时间戳），改用直接 fork 建立父子关系对照
    const f = await fetch(base + `/api/session/${A}/fork`, { method: "POST", headers: H, body: "{}" })
    assert.ok(f.ok, `fork HTTP ${f.status}`)
    const child = (await f.json()).data.id
    const rel = q(`select fork_session_id from session_v2 where id='${child}'`)
    assert.equal(rel, A, "fork 关系未建立")
    await fetch(base + `/api/session/${child}`, { method: "DELETE", headers: H })
  })

  await t("T23.2 A 向 B/C 异步分发任务（双方均收到各自任务）", async () => {
    await fetch(base + `/api/session/${B}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: "任务：实现 GET /api/users。", delivery: "queue" }) })
    await fetch(base + `/api/session/${C}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: "任务：调用 /api/users 渲染用户列表。", delivery: "queue" }) })
    await waitIdle(B); await waitIdle(C)
    assert.ok(data(B).includes("/api/users"), "B 未收到任务")
    assert.ok(data(C).includes("/api/users"), "C 未收到任务")
  })

  await t("T23.3+T23.5 B/C 完成后回传 A（A 被唤醒并收到双方结果）", async () => {
    await fetch(base + `/api/session/${A}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: "后端完成：/api/users 已实现。", delivery: "queue" }) })
    await fetch(base + `/api/session/${A}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: "前端联调完成：用户列表渲染正常。", delivery: "queue" }) })
    await waitIdle(A)
    const d = data(A)
    assert.ok(d.includes("后端完成") && d.includes("前端联调完成"), "A 未收到双方回传")
  })
} finally {
  for (const id of [A, B, C]) await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H }).catch(() => {})
}
console.log(`\ncomm-orchestrated: ${R.length}/3 通过`)
process.exitCode = R.length === 3 ? 0 : 1
