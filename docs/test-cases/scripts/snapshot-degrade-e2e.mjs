// P0-1 降级档验收（两阶段）：
// 阶段A（正常容器）：建 snapshot 会话 → 写文件 → kill（快照1 ready）→ 恢复 → 再写文件（制造 dirty）
// 阶段B（waitMs=1s 容器）：kill → 快照 5 次重试全 timeout → 降级：接受旧快照销毁 + degraded 事件
// 用法: PHASE=A|B bun /tmp/degrade-e2e.mjs
const PHASE = process.env.PHASE ?? "A"
const STATE_FILE = "/tmp/degrade-e2e-state.json"
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
    const ended = events.find((e) => e.type === "session.shell.ended")
    if (ended) {
      try { reader.cancel() } catch {}
      return { exit: ended.data?.shell?.exit ?? null }
    }
    await sleep(2000)
  }
  try { reader.cancel() } catch {}
  throw new Error("命令超时")
}
async function pg(chunks, ...vals) {
  const sql = new Bun.SQL(process.env.OPENCODE_DATABASE_URL)
  try {
    return await sql(chunks, ...vals)
  } finally {
    await sql.close()
  }
}

if (PHASE === "A") {
  let sid = null
  try {
    const created = await api("POST", "/api/session", { sandbox: { cpu: "2", memory: "4Gi", image, persistMode: "snapshot" } })
    sid = created.data.data.id
    log("session", { sid })
    await runCommand(sid, `cd /workspace && printf 'baseline v1\\n' > work.txt && echo BASELINE`)
    await api("POST", `/api/session/${sid}/kill-sandbox`)
    // 等快照1 ready
    for (let i = 0; i < 60; i++) {
      const rows = await pg`select state from session_snapshot where session_id = ${sid} order by time_created desc limit 1`
      if (rows[0]?.state === "ready") { log("snapshot1_ready"); break }
      await sleep(3000)
    }
    // 恢复 + 制造变更（dirty：销毁时必尝试新快照）
    await runCommand(sid, `cd /workspace && printf 'uncommitted v2 changes\\n' >> work.txt && echo DIRTY_MADE`)
    log("dirty_made")
    const { writeFileSync } = await import("node:fs")
    writeFileSync(STATE_FILE, JSON.stringify({ sid }))
    log("phase_a_done", { sid, note: "保持会话存活；下一步用 waitMs=1 重建容器后跑 PHASE=B" })
  } catch (error) {
    log("failed", { error: String(error).slice(0, 400) })
  }
} else {
  const { readFileSync } = await import("node:fs")
  const { sid } = JSON.parse(readFileSync(STATE_FILE, "utf8"))
  log("phase_b", { sid })
  // 恢复 + 立即制造新 dirty + 马上 kill：不给周期/回合检查点提前拍摄的时间
  await runCommand(sid, `cd /workspace && printf 'degrade probe dirty\\n' >> work.txt && echo DEGRADE_DIRTY`)
  log("dirty_refreshed")
  const kill = await api("POST", `/api/session/${sid}/kill-sandbox`)
  log("kill_posted", { status: kill.status })
  // 轮询最长 12 分钟：观察 attempts 增长 → 降级 → 销毁完成
  let lastAttempts = -1
  const deadline = Date.now() + 720_000
  while (Date.now() < deadline) {
    const ops = await pg`select state, attempts, error from snapshot_operation where session_id = ${sid} and kind = 'snapshot_destroy' order by time_created desc limit 1`
    const sb = await pg`select id, state from sandbox where session_id = ${sid}`
    const op = ops[0]
    if (op && Number(op.attempts) !== lastAttempts) {
      log("op_progress", { attempts: op.attempts, state: op.state, error: String(op.error).slice(0, 120) })
      lastAttempts = Number(op.attempts)
    }
    if (op?.state === "completed" || sb[0]?.state === "destroyed") {
      log("destroy_finished", { op: op?.state, sandbox: sb[0]?.state })
      break
    }
    if (op?.state === "failed") { log("dead_lettered", { op }); break }
    await sleep(5000)
  }
  // 终态验收
  const ops = await pg`select state, attempts, error from snapshot_operation where session_id = ${sid} and kind = 'snapshot_destroy' order by time_created desc limit 1`
  const sb = await pg`select id, state from sandbox where session_id = ${sid}`
  const snaps = await pg`select id, state from session_snapshot where session_id = ${sid} order by time_created desc`
  log("final", { operation: ops[0], sandbox: sb[0], snapshots: snaps.map((s) => ({ id: s.id.slice(0, 8), state: s.state })) })
  // degraded 事件（事件表/日志）——从 PG 事件 durable 表找 snapshot.failed reason 含 degraded
  const ev = await pg`select data from event where aggregate_id = ${sid} order by created desc limit 20`
  const degraded = (ev ?? []).filter((e) => String(e.data?.reason ?? "").includes("degraded"))
  log("degraded_events", { count: degraded.length, reasons: degraded.slice(0, 2).map((e) => String(e.data?.reason).slice(0, 140)) })
  // 清理
  const del = await api("DELETE", `/api/session/${sid}`)
  log("cleanup", { status: del.status })
}
