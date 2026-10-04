// 历史脚本：曾验证接受旧恢复点后销毁dirty源，已不符合当前保护契约。
// 保留历史步骤作审计，禁止运行；新入口使用专用代理，不停止源容器。
throw new Error("旧降级验收已停用，请运行 docs/test-cases/scripts/sandbox-lifecycle-safety-v2.mjs")
// 降级档全链路验收 v2（本地平台直连 + 停容器注入快照失败）：
// 1) 正常：建会话 → 基线快照 → 恢复 → 制造 dirty
// 2) 注入：docker stop 沙箱容器（execd 不可用 → marker/快照必然失败）
// 3) kill → 5 次重试全失败 → 降级：接受旧快照销毁 + degraded durable 事件
// 4) 验收：operation 终态、sandbox destroyed、基线快照保留、事件可检索
const base = "http://127.0.0.1:4096"
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
  try { return await sql(chunks, ...vals) } finally { await sql.close() }
}
let sid = null
try {
  // 阶段 A：基线快照 + dirty（全正常链路）
  const created = await api("POST", "/api/session", { sandbox: { cpu: "2", memory: "4Gi", image: "opencode-opensandbox:local", persistMode: "snapshot" } })
  sid = created.data.data.id
  log("session", { sid })
  await runCommand(sid, `cd /workspace && printf 'baseline v1\\n' > work.txt && echo BASELINE`)
  await api("POST", `/api/session/${sid}/kill-sandbox`)
  let baselineID = null
  for (let i = 0; i < 60; i++) {
    const rows = await pg`select id, state from session_snapshot where session_id = ${sid} order by time_created desc limit 1`
    if (rows[0]?.state === "ready") { baselineID = rows[0].id; log("baseline_ready", { id: baselineID.slice(0, 8) }); break }
    if (rows[0]?.state === "failed") throw new Error("基线快照失败: " + JSON.stringify(rows[0]))
    await sleep(3000)
  }
  await runCommand(sid, `cd /workspace && printf 'degrade probe dirty\\n' >> work.txt && echo DIRTY`)
  const sbRow = await pg`select id, state from sandbox where session_id = ${sid}`
  log("sandbox_running", sbRow[0])

  // 阶段 B：注入——停止沙箱容器（execd 不可用，快照必失败）
  log("inject_stop_container", { hint: `docker stop sandbox-${sbRow[0].id} 由宿主执行` })
  // 宿主侧已由外部脚本 stop；此脚本等待被外部标记 /tmp/degrade-inject-ready
  const { existsSync, readFileSync } = await import("node:fs")
  for (let i = 0; i < 120 && !existsSync("/tmp/degrade-inject-ready"); i++) await sleep(1000)
  if (!existsSync("/tmp/degrade-inject-ready")) throw new Error("等待注入标记超时")
  log("inject_confirmed")

  // kill → 观察重试与降级（最长 13 分钟）
  const kill = await api("POST", `/api/session/${sid}/kill-sandbox`)
  log("kill_posted", { status: kill.status })
  let lastKey = ""
  const deadline = Date.now() + 780_000
  while (Date.now() < deadline) {
    const ops = await pg`select state, attempts, error from snapshot_operation where session_id = ${sid} and kind = 'snapshot_destroy' order by time_created desc limit 1`
    const sb = await pg`select state from sandbox where session_id = ${sid}`
    const op = ops[0]
    const key = `${op?.state}:${op?.attempts}:${sb[0]?.state}`
    if (op && key !== lastKey) {
      log("progress", { opState: op.state, attempts: op.attempts, sandbox: sb[0]?.state, error: String(op.error).slice(0, 110) })
      lastKey = key
    }
    if (sb[0]?.state === "destroyed" || op?.state === "failed") { log("terminal", { op: op?.state, sandbox: sb[0]?.state }); break }
    await sleep(5000)
  }
  // 终态验收
  const ops = await pg`select state, attempts, error from snapshot_operation where session_id = ${sid} and kind = 'snapshot_destroy' order by time_created desc limit 1`
  const sb = await pg`select state from sandbox where session_id = ${sid}`
  const snaps = await pg`select id, state from session_snapshot where session_id = ${sid} order by time_created desc`
  let degradedEvents = []
  try {
    const ev = await pg`select data from event where aggregate_id = ${sid} order by created desc limit 40`
    degradedEvents = (ev ?? []).filter((e) => String(e.data?.reason ?? "").includes("degraded")).map((e) => String(e.data?.reason).slice(0, 170))
  } catch (e) { log("event_query_note", { error: String(e).slice(0, 100) }) }
  log("verdict", {
    operation: ops[0] ? { state: ops[0].state, attempts: ops[0].attempts } : null,
    sandboxDestroyed: sb[0]?.state === "destroyed",
    baselineRetained: snaps.some((s) => s.id === baselineID && (s.state === "ready" || s.state === "stale")),
    snapshots: snaps.map((s) => ({ id: s.id.slice(0, 8), state: s.state })),
    degradedEvents,
    degradedAsExpected: sb[0]?.state === "destroyed" && degradedEvents.length > 0 && Number(ops[0]?.attempts ?? 0) >= 5,
  })
} catch (error) {
  log("failed", { error: String(error).slice(0, 500) })
} finally {
  const { unlinkSync } = await import("node:fs")
  try { unlinkSync("/tmp/degrade-inject-ready") } catch {}
  if (sid) {
    await api("POST", `/api/session/${sid}/kill-sandbox`).catch(() => {})
    const del = await api("DELETE", `/api/session/${sid}`)
    log("cleanup", { status: del.status })
  }
}
