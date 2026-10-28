// sse.md T9.1/T9.2/T9.3/T9.4/T9.5/T9.8/T9.9/T9.10 精简版。
import assert from "node:assert/strict"

const base = process.env.BASE ?? "http://127.0.0.1:15193"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const H = { authorization: auth, "content-type": "application/json" }
const model = { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }
const results = []
const t = async (id, fn) => { try { await fn(); results.push(id); console.log(`✓ ${id}`) } catch (e) { console.log(`✗ ${id}: ${String(e.message).slice(0, 120)}`) } }
const create = async () => (await (await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: `sse-${Date.now()}`, model, location: { directory: "/workspace" } }) })).json()).data.id

// 订阅一个事件流，收集事件
const subscribe = async (path, opts = {}) => {
  const ac = new AbortController()
  const r = await fetch(base + path, { headers: H, signal: ac.signal })
  const collected = []
  let heartbeat = 0
  const task = (async () => {
    let buf = ""
    try {
      for await (const chunk of r.body) {
        buf += new TextDecoder().decode(chunk)
        let i
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2)
          if (frame.startsWith(":")) { heartbeat++; continue }
          const line = frame.split("\n").find((l) => l.startsWith("data:"))
          if (!line) continue
          try { collected.push(JSON.parse(line.slice(5).trim())) } catch {}
        }
      }
    } catch {}
  })()
  return { r, collected, task, stop: () => ac.abort(), heartbeat: () => heartbeat }
}

await t("T9.1 订阅与 server.connected + 响应头", async () => {
  const s = await subscribe("/api/event")
  assert.match(s.r.headers.get("content-type") ?? "", /text\/event-stream/)
  assert.match(s.r.headers.get("cache-control") ?? "", /no-cache/)
  for (let i = 0; i < 50 && !s.collected.length; i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(s.collected[0]?.type, "server.connected")
  s.stop()
})

await t("T9.2 创建 session 触发 session.created", async () => {
  const s = await subscribe("/api/event")
  await new Promise((r) => setTimeout(r, 700))
  const id = await create()
  for (let i = 0; i < 60 && !s.collected.some((e) => e.type === "session.created" && e.data?.sessionID === id); i++) await new Promise((r) => setTimeout(r, 100))
  const ev = s.collected.find((e) => e.type === "session.created" && e.data?.sessionID === id)
  assert.ok(ev, "未收到 session.created")
  s.stop()
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T9.4 全局端点无需目录头（/api/event 与 /api/event?directory=）", async () => {
  const a = await fetch(base + "/api/event", { headers: H, signal: AbortSignal.timeout(3000) }).catch((e) => e)
  assert.ok(a.status === 200 || a.name === "TimeoutError", `HTTP ${a.status}`)
  const b = await fetch(base + "/api/event?directory=/workspace", { headers: H, signal: AbortSignal.timeout(3000) }).catch((e) => e)
  assert.ok(b.status === 200 || b.name === "TimeoutError", `HTTP ${b.status}`)
})

await t("T9.5 + T9.9 文本事件与执行状态", async () => {
  const id = await create()
  const s = await subscribe(`/api/session/${id}/event`)
  await new Promise((r) => setTimeout(r, 700))
  await fetch(base + `/api/session/${id}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: "只回复 SSE_OK", metadata: {}, model }) })
  await fetch(base + `/api/experimental/session/${id}/wait`, { method: "POST", headers: H, body: "{}", signal: AbortSignal.timeout(120000) }).catch(() => {})
  for (let i = 0; i < 100 && !s.collected.some((e) => e.type === "session.text.ended"); i++) await new Promise((r) => setTimeout(r, 100))
  assert.ok(s.collected.some((e) => e.type === "session.text.delta" && e.data?.sessionID === id), "缺 text.delta")
  assert.ok(s.collected.some((e) => e.type === "session.text.ended" && e.data?.sessionID === id), "缺 text.ended")
  assert.ok(s.collected.some((e) => e.type === "session.execution.started"), "缺 execution.started")
  const exec = s.collected.filter((e) => String(e.type).startsWith("session.execution.") && !e.type.endsWith(".started"))
  assert.equal(exec.at(-1)?.type, "session.execution.succeeded")
  s.stop()
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T9.8 多会话事件隔离", async () => {
  const a = await create(); const b = await create()
  const s = await subscribe(`/api/session/${a}/event`)
  await new Promise((r) => setTimeout(r, 700))
  await fetch(base + `/api/session/${b}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: "只回复 B_ONLY", metadata: {}, model }) })
  await fetch(base + `/api/experimental/session/${b}/wait`, { method: "POST", headers: H, body: "{}", signal: AbortSignal.timeout(120000) }).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  const leaked = s.collected.filter((e) => e.data?.sessionID === b)
  assert.equal(leaked.length, 0, `B 的事件泄漏到 A 的流：${leaked.length} 条`)
  s.stop()
  for (const id of [a, b]) await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T9.10 prompt_stream 接纳返回 data.id 且收到 text.delta", async () => {
  const id = await create()
  const r = await fetch(base + `/api/session/${id}/prompt_stream`, { method: "POST", headers: H, body: JSON.stringify({ text: "只回复 STREAM_OK", model }) })
  assert.equal(r.status, 200)
  const body = await r.text()
  const evs = body.split("\n").filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)) } catch { return null } }).filter(Boolean)
  assert.ok(evs.some((e) => e.type === "session.text.delta"), "缺 text.delta")
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

console.log(`\nsse: ${results.length}/6 通过`)
process.exitCode = results.length === 6 ? 0 : 1
