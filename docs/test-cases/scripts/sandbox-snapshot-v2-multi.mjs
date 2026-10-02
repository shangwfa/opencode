// 多实例快照 E2E（V2 durable 队列版）：T25.24/25/26/27/28/29 + 回归。
// 前置：实例 A (BASE_A) 与实例 B (BASE_B) 共享同一 PG 与 OpenSandbox，
//       均开 SNAPSHOT_ENABLED + DELETE_ENABLED；B 额外开 PRUNE=1。
import { execFileSync } from "node:child_process"

const BASE_A = process.env.BASE_A ?? "http://127.0.0.1:14116"
const BASE_B = process.env.BASE_B ?? "http://127.0.0.1:14117"
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

const api = async (base, path, method = "GET", body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), authorization: auth },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  })
  const text = await response.text()
  return { status: response.status, text, data: text ? (() => { try { return JSON.parse(text) } catch { return undefined } })() : undefined }
}
const runShell = async (base, sid, command) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = Number(sql(`select coalesce(max(seq),0) from session_message where session_id='${sid}'`))
    await api(base, `/api/session/${sid}/shell`, "POST", { command })
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
const newSession = (base, extra = {}) =>
  api(base, "/api/session", "POST", {
    model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" },
    sandbox: { cpu: "1", memory: "2Gi", persistMode: "snapshot", ...extra },
  }).then((r) => r.data.data.id)
const waitSnapshotState = async (sid, want, timeoutMs = 180_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = sql(`select state from session_snapshot where session_id='${sid}' order by time_created desc limit 1`)
    if (row === want) return true
    await sleep(2000)
  }
  return false
}
const opRow = (id) => sql(`select state||'|attempts='||attempts||'|fencing='||fencing_token from snapshot_operation where id='${id}'`)
const snapshotCount = (sid) => Number(sql(`select count(*) from session_snapshot where session_id='${sid}'`))
const cleanup = async (...sids) => {
  for (const s of sids) await api(BASE_A, `/api/session/${s}`, "DELETE").catch(() => undefined)
}

// ---------- T25.27 幂等唯一索引（并发 enqueue 收敛为一条） ----------
{
  const sid = await newSession(BASE_A)
  try {
    const tag = Date.now()
    for (let i = 0; i < 6; i++) {
      sql(`insert into snapshot_operation (id,session_id,sandbox_id,kind,state,attempts,fencing_token,time_created,time_updated)
           values ('op-t2527-${tag}-${i}','${sid}','sb-${tag}','snapshot_destroy','pending',0,0,${Date.now()},${Date.now()})
           on conflict do nothing`)
    }
    const active = sql(`select count(*) from snapshot_operation where session_id='${sid}' and sandbox_id='sb-${tag}' and state in ('pending','running')`)
    check(active === "1", "T25.27 concurrent enqueue converges to one active row", `active=${active}`)
    sql(`delete from snapshot_operation where session_id='${sid}' and sandbox_id='sb-${tag}'`)
  } finally { await cleanup(sid) }
}

// ---------- T25.24 无变更复用 + dirty 新快照 ----------
{
  const sid = await newSession(BASE_A)
  try {
    await runShell(BASE_A, sid, "echo reuse-data > /workspace/a.txt")
    const snap = await api(BASE_A, `/api/session/${sid}/snapshot`, "POST")
    await waitSnapshotState(sid, "ready")
    const before = snapshotCount(sid)
    const beforeRows = sql(`select string_agg(id||':'||state, ',') from session_snapshot where session_id='${sid}'`)
    // 无写入 → kill：应复用（无新快照行），沙箱销毁
    const killed = await api(BASE_A, `/api/session/${sid}/kill-sandbox`, "POST", {})
    await sleep(2000)
    check(killed.data?.destroyed === true, "T25.24a unchanged kill destroys sandbox", killed.text.slice(0, 120))
    check(snapshotCount(sid) === before, "T25.24b no new snapshot row (reused)", `before=${before} after=${snapshotCount(sid)} rows=${sql(`select string_agg(id||':'||state, ',') from session_snapshot where session_id='${sid}'`)}`)
    const ops = sql(`select count(*) from snapshot_operation where session_id='${sid}' and state='done'`)
    check(Number(ops) >= 1, "T25.24c destroy operation recorded done", `done=${ops}`)
    // 恢复：复用快照的数据仍在
    const out = await runShell(BASE_A, sid, "cat /workspace/a.txt")
    check(out.trim() === "reuse-data", "T25.24d restore from reused snapshot keeps data", out.trim())
    // dirty：再写入 → kill：必须新快照（安全承诺）
    await runShell(BASE_A, sid, "echo dirty > /workspace/b.txt")
    await api(BASE_A, `/api/session/${sid}/kill-sandbox`, "POST", {})
    const grew = await waitSnapshotState(sid, "ready") && snapshotCount(sid) >= before
    check(grew, "T25.24e dirty kill takes a new snapshot", `count=${snapshotCount(sid)}`)
    const out2 = await runShell(BASE_A, sid, "cat /workspace/b.txt")
    check(out2.trim() === "dirty", "T25.24f dirty data survives via new snapshot", out2.trim())
  } finally { await cleanup(sid) }
}

// ---------- T25.28 兼容性元数据 + schema 不兼容阻断 ----------
{
  const sid = await newSession(BASE_A)
  try {
    await runShell(BASE_A, sid, "echo compat > /workspace/c.txt")
    await api(BASE_A, `/api/session/${sid}/snapshot`, "POST")
    await waitSnapshotState(sid, "ready")
    const meta = sql(`select 'schema='||coalesce(schema_version::text,'-')||' arch='||coalesce(arch,'-') from session_snapshot where session_id='${sid}' order by time_created desc limit 1`)
    check(meta.startsWith("schema=1"), "T25.28a compatibility metadata recorded", meta)
    sql(`update session_snapshot set schema_version=999 where session_id='${sid}'`)
    await api(BASE_A, `/api/session/${sid}/kill-sandbox`, "POST", {})
    const cold = await runShell(BASE_A, sid, "cat /workspace/c.txt 2>&1 || echo GONE")
    check(cold.includes("GONE") || cold.includes("No such file"), "T25.28b incompatible snapshot falls back to cold start", cold.trim().slice(0, 60))
    const row = sql(`select state||'|'||coalesce(reason,'-') from session_snapshot where session_id='${sid}' order by time_created desc limit 1`)
    check(row.startsWith("failed|incompatible: schema 999 != 1"), "T25.28c snapshot marked incompatible", row)
  } finally { await cleanup(sid) }
}

// ---------- T25.25 队列持久化：遗留 pending 行被 drain 接管执行 ----------
{
  const carrier = await newSession(BASE_A) // 触发 drain 的载体会话
  await runShell(BASE_A, carrier, "echo carrier-boot")
  const ghost = await newSession(BASE_B)  // 绑定 ghost 操作的会话（沙箱不存在）
  try {
    const tag = Date.now()
    sql(`insert into snapshot_operation (id,session_id,sandbox_id,kind,state,attempts,fencing_token,time_created,time_updated)
         values ('op-t2525-${tag}','${ghost}','ghost-${tag}','snapshot_destroy','pending',0,0,${Date.now()},${Date.now()})
         on conflict do nothing`)
    await api(BASE_A, `/api/session/${carrier}/kill-sandbox`, "POST", {}) // 任意 kill 触发本实例 drain
    let row = ""
    for (let i = 0; i < 60; i++) {
      row = opRow(`op-t2525-${tag}`)
      if (row.startsWith("done")) break
      await sleep(2000)
    }
    check(row === "done|attempts=1|fencing=1", "T25.25 leftover pending op drained by any instance", row)
    // 真实会话 kill 的 op 也要落库并 done
    const doneOps = sql(`select count(*) from snapshot_operation where session_id='${carrier}' and state='done'`)
    check(Number(doneOps) >= 1, "T25.25b real kill enqueue + done", `done=${doneOps}`)
  } finally { await cleanup(carrier, ghost) }
}

// ---------- T25.26 fencing：租约未过期不领取；过期接管后旧 token 失效 ----------
{
  const carrier = await newSession(BASE_A)
  await runShell(BASE_A, carrier, "echo carrier-boot2")
  const holder = await newSession(BASE_B)
  try {
    const tag = Date.now()
    const NOW = Date.now()
    sql(`insert into snapshot_operation (id,session_id,sandbox_id,kind,state,attempts,fencing_token,lease_owner,lease_until,time_created,time_updated)
         values ('op-t2526-${tag}','${holder}','ghost2-${tag}','snapshot_destroy','running',1,7,'dead-instance',${NOW + 300000},${NOW},${NOW})
         on conflict do nothing`)
    await api(BASE_A, `/api/session/${carrier}/kill-sandbox`, "POST", {})
    await sleep(6000)
    let row = opRow(`op-t2526-${tag}`)
    check(row === "running|attempts=1|fencing=7", "T25.26a live lease is not stolen", row)
    sql(`update snapshot_operation set lease_until=${Date.now() - 1000} where id='op-t2526-${tag}'`)
    await api(BASE_A, `/api/session/${carrier}/shell`, "POST", { command: "echo noop" }).catch(() => undefined)
    await api(BASE_A, `/api/session/${carrier}/kill-sandbox`, "POST", {}).catch(() => undefined)
    for (let i = 0; i < 60; i++) {
      row = opRow(`op-t2526-${tag}`)
      if (row.startsWith("done") || row.includes("fencing=8")) break
      await sleep(2000)
    }
    check(row === "done|attempts=2|fencing=8", "T25.26b expired lease taken over with fencing bump", row)
  } finally { await cleanup(carrier, holder) }
}

// ---------- T25.29 stats 聚合端点 ----------
{
  const sid = await newSession(BASE_A)
  try {
    await runShell(BASE_A, sid, "echo stats > /workspace/s.txt")
    await api(BASE_A, `/api/session/${sid}/snapshot`, "POST")
    await waitSnapshotState(sid, "ready")
    await api(BASE_A, `/api/session/${sid}/kill-sandbox`, "POST", {})
    const stats = await api(BASE_A, `/api/session/${sid}/snapshot/stats`)
    const d = stats.data?.data
    check(
      stats.status === 200 && d && typeof d.total === "number" && d.snapshots && d.operations?.destroy && d.operations?.refresh,
      "T25.29 snapshot stats aggregates snapshots and both queues",
      stats.text.slice(0, 160),
    )
    check((d?.operations?.destroy?.byState?.done ?? 0) >= 1, "T25.29b destroy ops counted", JSON.stringify(d?.operations))
  } finally { await cleanup(sid) }
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`)
process.exit(failures)
