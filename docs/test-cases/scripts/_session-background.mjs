// background/README.md B1.1：shell 工具 background:true → nohup + 日志文件 + 真实完成
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:15193"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const H = { authorization: auth, "content-type": "application/json" }
const model = { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }
const results = []
const t = async (id, fn) => { try { await fn(); results.push(id); console.log(`✓ ${id}`) } catch (e) { console.log(`✗ ${id}: ${String(e.message).slice(0, 140)}`) } }

const id = (await (await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: `bg-${Date.now()}`, model, location: { directory: "/workspace" } }) })).json()).data.id
const marker = "BG_DONE_" + Math.random().toString(16).slice(2, 8).toUpperCase()

await t("B1.1 后台 shell：立即返回日志路径 + 进程真实完成", async () => {
  const r = await fetch(base + `/api/session/${id}/prompt_stream`, {
    method: "POST", headers: H,
    body: JSON.stringify({ text: `用 shell 工具后台运行（background=true）命令：sleep 10 && echo ${marker}。报告工具返回的原始信息（含输出文件路径）。`, model }),
    signal: AbortSignal.timeout(180000),
  })
  const body = await r.text()
  const evs = body.split("\n").filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)) } catch { return null } }).filter(Boolean)
  assert.ok(evs.some((e) => e.type === "session.execution.succeeded"), "执行未成功")
  const msgs = (await (await fetch(base + `/api/session/${id}/message?order=asc&limit=200`, { headers: H })).json()).data
  const tools = msgs.filter((m) => m.type === "assistant").flatMap((m) => m.content ?? []).filter((p) => p.type === "tool" && p.name === "shell")
  assert.ok(tools.length >= 1, "未调用 shell 工具")
  const call = tools.at(-1)
  assert.equal(call.state.status, "completed", `工具状态 ${call.state.status}`)
  const out = JSON.stringify(call.state)
  assert.ok(out.includes("background"), `应提示已转后台，实际 ${out.slice(0, 200)}`)
  const path = out.match(/\/tmp\/opencode-bg-[^"\\ ]+\.log/)?.[0]
  assert.ok(path, `未返回日志文件路径：${out.slice(0, 200)}`)
  // 等后台进程跑完再读日志
  await new Promise((x) => setTimeout(x, 14000))
  // /tmp 在 /workspace 之外，fs API 按设计返回 404；改走 shell API 读取
  const nope = await fetch(base + `/api/session/${id}/fs/read/${path.replace(/^\//, "")}`, { headers: H })
  assert.equal(nope.status, 404, `工作区外路径应 404，实际 ${nope.status}`)
  await fetch(base + `/api/session/${id}/shell`, { method: "POST", headers: H, body: JSON.stringify({ command: `cat ${path}`, timeoutSeconds: 60 }) })
  const pg = process.env.PG_URL
  const raw = execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", `select data from session_message where session_id='${id}' and type='shell' order by time_created desc limit 1`], { encoding: "utf8" }).trim()
  const data = JSON.parse(raw)
  assert.equal(data.status, "exited", `shell 状态 ${data.status}`)
  assert.ok(String(data.output?.output ?? "").includes(marker), `日志应含 ${marker}，实际 ${String(data.output?.output ?? "").slice(0, 120)}`)
})

await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
console.log(`\nbackground: ${results.length}/1 通过`)
process.exitCode = results.length === 1 ? 0 : 1
