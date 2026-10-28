// ai-conversation.md T4.1/T4.2/T4.8（其余 T4.3-4.7 已被前批覆盖：文件/shell/异步/interrupt）
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
const create = async (ti) => (await (await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: `ai-${ti}-${Date.now()}`, model, location: { directory: "/workspace" } }) })).json()).data.id
const stream = async (id, text) => {
  const r = await fetch(base + `/api/session/${id}/prompt_stream`, { method: "POST", headers: H, body: JSON.stringify({ text, model }), signal: AbortSignal.timeout(240000) })
  const body = await r.text()
  return body.split("\n").filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)) } catch { return null } }).filter(Boolean)
}
const lastAssistant = (id) => q(`select data::text from session_message where session_id='${id}' and type='assistant' order by time_created desc limit 1`)

await t("T4.1 简单文本对话（回复+完成）", async () => {
  const id = await create("t41")
  const evs = await stream(id, "只回复 OK-T41")
  assert.ok(evs.some((e) => e.type === "session.execution.succeeded"), "执行未成功")
  assert.ok(lastAssistant(id).includes("OK-T41"), `回复不含标记: ${lastAssistant(id).slice(0, 100)}`)
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T4.2 多轮上下文记忆", async () => {
  const id = await create("t42")
  await stream(id, "我的项目代号是 CTX-MEMO-42。只回复收到。")
  const evs = await stream(id, "我的项目代号是什么？只回答代号本身。")
  assert.ok(evs.some((e) => e.type === "session.execution.succeeded"), "第二轮未成功")
  assert.ok(lastAssistant(id).includes("CTX-MEMO-42"), `上下文丢失: ${lastAssistant(id).slice(0, 120)}`)
  const users = Number(q(`select count(*) from session_message where session_id='${id}' and type='user'`))
  assert.ok(users >= 2, "应有≥2 轮")
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T4.8 Code Mode 触发（execute 在沙箱完成）", async () => {
  const id = await create("t48")
  const evs = await stream(id, "用 execute 工具执行代码：return 6*7，并把返回值告诉我。")
  assert.ok(evs.some((e) => e.type === "session.execution.succeeded"), "执行未成功")
  const tools = q(`select data::text from session_message where session_id='${id}' and type='assistant' order by time_created`)
  const hasExecute = tools.includes('"name":"execute"') || tools.includes('"name":"codemode"')
  assert.ok(hasExecute, "未见 execute 工具调用")
  assert.ok(tools.includes("42") || lastAssistant(id).includes("42"), "未返回 42")
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

console.log(`\nai-conversation: ${R.length}/3 通过`)
process.exitCode = R.length === 3 ? 0 : 1
