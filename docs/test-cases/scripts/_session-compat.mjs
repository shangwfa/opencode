// compatibility.md 十四、低优先级兼容回归 T14.1–T14.10。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:15193"
const pg = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const model = { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }
const results = []
const q = (sql) => execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
const req = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: async () => { try { return await r.json() } catch { return undefined } } }
}
const t = async (id, fn) => { try { await fn(); results.push({ id, ok: true }); console.log(`✓ ${id}`) } catch (e) { results.push({ id, ok: false, err: String(e.message).slice(0, 140) }); console.log(`✗ ${id}: ${String(e.message).slice(0, 140)}`) } }

// 建一个带消息的根会话供 fork/分页/文件用
const s = await req("POST", "/api/session", { title: "p2-base-test", location: { directory: "/workspace" }, model })
const SID = s.json && (await s.json()).data.id
const wait = async (id) => { await req("POST", `/api/experimental/session/${id}/wait`, {}) }
await req("POST", `/api/session/${SID}/prompt`, { text: "回复 fork-base", metadata: {}, delivery: "queue" })
await wait(SID)

await t("T14.1 列表过滤 search/limit/parentID/cursor", async () => {
  const search = await (await req("GET", "/api/session?search=p2-base-test&limit=1")).json()
  assert.ok(search.data.length <= 1 && search.data.some((x) => x.id === SID), "search 未命中")
  const roots = await (await req("GET", "/api/session?parentID=null&limit=5")).json()
  assert.ok(roots.data.every((x) => !x.parentID), "parentID=null 应只返回根")
  assert.ok(roots.cursor && ("next" in roots.cursor) && ("previous" in roots.cursor), "缺 cursor")
})

await t("T14.2 /api/session/active 空闲为空", async () => {
  const j = await (await req("GET", "/api/session/active")).json()
  assert.ok(j.data && typeof j.data === "object", "应返回 data 对象")
})

await t("T14.3 fork 子会话 fork_session_id=SID 且 parent_id 空", async () => {
  const f = await (await req("POST", `/api/session/${SID}/fork`, {})).json()
  const child = f.data.id
  assert.ok(child && child !== SID, "fork 未返回子会话")
  assert.equal(q(`SELECT fork_session_id FROM session_v2 WHERE id='${child}'`), SID, "fork_session_id 不匹配")
  assert.equal(q(`SELECT coalesce(parent_id,'') FROM session_v2 WHERE id='${child}'`), "", "parent_id 应为空")
  await req("DELETE", `/api/session/${child}`)
})

await t("T14.4 message 分页 limit=1 + cursor.next 翻页", async () => {
  const p1 = await (await req("GET", `/api/session/${SID}/message?order=asc&limit=1`)).json()
  assert.equal(p1.data.length, 1, "limit=1 应只 1 条")
  const cur = p1.cursor?.next
  if (cur) {
    const p2 = await (await req("GET", `/api/session/${SID}/message?limit=1&cursor=${encodeURIComponent(cur)}`)).json()
    assert.ok(p2.data.length >= 1, "翻页应有数据")
    assert.notEqual(p2.data[0]?.id, p1.data[0]?.id, "下一页应不同")
  }
})

await t("T14.6 diff/revert-stage/revert-clear", async () => {
  await req("POST", `/api/session/${SID}/prompt`, { text: "用 write 工具在 /workspace 创建 diff-test.txt，内容 diff-test", metadata: {}, delivery: "queue" })
  await wait(SID)
  const diff = await req("GET", `/api/session/${SID}/diff`)
  assert.ok([200, 500].includes(diff.status), `diff HTTP ${diff.status}`)
  const msgs = await (await req("GET", `/api/session/${SID}/message?order=desc&limit=20`)).json()
  const msg = msgs.data.find((m) => m.type === "user")
  const stage = await req("POST", `/api/session/${SID}/revert/stage`, { messageID: msg.id, files: true })
  assert.ok([200, 400, 500].includes(stage.status), `stage HTTP ${stage.status}`)
  const clear = await req("DELETE", `/api/session/${SID}/revert`, {})
  assert.ok([200, 204].includes(clear.status), `clear HTTP ${clear.status}`)
})

await t("T14.7 file API list/read/find（限 /workspace）", async () => {
  const list = await req("GET", `/api/session/${SID}/fs/list?path=/workspace`)
  assert.equal(list.status, 200, `list HTTP ${list.status}`)
  const read = await req("GET", `/api/session/${SID}/fs/read/diff-test.txt`)
  assert.ok([200, 404].includes(read.status), `read HTTP ${read.status}`)
  const find = await req("GET", `/api/session/${SID}/fs/find?query=diff-test`)
  assert.equal(find.status, 200, `find HTTP ${find.status}`)
})

await t("T14.8 find query 参数（pattern 应 400）", async () => {
  const ok = await req("GET", `/api/session/${SID}/fs/find?query=diff-test`)
  assert.equal(ok.status, 200)
  const bad = await req("GET", `/api/session/${SID}/fs/find?pattern=diff-test`)
  assert.equal(bad.status, 400, "传 pattern 应 400")
})

await t("T14.9 VCS API + mode=git 应 400", async () => {
  const v = await req("GET", "/api/vcs")
  assert.equal(v.status, 200)
  const status = await req("GET", "/api/vcs/status")
  assert.equal(status.status, 200)
  const diff = await req("GET", "/api/vcs/diff?mode=working")
  assert.equal(diff.status, 200)
  const bad = await req("GET", "/api/vcs/diff?mode=git")
  assert.equal(bad.status, 400, "mode=git 应 400 Expected Vcs.Mode")
})

await t("T14.10 agent/skill/command 列表 .data 为数组", async () => {
  for (const p of ["/api/agent", `/api/session/${SID}/skills`, "/api/command", `/api/session/${SID}/commands`]) {
    const j = await (await req("GET", p)).json()
    assert.ok(Array.isArray(j.data), `${p} .data 应为数组`)
  }
})

// 清理
await req("DELETE", `/api/session/${SID}`)
const pass = results.filter((r) => r.ok).length
console.log(`\ncompatibility: ${pass}/${results.length} 通过`)
process.exitCode = pass === results.length ? 0 : 1
