// 补齐 concurrency 剩余 + saas-stability 剩余 + sse 心跳/文件变更（无模型类）
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:15193"
const pg = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const H = { authorization: auth, "content-type": "application/json" }
const q = (sql) => execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
const R = []
const t = async (id, fn) => { try { await fn(); R.push(id); console.log(`✓ ${id}`) } catch (e) { console.log(`✗ ${id}: ${String(e.message).slice(0, 130)}`) } }
const create = async (ti) => (await (await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: `x-${ti}-${Date.now()}`, location: { directory: "/workspace" } }) })).json()).data.id
const sh = async (id, command) => {
  const r = await fetch(base + `/api/session/${id}/shell`, { method: "POST", headers: H, body: JSON.stringify({ command, timeoutSeconds: 90 }) })
  if (![200, 204].includes(r.status)) throw new Error(`shell HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`)
  return JSON.parse(q(`select data from session_message where session_id='${id}' and type='shell' order by time_created desc limit 1`))
}
const kill = async (id) => (await fetch(base + `/api/session/${id}/kill-sandbox`, { method: "POST", headers: H, body: "{}" })).status
const ok = (d) => d.status === "exited" && d.exit === 0

await t("T39.1.2 连续 kill-sandbox 后命令仍可用", async () => {
  const id = await create("13912")
  await sh(id, "echo a")
  for (let i = 0; i < 3; i++) { const s = await kill(id); assert.ok([200, 204].includes(s), `kill#${i} ${s}`) }
  const d = await sh(id, "echo after-kills")
  assert.ok(ok(d) && JSON.stringify(d.output).includes("after-kills"), `连续 kill 后命令失败: ${JSON.stringify(d).slice(0, 120)}`)
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T39.2.1 interrupt 后立即发新命令仍可用", async () => {
  const id = await create("13921")
  await sh(id, "echo warm")
  const long = fetch(base + `/api/session/${id}/shell`, { method: "POST", headers: H, body: JSON.stringify({ command: "sleep 10", timeoutSeconds: 60 }) })
  await new Promise((r) => setTimeout(r, 2000))
  const it = await fetch(base + `/api/session/${id}/interrupt`, { method: "POST", headers: H })
  assert.ok([200, 204].includes(it.status))
  await long.catch(() => {})
  const d = await sh(id, "echo post-interrupt")
  assert.ok(ok(d), `interrupt 后命令失败: ${JSON.stringify(d).slice(0, 120)}`)
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T39.4.1 kill 后并发命令不用已死沙箱", async () => {
  const id = await create("13941")
  await sh(id, "echo warm")
  await kill(id)
  const rs = await Promise.all(Array.from({ length: 3 }, () => fetch(base + `/api/session/${id}/shell`, { method: "POST", headers: H, body: JSON.stringify({ command: "echo fresh-ok" }) })))
  for (const r of rs) assert.ok([200, 204].includes(r.status), `并发命令 HTTP ${r.status}`)
  await new Promise((r) => setTimeout(r, 3000))
  const d = await sh(id, "echo final")
  assert.ok(ok(d) && JSON.stringify(d.output).includes("final"), `kill 后命令异常: ${JSON.stringify(d).slice(0, 120)}`)
  const active = Number(q(`select count(*) from sandbox where session_id='${id}' and state<>'destroyed'`))
  assert.ok(active <= 1, `活动沙箱 ${active} 应≤1（不应有死沙箱残留）`)
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T13.1+T13.2 kill-sandbox 后数据保留并自动重建", async () => {
  const id = await create("t13132")
  await sh(id, "echo keepme > /workspace/keep.txt")
  await kill(id)
  const d = await sh(id, "cat /workspace/keep.txt")
  assert.ok(JSON.stringify(d.output).includes("keepme"), `重建后数据丢失: ${JSON.stringify(d).slice(0, 120)}`)
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T13.11 PG FK 级联（删 session 后 message 清零）", async () => {
  const id = await create("t1311")
  await sh(id, "echo fk")
  assert.ok(Number(q(`select count(*) from session_message where session_id='${id}'`)) >= 1)
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
  await new Promise((r) => setTimeout(r, 2000))
  assert.equal(Number(q(`select count(*) from session_message where session_id='${id}'`)), 0, "message 未级联清零")
  assert.equal(Number(q(`select count(*) from session_inbox where session_id='${id}'`)), 0, "inbox 未级联清零")
})

await t("T9.3 心跳：20 秒窗口出现 heartbeat", async () => {
  const ac = new AbortController()
  const r = await fetch(base + "/api/event", { headers: H, signal: ac.signal })
  let raw = ""
  const task = (async () => { try { for await (const c of r.body) raw += new TextDecoder().decode(c) } catch {} })()
  await new Promise((x) => setTimeout(x, 21000))
  ac.abort(); await task.catch(() => {})
  const hb = (raw.match(/^: heartbeat/gm) ?? []).length
  assert.ok(hb >= 1, `20 秒内心跳 ${hb} 次，应≥1`)
})

await t("T9.11 文件变更事件 filesystem.changed", async () => {
  const ac = new AbortController()
  const r = await fetch(base + "/api/event", { headers: H, signal: ac.signal })
  const evts = []
  let buf = ""
  const task = (async () => {
    try {
      for await (const c of r.body) {
        buf += new TextDecoder().decode(c)
        let i
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const f = buf.slice(0, i); buf = buf.slice(i + 2)
          const l = f.split("\n").find((x) => x.startsWith("data:"))
          if (l) { try { evts.push(JSON.parse(l.slice(5))) } catch {} }
        }
      }
    } catch {}
  })()
  await new Promise((x) => setTimeout(x, 600))
  const id = await create("t911")
  await sh(id, "echo changed > /workspace/change-probe.txt").catch(() => {})
  await new Promise((x) => setTimeout(x, 3000))
  ac.abort(); await task.catch(() => {})
  const has = evts.some((e) => String(e.type).includes("filesystem.changed"))
  assert.ok(has, "未收到 filesystem.changed")
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

console.log(`\nbatch-noModel: ${R.length}/7 通过`)
process.exitCode = R.length === 7 ? 0 : 1
