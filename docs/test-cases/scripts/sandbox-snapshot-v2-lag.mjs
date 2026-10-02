// lag-warning E2E：平台硬杀 + 快照落后 → durable 告警事件；快照已覆盖 → 不告警（负向）。
import { execFileSync } from "node:child_process"

const BASE = process.env.BASE ?? "http://127.0.0.1:14123"
const PG = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from("opencode:local-e2e").toString("base64")}`
const sql = (q) =>
  execFileSync("psql", [PG, "-X", "-A", "-t", "-q", "-c", q], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PGCONNECT_TIMEOUT: "5", PGOPTIONS: "-c statement_timeout=20000" },
  }).trim()
const sh = (cmd) => execFileSync("sh", ["-c", cmd], { encoding: "utf8" }).trim()
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
    signal: AbortSignal.timeout(300_000),
  })
  return { status: response.status, text: await response.text() }
}
const runShell = async (sid, command) => {
  const before = Number(sql(`select coalesce(max(seq),0) from session_message where session_id='${sid}'`))
  await api(`/api/session/${sid}/shell`, "POST", { command })
  for (let i = 0; i < 120; i++) {
    const settled = sql(
      `select count(*) from session_message where session_id='${sid}' and type='shell' and seq > ${before} and (data::jsonb->>'status')='exited'`,
    )
    if (settled !== "0") return true
    await sleep(1000)
  }
  return false
}
const newSession = () =>
  api("/api/session", "POST", {
    model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" },
    sandbox: { cpu: "1", memory: "2Gi", persistMode: "snapshot" },
  }).then((r) => JSON.parse(r.text).data.id)
const waitSnapshotReady = async (sid) => {
  for (let i = 0; i < 90; i++) {
    if (sql(`select state from session_snapshot where session_id='${sid}' order by time_created desc limit 1`) === "ready") return true
    await sleep(2000)
  }
  return false
}
const lagEvents = (sid) => sql(`select count(*) from event where aggregate_id='${sid}' and type like 'session.sandbox.snapshot.lag_warning%'`)

// ---------- 场景 1：快照落后 + 平台硬杀 → 告警 ----------
const s1 = await newSession()
console.log(`lag session ${s1}`)
try {
  await runShell(s1, "echo v1 > /workspace/loss.txt")
  await api(`/api/session/${s1}/snapshot`, "POST")
  check(await waitSnapshotReady(s1), "T-LAG.0 baseline snapshot ready")
  // 快照后的新写入（未拍新快照）→ 快照落后于最后活动
  await runShell(s1, "echo v2-uncommitted >> /workspace/loss.txt")
  const sbx = sql(`select id from sandbox where session_id='${s1}' and state='running'`)
  sh(`docker kill sandbox-${sbx} 2>/dev/null || true`)
  console.log("sandbox container killed externally")
  // 触发销毁路径（kill-sandbox）：worker 发现沙箱已死 → lag 告警 + 行收敛
  await api(`/api/session/${s1}/kill-sandbox`, "POST", {})
  let events = 0
  for (let i = 0; i < 30; i++) {
    events = Number(lagEvents(s1))
    if (events > 0) break
    await sleep(2000)
  }
  check(events === 1, "T-LAG.1 lag_warning event emitted (snapshot behind last activity)", `events=${events}`)
  const state = sql(`select state from sandbox where session_id='${s1}'`)
  check(state === "destroyed", "T-LAG.2 row converged to destroyed", state)
  // 恢复：内容回到 v1（v2 丢失，告警已量化该损失）
  const out = await runShell(s1, "cat /workspace/loss.txt") ? sql(`select coalesce(data::jsonb->'output'->>'output','') from session_message where session_id='${s1}' and type='shell' order by seq desc limit 1`) : ""
  check(out.includes("v1") && !out.includes("v2-uncommitted"), "T-LAG.3 restore rolls back to last snapshot (loss observable)", out.trim().slice(0, 40))
} finally {
  await api(`/api/session/${s1}`, "DELETE").catch(() => undefined)
}

// ---------- 场景 2（负向）：快照已覆盖最后活动 → 不告警 ----------
const s2 = await newSession()
console.log(`clean session ${s2}`)
try {
  await runShell(s2, "echo safe > /workspace/safe.txt")
  await api(`/api/session/${s2}/snapshot`, "POST")
  check(await waitSnapshotReady(s2), "T-LAG.0b baseline snapshot ready (negative case)")
  // 无任何后续写入：快照覆盖最后活动
  const sbx2 = sql(`select id from sandbox where session_id='${s2}' and state='running'`)
  sh(`docker kill sandbox-${sbx2} 2>/dev/null || true`)
  await api(`/api/session/${s2}/kill-sandbox`, "POST", {})
  await sleep(10_000)
  check(Number(lagEvents(s2)) === 0, "T-LAG.4 no lag_warning when snapshot covers last activity", `events=${lagEvents(s2)}`)
} finally {
  await api(`/api/session/${s2}`, "DELETE").catch(() => undefined)
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`)
process.exit(failures)
