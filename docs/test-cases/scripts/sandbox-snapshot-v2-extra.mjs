// T-SNAP.9-12: idle-reap snapshot path, session-delete cascade, bad-snapshot fallback, capability gate.
import { execFileSync } from "node:child_process"

const BASE = process.env.BASE ?? "http://127.0.0.1:14110"
const PG = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from("opencode:local-e2e").toString("base64")}`
const sql = (q) => execFileSync("psql", [PG, "-X", "-A", "-t", "-q", "-c", q], { encoding: "utf8" }).trim()
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
    signal: AbortSignal.timeout(180_000),
  })
  const text = await response.text()
  return { status: response.status, text, data: text ? (() => { try { return JSON.parse(text) } catch { return undefined } })() : undefined }
}
const runShell = async (sid, command) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = Number(sql(`select coalesce(max(seq),0) from session_message where session_id='${sid}'`))
    await api(`/api/session/${sid}/shell`, "POST", { command })
    for (let i = 0; i < 60; i++) {
      // `exited` alone marks completion: redirected-only commands have no stdout.
      const out = sql(
        `select coalesce(data::jsonb->'output'->>'output','') from session_message where session_id='${sid}' and type='shell' and seq > ${before} and data::jsonb->>'status'='exited' order by seq desc limit 1`,
      )
      if (out !== "") return out
      const settled = sql(
        `select count(*) from session_message where session_id='${sid}' and type='shell' and seq > ${before} and data::jsonb->>'status'='exited'`,
      )
      if (settled !== "0") return ""
      await sleep(1000)
    }
    // The clock-skew window after a container restart can swallow the first
    // shell projection; retry instead of failing the case outright.
    console.log(`   (shell retry ${attempt + 1}: ${command})`)
  }
  throw new Error(`shell did not finish: ${command}`)
}
const newSession = (extra = {}) =>
  api("/api/session", "POST", {
    model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" },
    sandbox: { cpu: "1", memory: "2Gi", persistMode: "snapshot", ...extra },
  }).then((r) => r.data.data.id)

const mode = process.argv[2]

if (mode === "reap") {
  // T-SNAP.9: idle-reap snapshots before destroying (no keep-alive session).
  const sid = await newSession()
  console.log(`session ${sid}`)
  const marker = `REAP-MARK-${Date.now()}`
  await runShell(sid, `echo ${marker} > /workspace/marker.txt`)
  sql(`update sandbox set time_updated = ${(Date.now() / 1000 | 0) * 1000 - 120_000} where session_id='${sid}'`)
  console.log("waiting for the 300s reap scan to claim the stale sandbox...")
  let final = ""
  for (let i = 0; i < 60; i++) {
    await sleep(15_000)
    final = sql(`select state from sandbox where session_id='${sid}'`)
    if (final === "destroyed") break
  }
  check(final === "destroyed", "T-SNAP.9a sandbox destroyed via snapshotting path", `state=${final}`)
  const snap = sql(`select state from session_snapshot where session_id='${sid}' order by time_created desc limit 1`)
  check(snap === "ready", "T-SNAP.9b snapshot ready before destroy", `row=${snap}`)
  const out = await runShell(sid, "cat /workspace/marker.txt")
  check(out.trim() === marker, "T-SNAP.9c restore from reap snapshot keeps marker", out.trim())
  await api(`/api/session/${sid}`, "DELETE").catch(() => undefined)
} else if (mode === "delete") {
  // T-SNAP.10: session delete cascades snapshots (delete gate enabled).
  const sid = await newSession()
  await runShell(sid, "echo x > /workspace/x.txt")
  const created = await api(`/api/session/${sid}/snapshot`, "POST")
  const snapshotID = created.data?.data?.snapshotID
  for (let i = 0; i < 60; i++) {
    const st = sql(`select state from session_snapshot where id='${snapshotID}'`)
    if (st === "ready" || st === "failed") break
    await sleep(2000)
  }
  await api(`/api/session/${sid}`, "DELETE")
  await sleep(3000)
  const row = sql(`select state from session_snapshot where id='${snapshotID}'`)
  check(row === "deleted", "T-SNAP.10 session delete marks snapshot deleted", `row=${row}`)
} else if (mode === "fallback") {
  // T-SNAP.11: a dangling ready row (no remote snapshot) falls back to cold start.
  const sid = await newSession()
  const fake = `00000000-dead-beef-0000-${String(Date.now()).slice(-12).padStart(12, "0")}`
  sql(`insert into session_snapshot (id, session_id, scope, state, time_created, time_updated, restored_count)
       values ('${fake}', '${sid}', 'session', 'ready', ${Date.now()}, ${Date.now()}, 0)`)
  const out = await runShell(sid, "echo cold-start-ok")
  check(out.trim() === "cold-start-ok", "T-SNAP.11a session works via cold start", out.trim())
  const row = sql(`select state || '|' || coalesce(reason,'') from session_snapshot where id='${fake}'`)
  check(row.startsWith("failed|restore failed"), "T-SNAP.11b bad snapshot marked failed", row)
  const events = sql(`select count(*) from event where aggregate_id='${sid}' and type like 'session.sandbox.snapshot%'`)
  console.log(`   (snapshot events so far: ${events})`)
  await api(`/api/session/${sid}`, "DELETE").catch(() => undefined)
} else if (mode === "gate") {
  // T-SNAP.12: capability disabled -> 400.
  const sid = await newSession()
  await runShell(sid, "echo boot").catch(() => undefined)
  const created = await api(`/api/session/${sid}/snapshot`, "POST")
  check(created.status === 400, "T-SNAP.12 disabled capability returns 400", `${created.status} ${created.text.slice(0, 120)}`)
  await api(`/api/session/${sid}`, "DELETE").catch(() => undefined)
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`)
process.exit(failures)
