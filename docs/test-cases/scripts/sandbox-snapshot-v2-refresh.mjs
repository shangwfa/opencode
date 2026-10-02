// 快照保鲜 + prune E2E（实例 B：REFRESH_SEC=30 + PRUNE=1）：T25.30/33/34/35。
// 注意：refresh 触发挂在 300s 扫描周期上，每个场景需等待最长 ~6 分钟。
import { execFileSync } from "node:child_process"

const BASE = process.env.BASE ?? "http://127.0.0.1:14117"
const PG = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from("opencode:local-e2e").toString("base64")}`
const sql = (q) =>
  execFileSync("psql", [PG, "-X", "-A", "-t", "-q", "-c", q], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PGCONNECT_TIMEOUT: "5", PGOPTIONS: "-c statement_timeout=20000" },
  }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, name, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`)
  if (!ok) failures++
}
const api = async (path, method = "GET", body) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), authorization: auth },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  })
  const text = await response.text()
  return { status: response.status, text, data: text ? (() => { try { return JSON.parse(text) } catch { return undefined } })() : undefined }
}
const runShell = async (sid, command) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = Number(sql(`select coalesce(max(seq),0) from session_message where session_id='${sid}'`))
    await api(`/api/session/${sid}/shell`, "POST", { command })
    for (let i = 0; i < 60; i++) {
      const out = sql(
        `select coalesce(data::jsonb->'output'->>'output','') from session_message where session_id='${sid}' and type='shell' and seq > ${before} and data::jsonb->>'status'='exited' order by seq desc limit 1`,
      )
      const settled = sql(
        `select count(*) from session_message where session_id='${sid}' and type='shell' and seq > ${before} and data::jsonb->>'status'='exited'`,
      )
      if (settled !== "0") return out
      await sleep(1000)
    }
    console.log(`   (shell retry ${attempt + 1}: ${command})`)
  }
  throw new Error(`shell did not finish: ${command}`)
}
const newSession = () =>
  api("/api/session", "POST", {
    model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" },
    sandbox: { cpu: "1", memory: "2Gi", persistMode: "snapshot" },
  }).then((r) => r.data.data.id)

// ---------- T25.33 周期保鲜：空闲超间隔 → 快照 ready，沙箱保留 ----------
const sid = await newSession()
console.log(`session ${sid}`)
try {
  await runShell(sid, "echo fresh > /workspace/f.txt; mkdir -p /workspace/.cache; echo junk > /workspace/.cache/blob")
  const count = () => Number(sql(`select count(*) from session_snapshot where session_id='${sid}' and state in ('creating','ready')`))
  const startCount = count()
  const sandboxState = () => sql(`select state from sandbox where session_id='${sid}'`)

  console.log("waiting for the 300s scan to trigger the first refresh...")
  let refreshed = false
  let keptRunning = false
  for (let i = 0; i < 45; i++) {
    await sleep(15_000)
    const ready = Number(sql(`select count(*) from session_snapshot where session_id='${sid}' and state='ready'`))
    if (ready > 0) {
      refreshed = true
      // 沙箱必须保持 running（保鲜不销毁）
      for (let k = 0; k < 6 && sandboxState() !== "running"; k++) await sleep(5000)
      keptRunning = sandboxState() === "running"
      break
    }
  }
  check(refreshed, "T25.33 idle sandbox got a refreshed snapshot", `ready=${sql(`select count(*) from session_snapshot where session_id='${sid}' and state='ready'`)}`)
  check(keptRunning, "T25.33b sandbox kept running after refresh", `state=${sandboxState()}`)
  const refreshOps = sql(`select count(*) from snapshot_refresh_operation where session_id='${sid}' and state='done'`)
  check(Number(refreshOps) >= 1, "T25.33c refresh operation recorded done", `done=${refreshOps}`)
  const destroyOps = sql(`select count(*) from snapshot_operation where session_id='${sid}'`)
  check(destroyOps === "0", "T25.33d no destroy enqueued for keep-fresh", `destroy=${destroyOps}`)

  // ---------- T25.30 prune：ready 事件带 workspaceKb + pruned，.cache 被清理 ----------
  const ev = sql(`select data from event where aggregate_id='${sid}' and type like 'session.sandbox.snapshot.ready%' order by seq desc limit 1`)
  const parsed = JSON.parse(ev || "{}")
  check(parsed.workspaceKb != null || /workspaceKb/.test(ev), "T25.30a ready event carries workspaceKb", ev.slice(0, 120))
  check(parsed.pruned === true, "T25.30b ready event marks pruned", ev.slice(0, 120))

  // ---------- T25.34 已覆盖跳过：无后续写入 → 下一轮不再新拍 ----------
  console.log("waiting for the next 300s scan to confirm the covered-skip...")
  const before = count()
  let stable = false
  for (let i = 0; i < 45; i++) {
    await sleep(15_000)
    if (count() > before) break
    if (i === 44) stable = true
  }
  check(stable, "T25.34 covered workspace does not get a second refresh snapshot", `before=${before} after=${count()}`)

  // ---------- T25.35 平台硬回收：外部杀容器 → 行收敛/恢复仍可用 ----------
  const sbId = sql(`select id from sandbox where session_id='${sid}' and state='running' limit 1`)
  if (sbId) {
    try {
      execFileSync("docker", ["kill", `sandbox-${sbId}`], { encoding: "utf8", stdio: "pipe" })
    } catch (error) {
      console.log(`   (docker kill failed, container may be named differently: ${String(error).slice(0, 120)})`)
    }
  }
  console.log(`externally killed sandbox container: sandbox-${sbId || "?"}`)
  // 平台回收后：下一次使用触发重建，从最近快照恢复，数据仍在
  const out = await runShell(sid, "cat /workspace/f.txt")
  check(out.trim() === "fresh", "T25.35 restore after platform hard-recycle keeps data", out.trim())
  const state = sandboxState()
  check(state === "running", "T25.35b sandbox row converges back to running", `state=${state}`)
} finally {
  await api(`/api/session/${sid}`, "DELETE").catch(() => undefined)
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`)
process.exit(failures)
