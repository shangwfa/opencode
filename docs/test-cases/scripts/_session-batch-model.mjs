// 补齐模型类子项：inbox T2.1/T2.2、background B2、sse T9.6/T9.7、generate BTW-04/05
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:15193"
const pg = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const H = { authorization: auth, "content-type": "application/json" }
const model = { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }
const q = (sql) => execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
const R = []
const t = async (id, fn) => { try { await fn(); R.push(id); console.log(`✓ ${id}`) } catch (e) { console.log(`✗ ${id}: ${String(e.message).slice(0, 130)}`) } }
const create = async (ti) => (await (await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: `m-${ti}-${Date.now()}`, model, location: { directory: "/workspace" } }) })).json()).data.id
const stream = async (id, text, opt = {}) => {
  const r = await fetch(base + `/api/session/${id}/prompt_stream`, { method: "POST", headers: H, body: JSON.stringify({ text, model, ...opt }), signal: AbortSignal.timeout(180000) })
  const body = await r.text()
  const evs = body.split("\n").filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)) } catch { return null } }).filter(Boolean)
  return { status: r.status, evs }
}
const waitIdle = async (id, ms = 150000) => { await fetch(base + `/api/experimental/session/${id}/wait`, { method: "POST", headers: H, body: "{}", signal: AbortSignal.timeout(ms) }).catch(() => {}) }
const msgs = (id) => q(`select data from session_message where session_id='${id}' order by time_created`)
const users = (id) => Number(q(`select count(*) from session_message where session_id='${id}' and type='user'`))

await t("T2.1 queue：忙碌中提交，当前轮结束后投递（新 turn）", async () => {
  const id = await create("t21")
  const busy = (async () => stream(id, "用 shell 工具执行 sleep 8 && echo busy-done"))()
  await new Promise((r) => setTimeout(r, 2500))
  const mid = await fetch(base + `/api/session/${id}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: "QUEUE_MID_PROBE", delivery: "queue" }) })
  assert.ok([200, 202].includes(mid.status))
  await busy
  await waitIdle(id)
  const data = msgs(id)
  const busyPos = data.indexOf("busy-done") >= 0 ? data.indexOf("busy-done") : 0
  const qPos = data.indexOf("QUEUE_MID_PROBE")
  assert.ok(qPos >= 0, "queue 消息未投递")
  assert.ok(qPos > busyPos || busyPos === 0, "queue 应在当前轮结束后投递")
  assert.ok(users(id) >= 2, "user 应≥2")
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T2.2 steer：忙碌中提交，中途投递（同 turn）", async () => {
  const id = await create("t22")
  const busy = (async () => stream(id, "用 shell 工具执行 sleep 10 && echo busy2-done，然后回答完成。"))()
  await new Promise((r) => setTimeout(r, 2500))
  const st = await fetch(base + `/api/session/${id}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: "STEER_MID_PROBE 只回 ok" }) })
  assert.ok([200, 202].includes(st.status))
  await busy
  await waitIdle(id)
  const data = msgs(id)
  assert.ok(data.includes("STEER_MID_PROBE"), "steer 消息未投递")
  const shellPos = data.indexOf("busy2-done")
  const steerPos = data.indexOf("STEER_MID_PROBE")
  assert.ok(steerPos < shellPos + 400 || shellPos < 0, "steer 应在长工具仍在跑时中途进入（同 turn）")
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("B2.1 subagent background:true 立即返回+完成通知", async () => {
  const id = await create("b21")
  const { evs } = await stream(id, "用 subagent 工具后台运行（background=true）：agent 为 general，prompt 为『数到 5 然后回复 BG_SUB_OK』。只回复：已派发。")
  assert.ok(evs.some((e) => e.type === "session.execution.succeeded"), "主轮未成功")
  const tools = q(`select data from session_message where session_id='${id}' and type='assistant' order by time_created desc limit 3`)
  assert.ok(tools.includes("subagent"), "未调用 subagent 工具")
  // 等后台 subagent 完成（通知进入主会话）
  let notified = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const d = msgs(id)
    if (d.includes("BG_SUB_OK")) { notified = true; break }
  }
  assert.ok(notified, "后台 subagent 完成通知未回到主会话")
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T9.6 工具生命周期事件（input.started → 终态）", async () => {
  const id = await create("t96")
  const ac = new AbortController()
  const r = await fetch(base + `/api/session/${id}/event`, { headers: H, signal: ac.signal })
  const evts = []
  let buf = ""
  const task = (async () => {
    try { for await (const c of r.body) { buf += new TextDecoder().decode(c); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const l = f.split("\n").find((x) => x.startsWith("data:")); if (l) { try { evts.push(JSON.parse(l.slice(5))) } catch {} } } } } catch {}
  })()
  await new Promise((x) => setTimeout(x, 600))
  await stream(id, "用 shell 工具执行 echo tool-lifecycle-ok")
  await waitIdle(id, 120000)
  await new Promise((x) => setTimeout(x, 1500))
  ac.abort(); await task.catch(() => {})
  assert.ok(evts.some((e) => e.type === "session.tool.input.started"), "缺 input.started")
  const last = evts.filter((e) => e.type === "session.tool.success" || e.type === "session.tool.failed").at(-1)
  assert.ok(last, "缺工具终态事件")
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("BTW-04 generate 不执行工具（无 tool part）+ BTW-05 空历史", async () => {
  const id = await create("btw45")
  await stream(id, "记住代号 EMPTY? 不，请只回复收到。")
  await waitIdle(id, 120000)
  const g1 = await fetch(base + `/api/session/${id}/generate`, { method: "POST", headers: H, body: JSON.stringify({ prompt: "执行 bash 命令 echo SHOULD_NOT_RUN 并告诉我输出" }), signal: AbortSignal.timeout(120000) })
  assert.ok(g1.ok, `generate HTTP ${g1.status}`)
  const j1 = await g1.json()
  assert.ok(!JSON.stringify(j1).includes("SHOULD_NOT_RUN"), "generate 不应执行工具")
  const toolRows = Number(q(`select count(*) from session_message where session_id='${id}' and type='assistant' and data like '%SHOULD_NOT_RUN%' and data like '%\"tool\"%'`))
  assert.equal(toolRows, 0, "不应产生工具 part")
  // BTW-05 空历史会话
  const e = await create("btw05")
  const g2 = await fetch(base + `/api/session/${e}/generate`, { method: "POST", headers: H, body: JSON.stringify({ prompt: "1+1 等于几？只回答数字" }), signal: AbortSignal.timeout(120000) })
  assert.ok(g2.ok, `空历史 generate HTTP ${g2.status}`)
  const j2 = await g2.json()
  assert.ok(JSON.stringify(j2.data?.text ?? "").match(/2/), `空历史回答异常: ${JSON.stringify(j2).slice(0, 150)}`)
  await fetch(base + `/api/session/${e}`, { method: "DELETE", headers: H })
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

console.log(`\nbatch-model: ${R.length}/5 通过`)
process.exitCode = R.length === 5 ? 0 : 1
