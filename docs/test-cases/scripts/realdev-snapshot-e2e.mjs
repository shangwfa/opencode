// 真实开发场景 × 远端 K8s 沙箱快照耗时 E2E（走 SaaS 生产链路）。
// 场景链：空区快照 → 恢复+写 Next.js 项目 → 装依赖 → 小改动 → next build → 无变化复用 → 恢复验证。
// 每步观测：恢复耗时 / 命令耗时 / kill→快照 ready 耗时 / workspace 规模 / PG 快照行。
const base = "http://127.0.0.1:4096"
const image = process.env.OPENCODE_SANDBOX_IMAGE
const headers = {
  "Content-Type": "application/json",
  Authorization: "Basic " + Buffer.from((process.env.OPENCODE_SERVER_USERNAME ?? "opencode") + ":" + (process.env.OPENCODE_SERVER_PASSWORD ?? process.env.OPENCODE_PASSWORD ?? "")).toString("base64"),
}
const t0 = Date.now()
const at = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`
const log = (step, data = {}) => console.log(JSON.stringify({ step, at: at(), ...data }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let d = null
  try { d = JSON.parse(text) } catch {}
  return { status: r.status, ok: r.ok, data: d, text }
}

// ---- shell：开 SSE → POST shell → 等 session.shell.ended ----
async function runCommand(sid, command, timeoutSeconds = 600) {
  const stream = await fetch(base + `/api/session/${sid}/event`, { headers })
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const events = []
  const pump = (async () => {
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
  const posted = Date.now()
  const shell = await api("POST", `/api/session/${sid}/shell`, { command, timeoutSeconds })
  if (!shell.ok) {
    try { reader.cancel() } catch {}
    throw new Error(`shell POST ${shell.status}: ${shell.text.slice(0, 300)}`)
  }
  const deadline = Date.now() + (timeoutSeconds + 120) * 1000
  while (Date.now() < deadline) {
    const ended = events.find((e) => e.type === "session.shell.ended")
    if (ended) {
      try { reader.cancel() } catch {}
      const raw = ended.data?.output
      return {
        wallMs: Date.now() - posted,
        execMs: ended.data?.shell?.time?.completed != null && ended.data?.shell?.time?.started != null
          ? ended.data.shell.time.completed - ended.data.shell.time.started : null,
        exit: ended.data?.shell?.exit ?? null,
        status: ended.data?.shell?.status ?? null,
        output: typeof raw === "string" ? raw : String(raw?.output ?? ""),
      }
    }
    await sleep(2000)
  }
  try { reader.cancel() } catch {}
  throw new Error(`命令超时未收到 ended: ${command.slice(0, 80)}`)
}

// ---- PG 快照行 ----
async function snapshotRows(sid) {
  const sql = new Bun.SQL(process.env.OPENCODE_DATABASE_URL)
  const rows = await sql`select id, state, reason, image, manifest_token, restored_count, time_created, time_updated
    from session_snapshot where session_id = ${sid} order by time_created desc`
  await sql.close()
  return rows
}

// ---- kill-sandbox → 轮询销毁 + 判定新快照 ready 或复用 ----
// 销毁语义是"先快照 Ready 再销毁"，所以 sandboxId 清空即快照流程已结束；
// 之后只需区分：kill 后新建的快照行（time_created >= killStart-5s）→ 等它 ready，
// 或没有新行 → 复用了既有快照（再观察 2 轮确认不出现新行）。
async function killAndSnapshot(sid, label) {
  const killStart = Date.now()
  const kill = await api("POST", `/api/session/${sid}/kill-sandbox`)
  if (!kill.ok) throw new Error(`kill-sandbox ${kill.status}: ${kill.text.slice(0, 200)}`)
  let destroyed = null
  let ready = null
  let reused = false
  let quietPolls = 0
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    const info = await api("GET", `/api/session/${sid}/sandbox`)
    const gone = info.ok && !info.data.sandboxId
    if (gone && destroyed == null) destroyed = Date.now() - killStart
    const rows = await snapshotRows(sid)
    const fresh = rows.find((r) => Number(r.time_created) >= killStart - 5000)
    if (fresh) {
      if (fresh.state === "ready" && ready == null) ready = Date.now() - killStart
      if (fresh.state === "failed") throw new Error(`快照失败: ${fresh.reason}`)
      quietPolls = 0
    } else if (destroyed != null) {
      quietPolls++
      if (quietPolls >= 3) { reused = true; ready = ready ?? destroyed; break }
    }
    if (destroyed != null && ready != null) break
    await sleep(3000)
  }
  const rows = await snapshotRows(sid)
  log("snapshot", { label, destroyMs: destroyed, snapshotReadyMs: ready, reused, snapshots: rows.length, latest: rows[0] ? { id: rows[0].id.slice(0, 8), state: rows[0].state, created: rows[0].time_created, updated: rows[0].time_updated } : null })
  return { destroyMs: destroyed, readyMs: ready, reused, latest: rows[0] }
}

async function restoreAndRun(sid, label, command, timeoutSeconds = 600) {
  const restore = await runCommand(sid, command, timeoutSeconds)
  const info = await api("GET", `/api/session/${sid}/sandbox`)
  log("restore_run", { label, wallMs: restore.wallMs, execMs: restore.execMs, exit: restore.exit, sandboxId: info.ok ? (info.data.sandboxId ?? null) : null, output: restore.output.slice(0, 400) })
  return restore
}

const stats = "du -sk /workspace 2>/dev/null | head -1; find /workspace -type f 2>/dev/null | wc -l"
const project = `cd /workspace && mkdir -p app components && printf '{"name":"realdev-snapshot","private":true,"scripts":{"dev":"next dev","build":"next build"},"dependencies":{"next":"16.3.8","react":"19.3.0","react-dom":"19.3.0"}}' > package.json && printf 'store-dir=.pnpm-store\\nregistry=https://registry.npmmirror.com/\\n' > .npmrc && printf 'export default function Layout({children}){return <html><body>{children}</body></html>}\\n' > app/layout.jsx && printf 'export default function Page(){return <main>realdev snapshot e2e</main>}\\n' > app/page.jsx && printf 'export function Card({children}){return <section>{children}</section>}\\n' > components/card.jsx && printf 'node_modules/\\n.next/\\n.pnpm-store/\\n' > .gitignore && echo PROJECT_WRITTEN && ${stats}`

let sid = null
const results = {}
try {
  // 创建 snapshot 模式会话（生产默认资源）
  const created = await api("POST", "/api/session", { sandbox: { cpu: "2", memory: "4Gi", image, persistMode: "snapshot" } })
  if (!created.ok) throw new Error("创建会话失败: " + created.text.slice(0, 200))
  sid = created.data.data.id
  log("session", { sid, image, persistMode: "snapshot" })

  // S0 空工作区基线
  await runCommand(sid, `cd /workspace && ${stats}`)
  results.s0_empty = await killAndSnapshot(sid, "S0_空工作区")

  // S1 恢复 + 写项目文件
  results.s1_write = await restoreAndRun(sid, "S1_写项目文件", project)
  await killAndSnapshot(sid, "S1_源码就绪")

  // S2 恢复 + 安装依赖
  results.s2_install = await restoreAndRun(sid, "S2_安装依赖", `cd /workspace && pnpm install 2>&1 | tail -3 && echo INSTALL_OK && ${stats}`, 900)
  results.s2_snapshot = await killAndSnapshot(sid, "S2_依赖已安装")

  // S3 恢复 + 小改动两份源码
  results.s3_edit = await restoreAndRun(sid, "S3_小改动源码", `cd /workspace && printf '\\n// realdev edit 1\\n' >> app/page.jsx && printf '\\n// realdev edit 2\\n' >> components/card.jsx && echo EDIT_OK && ${stats}`)
  results.s3_snapshot = await killAndSnapshot(sid, "S3_小改动后")

  // S4 恢复 + next build 真实构建
  results.s4_build = await restoreAndRun(sid, "S4_next_build", `cd /workspace && pnpm build 2>&1 | tail -5 && echo BUILD_OK && ${stats}`, 900)
  results.s4_snapshot = await killAndSnapshot(sid, "S4_构建产物后")

  // S5 恢复 + 无变化（预期复用）
  results.s5_nochange = await restoreAndRun(sid, "S5_无变化", `cd /workspace && echo NOCHANGE_OK && ${stats}`)
  results.s5_snapshot = await killAndSnapshot(sid, "S5_无变化复用")

  // S6 最终恢复验证
  results.s6_verify = await restoreAndRun(sid, "S6_恢复验证", `cd /workspace && ls node_modules/.bin/next .next app components 2>&1 | head -5 && grep -c "realdev edit" app/page.jsx components/card.jsx && wc -c app/page.jsx && echo VERIFY_OK && ${stats}`)

  log("summary", { steps: Object.keys(results), snapshots: (await snapshotRows(sid)).length })
} catch (error) {
  log("failed", { error: String(error).slice(0, 500) })
} finally {
  if (sid) {
    await api("POST", `/api/session/${sid}/kill-sandbox`).catch(() => {})
    const del = await api("DELETE", `/api/session/${sid}`)
    log("cleanup", { status: del.status })
  }
}
