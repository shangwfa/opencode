// communication/backend-frontend-joint-debug.md T21.1–T21.4（V2 映射：prompt_async→POST /prompt + A/B 跨会话）
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
const create = async (ti) => (await (await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: `comm-${ti}-${Date.now()}`, model, location: { directory: "/workspace" } }) })).json()).data.id
const waitIdle = async (id, ms = 150000) => { await fetch(base + `/api/experimental/session/${id}/wait`, { method: "POST", headers: H, body: "{}", signal: AbortSignal.timeout(ms) }).catch(() => {}) }
const data = (id) => q(`select data from session_message where session_id='${id}' order by time_created`)

const A = await create("A")
const B = await create("B")
try {
  await t("T21.1 A→B 异步注入接口契约（204 + B 收到 user 消息）", async () => {
    const r = await fetch(base + `/api/session/${B}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: "接口契约：GET /api/users 返回 [{id:1,name:'n1'}]。请确认收到。", delivery: "queue" }) })
    assert.ok([200, 202, 204].includes(r.status), `HTTP ${r.status}`)
    await waitIdle(B)
    assert.ok(data(B).includes("接口契约"), "B 未收到契约消息")
    assert.ok(Number(q(`select count(*) from session_message where session_id='${B}' and type='user'`)) >= 1, "user≥1")
  })

  await t("T21.2 同步驱动 B 并取回结果（assistant 追加进 B 历史）", async () => {
    const r = await fetch(base + `/api/session/${B}/prompt_stream`, { method: "POST", headers: H, body: JSON.stringify({ text: "实现 /api/users 接口契约：只回复『已实现 /api/users』", model }), signal: AbortSignal.timeout(180000) })
    const body = await r.text()
    assert.ok(body.includes("session.execution.succeeded"), "执行未成功")
    assert.ok(data(B).includes("/api/users"), "结果未进入 B 历史")
    assert.ok(Number(q(`select count(*) from session_message where session_id='${B}' and type='assistant'`)) >= 1, "assistant≥1")
  })

  await t("T21.3 状态流：/api/session/active 反映执行中/空闲", async () => {
    const busy = await (await fetch(base + `/api/session/active`, { headers: H })).json()
    assert.ok(busy.data && typeof busy.data === "object", "active 结构异常")
    const idleProbe = await create("idle-probe")
    const a2 = await (await fetch(base + `/api/session/active`, { headers: H })).json()
    assert.ok(!(idleProbe in (a2.data ?? {})), "空闲会话不应出现在 active")
    await fetch(base + `/api/session/${idleProbe}`, { method: "DELETE", headers: H })
  })

  await t("T21.4 B→A 联调结果回传（204 + A 收到结果）", async () => {
    const r = await fetch(base + `/api/session/${A}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: "联调结果：前端已对接 /api/users 成功，返回 [{id:1}] 校验通过。", delivery: "queue" }) })
    assert.ok([200, 202, 204].includes(r.status), `HTTP ${r.status}`)
    await waitIdle(A)
    assert.ok(data(A).includes("联调结果"), "A 未收到回传")
  })
} finally {
  for (const id of [A, B]) await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H }).catch(() => {})
}
console.log(`\ncomm-joint-debug: ${R.length}/4 通过`)
process.exitCode = R.length === 4 ? 0 : 1
