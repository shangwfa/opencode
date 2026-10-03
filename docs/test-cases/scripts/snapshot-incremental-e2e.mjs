// P1-1：远端 K8s 快照增量能力实验（SaaS 生产链路，单会话 5 代快照）。
// 判定：小改快照耗时若显著低于大增且接近固定开销 → 层增量；若与内容总量相关 → 全量。
// 代理指标：创建耗时（kill→ready）+ 恢复耗时（shell wall）。远端 API 无 size 字段。
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
      const raw = ended.data?.output
      return {
        wallMs: Date.now() - posted,
        exit: ended.data?.shell?.exit ?? null,
        output: typeof raw === "string" ? raw : String(raw?.output ?? ""),
      }
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
async function killAndSnapshot(sid, label) {
  const killStart = Date.now()
  await api("POST", `/api/session/${sid}/kill-sandbox`)
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    const rows = await pg`select id, state, time_created from session_snapshot where session_id = ${sid} order by time_created desc limit 1`
    const fresh = rows[0]
    if (fresh && Number(fresh.time_created ?? 0) >= killStart - 5000) {
      if (fresh.state === "ready") {
        const ms = Date.now() - killStart
        log("snapshot", { label, readyMs: ms, id: fresh.id.slice(0, 8) })
        return { label, ms }
      }
      if (fresh.state === "failed") throw new Error(`快照失败: ${fresh.id}`)
    }
    await sleep(3000)
  }
  throw new Error(`快照超时: ${label}`)
}
const stats = "du -sk /workspace | cut -f1; find /workspace -type f | wc -l"
const results = { snapshots: [], restores: [] }
let sid = null
try {
  const created = await api("POST", "/api/session", { sandbox: { cpu: "2", memory: "4Gi", image, persistMode: "snapshot" } })
  sid = created.data.data.id
  log("session", { sid })

  // 第1代：基线（2 文件）
  await runCommand(sid, `cd /workspace && printf 'base v1\\n' > a.txt && printf 'base v1\\n' > b.txt && ${stats}`)
  results.snapshots.push(await killAndSnapshot(sid, "G1_基线_2文件"))

  // 第2代：恢复 + 大量新增（pnpm install ~344MB）
  let r = await runCommand(sid, `cd /workspace && printf '{"name":"incr","private":true,"dependencies":{"next":"16.3.8","react":"19.3.0","react-dom":"19.3.0"}}' > package.json && printf 'store-dir=.pnpm-store\\nregistry=https://registry.npmmirror.com/\\n' > .npmrc && pnpm install 2>&1 | tail -1 && ${stats}`)
  results.restores.push({ label: "R2_恢复自基线", wallMs: r.wallMs })
  log("restore", { label: "R2_恢复自基线", wallMs: r.wallMs, output: r.output.trim() })
  results.snapshots.push(await killAndSnapshot(sid, "G2_大增_安装依赖"))

  // 第3-5代：恢复 + 小改（1 行）×3
  for (const [i, label] of ["G3_小改1行", "G4_小改1行", "G5_小改1行"].entries()) {
    r = await runCommand(sid, `cd /workspace && printf '\\n// small edit round ${i + 1}\\n' >> a.txt && ${stats}`)
    results.restores.push({ label: `R${i + 3}_恢复自上一代`, wallMs: r.wallMs })
    log("restore", { label: `R${i + 3}_恢复自上一代`, wallMs: r.wallMs, output: r.output.trim() })
    results.snapshots.push(await killAndSnapshot(sid, label))
  }

  // 汇总
  const pick = (arr, k) => arr.map((x) => Math.round(x[k] / 100) / 10)
  log("summary", {
    snapshots: results.snapshots.map((s) => `${s.label}=${(s.ms / 1000).toFixed(1)}s`),
    restores: results.restores.map((s) => `${s.label}=${(s.wallMs / 1000).toFixed(1)}s`),
    analysis: {
      bigAddS: (results.snapshots[1]?.ms ?? 0) / 1000,
      smallEditS: results.snapshots.slice(2).map((s) => +(s.ms / 1000).toFixed(1)),
      smallEditAvgS: results.snapshots.slice(2).length
        ? +(results.snapshots.slice(2).reduce((a, b) => a + b.ms, 0) / results.snapshots.slice(2).length / 1000).toFixed(1)
        : null,
    },
  })
} catch (error) {
  log("failed", { error: String(error).slice(0, 500) })
} finally {
  if (sid) {
    await api("POST", `/api/session/${sid}/kill-sandbox`).catch(() => {})
    const del = await api("DELETE", `/api/session/${sid}`)
    log("cleanup", { status: del.status })
  }
}
