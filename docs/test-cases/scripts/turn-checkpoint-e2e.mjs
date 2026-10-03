// P0-2 验收：回合完成（含失败回合）触发检查点。
// 本地 PG 无 AI provider：POST message 的执行必然失败 → Execution.Failed → 应入队 snapshot_refresh。
// 观测：refresh 操作表中该会话出现 snapshot_refresh 行（去抖 10s；CLEAN 复用后 complete）。
const base = "http://127.0.0.1:4096"
const image = process.env.OPENCODE_SANDBOX_IMAGE
const headers = {
  "Content-Type": "application/json",
  Authorization: "Basic " + Buffer.from((process.env.OPENCODE_SERVER_USERNAME ?? "opencode") + ":" + (process.env.OPENCODE_SERVER_PASSWORD ?? process.env.OPENCODE_PASSWORD ?? "")).toString("base64"),
}
const t0 = Date.now()
const log = (step, data = {}) => console.log(JSON.stringify({ step, at: `${((Date.now() - t0) / 1000).toFixed(0)}s`, ...data }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let d = null
  try { d = JSON.parse(text) } catch {}
  return { status: r.status, ok: r.ok, data: d, text }
}
async function runCommand(sid, command, timeoutSeconds = 600) {
  const stream = await fetch(base + `/api/session/${sid}/event`, { headers })
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const events = []
  ;(async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))) } catch {} }
      }
    }
  })()
  await api("POST", `/api/session/${sid}/shell`, { command, timeoutSeconds })
  const deadline = Date.now() + (timeoutSeconds + 60) * 1000
  while (Date.now() < deadline) {
    const ended = events.find((e) => e.type === "session.execution.succeeded" || e.type === "session.execution.failed" || e.type === "session.shell.ended")
    if (ended) {
      try { reader.cancel() } catch {}
      const raw = ended.data?.output
      return { type: ended.type, output: typeof raw === "string" ? raw : String(raw?.output ?? "") }
    }
    await sleep(2000)
  }
  try { reader.cancel() } catch {}
  throw new Error("命令超时")
}
async function refreshOps(sid) {
  const sql = new Bun.SQL(process.env.OPENCODE_DATABASE_URL)
  const rows = await sql`select id, state, attempts, kind, error, time_created, time_updated from snapshot_refresh_operation where session_id = ${sid} order by time_created desc limit 5`
  await sql.close()
  return rows
}
async function sandboxRow(sid) {
  const sql = new Bun.SQL(process.env.OPENCODE_DATABASE_URL)
  const rows = await sql`select id, state from sandbox where session_id = ${sid}`
  await sql.close()
  return rows[0] ?? null
}
let sid = null
try {
  const created = await api("POST", "/api/session", { sandbox: { cpu: "2", memory: "4Gi", image, persistMode: "snapshot" } })
  sid = created.data.data.id
  log("session", { sid })

  // 建立沙箱 + 写内容（有实际变更，检查点应真实拍快照而不是 CLEAN 复用）
  await runCommand(sid, `cd /workspace && printf 'turn checkpoint probe\\n' > note.txt && echo WRITTEN`)
  log("sandbox", await sandboxRow(sid))
  log("ops_before", { ops: await refreshOps(sid) })

  // 触发一个必然失败的回合（无 AI provider）→ Execution.Failed → 应请求检查点
  const msg = await api("POST", `/api/session/${sid}/prompt`, {
    text: "turn checkpoint probe",
    model: { providerID: "missing-provider", id: "missing-model" },
  })
  log("prompt_post", { status: msg.status })
  // 等 Execution.Failed 事件 + 去抖(10s) + drain
  for (let i = 0; i < 20; i++) {
    await sleep(5000)
    const ops = await refreshOps(sid)
    if (ops.length > 0) { log("ops_after", { ops }); break }
    if (i === 19) log("ops_after", { ops: [] })
  }

  // 快照行：应出现新快照（内容有变更 note.txt）
  const sql = new Bun.SQL(process.env.OPENCODE_DATABASE_URL)
  const snaps = await sql`select id, state, time_created from session_snapshot where session_id = ${sid} order by time_created desc limit 3`
  await sql.close()
  log("snapshots", { snaps })
} catch (error) {
  log("failed", { error: String(error).slice(0, 400) })
} finally {
  if (sid) {
    await api("POST", `/api/session/${sid}/kill-sandbox`).catch(() => {})
    const del = await api("DELETE", `/api/session/${sid}`)
    log("cleanup", { status: del.status })
  }
}
