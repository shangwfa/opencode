// 增量判定补充：同一大内容快照连续恢复 3 次。
// 若首次慢后续快（递减）→ 层缓存效应（支持增量链）；若 3 次接近 → 弱支持自包含/全量。
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
async function runCommand(sid, command, timeoutSeconds = 900) {
  const posted = Date.now()
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
  const deadline = Date.now() + (timeoutSeconds + 90) * 1000
  while (Date.now() < deadline) {
    const ended = events.find((e) => e.type === "session.shell.ended")
    if (ended) {
      try { reader.cancel() } catch {}
      return { wallMs: Date.now() - posted, exit: ended.data?.shell?.exit ?? null }
    }
    await sleep(2000)
  }
  try { reader.cancel() } catch {}
  throw new Error("命令超时")
}
async function pg(chunks, ...vals) {
  const sql = new Bun.SQL(process.env.OPENCODE_DATABASE_URL)
  try { return await sql(chunks, ...vals) } finally { await sql.close() }
}
let sid = null
try {
  const created = await api("POST", "/api/session", { sandbox: { cpu: "2", memory: "4Gi", image, persistMode: "snapshot" } })
  sid = created.data.data.id
  await runCommand(sid, `cd /workspace && printf '{"name":"repeat","private":true,"dependencies":{"next":"16.3.8","react":"19.3.0","react-dom":"19.3.0"}}' > package.json && printf 'store-dir=.pnpm-store\\nregistry=https://registry.npmmirror.com/\\n' > .npmrc && pnpm install 2>&1 | tail -1 && du -sk /workspace | cut -f1`)
  const killStart = Date.now()
  await api("POST", `/api/session/${sid}/kill-sandbox`)
  for (let i = 0; i < 100; i++) {
    const rows = await pg`select state, time_created from session_snapshot where session_id = ${sid} order by time_created desc limit 1`
    if (rows[0] && rows[0].state === "ready" && Number(rows[0].time_created) >= killStart - 5000) { log("snapshot_ready", { ms: Date.now() - killStart }); break }
    await sleep(3000)
  }
  // 同一快照连续恢复 ×3（每次 kill 后再恢复）
  for (let i = 1; i <= 3; i++) {
    const r = await runCommand(sid, `cd /workspace && du -sk /workspace | cut -f1 && echo RESTORE_${i}`)
    log("restore", { round: i, wallMs: r.wallMs, exit: r.exit })
    await api("POST", `/api/session/${sid}/kill-sandbox`)
    // 等 CLEAN 复用销毁完成（内容无变化，不产生新快照）
    for (let j = 0; j < 40; j++) {
      const sb = await pg`select state from sandbox where session_id = ${sid}`
      if (sb[0]?.state === "destroyed") break
      await sleep(2000)
    }
  }
  log("done")
} catch (error) {
  log("failed", { error: String(error).slice(0, 400) })
} finally {
  if (sid) {
    await api("POST", `/api/session/${sid}/kill-sandbox`).catch(() => {})
    const del = await api("DELETE", `/api/session/${sid}`)
    log("cleanup", { status: del.status })
  }
}
