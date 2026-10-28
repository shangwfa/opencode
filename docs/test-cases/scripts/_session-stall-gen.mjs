// llm-stall-recovery T40.2.2 + session-generate BTW-01/02/03。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:15193"
const pg = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const model = { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }
const H = { authorization: auth, "content-type": "application/json" }
const results = []
const q = (sql) => execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
const t = async (id, fn) => { try { await fn(); results.push({ id, ok: true }); console.log(`✓ ${id}`) } catch (e) { results.push({ id, ok: false, err: String(e.message).slice(0, 150) }); console.log(`✗ ${id}: ${String(e.message).slice(0, 150)}`) } }
const create = async () => (await (await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ model, location: { directory: "/workspace" } }) })).json()).data.id
const prompt = (id, text, extra = {}) => fetch(base + `/api/session/${id}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text, metadata: {}, model, ...extra }) })
const wait = async (id, budget = 200000) => { const c = AbortSignal.timeout(budget); await fetch(base + `/api/experimental/session/${id}/wait`, { method: "POST", headers: H, body: "{}", signal: c }) }
const lastText = (id) => q(`SELECT data FROM session_message WHERE session_id='${id}' AND type='assistant' ORDER BY time_created DESC LIMIT 1`)

await t("T40.2.2 长 run 期间排队消息不被误取消", async () => {
  const SID = await create()
  await prompt(SID, "用 shell 工具执行 sleep 20 && echo long-done")
  await new Promise((r) => setTimeout(r, 6000))
  const active = await (await fetch(base + "/api/session/active", { headers: H })).json()
  assert.ok(active.data?.[SID], `active 应含 running，实际 ${JSON.stringify(active.data)}`)
  await prompt(SID, "回复 queued-behind 即可")
  await wait(SID)
  const txt = lastText(SID)
  assert.ok(txt.includes("queued-behind"), `最终回复应含 queued-behind，实际 ${txt.slice(0, 120)}`)
  // shell 工具真实跑完（tool part in assistant），非 API shell 消息
  const shellTool = q(`SELECT count(*) FROM session_message WHERE session_id='${SID}' AND type='assistant' AND data::text LIKE '%"name":"shell"%' AND data::text LIKE '%long-done%'`)
  assert.ok(Number(shellTool) >= 1, "shell 工具应真实输出 long-done")
  const users = Number(q(`SELECT count(*) FROM session_message WHERE session_id='${SID}' AND type='user'`))
  assert.ok(users >= 2, `user 应≥2，实际 ${users}`)
  await fetch(base + `/api/session/${SID}`, { method: "DELETE", headers: H })
})

await t("BTW-01/02/03 generate 读上下文、临时问答不落主对话", async () => {
  const SID = await create()
  await prompt(SID, "记住：我的代号是 ALPHA-77。回复收到。")
  await wait(SID)
  const before = Number(q(`SELECT count(*) FROM session_message WHERE session_id='${SID}'`))
  // BTW-01 读上下文：问代号，应答出 ALPHA-77
  const g = await fetch(base + `/api/session/${SID}/generate`, { method: "POST", headers: H, body: JSON.stringify({ text: "我的代号是什么？只回答代号。", model }) })
  assert.ok([200, 201].includes(g.status), `generate HTTP ${g.status}`)
  const gj = await g.json()
  const ans = JSON.stringify(gj)
  assert.ok(ans.includes("ALPHA-77"), `应读到上下文代号，实际 ${ans.slice(0, 120)}`)
  // BTW-02/03 临时问答不进入后续主对话：主消息数不变
  const after = Number(q(`SELECT count(*) FROM session_message WHERE session_id='${SID}'`))
  assert.equal(after, before, `generate 不应落主消息，before=${before} after=${after}`)
  await fetch(base + `/api/session/${SID}`, { method: "DELETE", headers: H })
})

const pass = results.filter((r) => r.ok).length
console.log(`\nllm-stall+session-generate: ${pass}/${results.length} 通过`)
process.exitCode = pass === results.length ? 0 : 1
