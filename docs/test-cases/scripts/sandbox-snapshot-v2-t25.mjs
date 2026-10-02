// T25.5 (sibling supersede) / T25.17 (stale re-restore) / T25.18 (TTL GC) on one instance.
// Instance must run with OPENCODE_SANDBOX_SNAPSHOT_TTL_SEC=2 and DELETE_ENABLED=true.
import { execFileSync } from "node:child_process"

const BASE = process.env.BASE ?? "http://127.0.0.1:14115"
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
  const before = Number(sql(`select coalesce(max(seq),0) from session_message where session_id='${sid}'`))
  await api(`/api/session/${sid}/shell`, "POST", { command })
  for (let i = 0; i < 120; i++) {
    // `exited` alone marks completion: redirected-only commands have no stdout.
    const out = sql(
      `select coalesce(data::jsonb->'output'->>'output','') from session_message where session_id='${sid}' and type='shell' and seq > ${before} and data::jsonb->>'status'='exited' order by seq desc limit 1`,
    )
    const settled = sql(
      `select count(*) from session_message where session_id='${sid}' and type='shell' and seq > ${before} and data::jsonb->>'status'='exited'`,
    )
    if (settled !== "0") return out
    await sleep(1000)
  }
  throw new Error(`shell did not finish: ${command}`)
}
const waitReady = async (sid, snapshotID) => {
  for (let i = 0; i < 90; i++) {
    const st = sql(`select state from session_snapshot where id='${snapshotID}'`)
    if (st === "ready" || st === "failed") return st
    await sleep(2000)
  }
  return sql(`select state from session_snapshot where id='${snapshotID}'`)
}

const sid = (await api("/api/session", "POST", {
  model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" },
  sandbox: { cpu: "1", memory: "2Gi", persistMode: "snapshot" },
})).data.data.id
console.log(`session ${sid}`)
try {
  // ---- T25.5: second snapshot supersedes the first ----
  await runShell(sid, "echo v1 > /workspace/v.txt")
  const s1 = (await api(`/api/session/${sid}/snapshot`, "POST")).data?.data?.snapshotID
  await waitReady(sid, s1)
  await runShell(sid, "echo v2 >> /workspace/v.txt")
  const s2 = (await api(`/api/session/${sid}/snapshot`, "POST")).data?.data?.snapshotID
  const st2 = await waitReady(sid, s2)
  await sleep(2000)
  const r1 = sql(`select state from session_snapshot where id='${s1}'`)
  check(st2 === "ready" && r1 === "deleted", "T25.5 second snapshot supersedes the first", `s1=${r1} s2=${st2}`)

  // ---- T25.17: destroy → restore → destroy → restore again from stale ----
  await api(`/api/session/${sid}/kill-sandbox`, "POST", {})
  const first = await runShell(sid, "cat /workspace/v.txt")
  await api(`/api/session/${sid}/kill-sandbox`, "POST", {})
  const second = await runShell(sid, "cat /workspace/v.txt")
  check(first.trim() === "v1 v2" && second.trim() === "v1 v2", "T25.17 stale snapshot restores twice",
    `1=${first.trim()} 2=${second.trim()}`)
  const consumed = sql(`select state || '|' || restored_count from session_snapshot where id='${s2}'`)
  check(consumed.startsWith("stale|2"), "T25.17b consumed count reaches 2", consumed)

  // ---- T25.18: TTL GC (ttl=2s) removes the terminal snapshot on the next reap scan ----
  console.log("waiting for the 300s reap scan to run TTL gc...")
  let row = ""
  for (let i = 0; i < 60; i++) {
    await sleep(15_000)
    row = sql(`select state from session_snapshot where id='${s2}'`)
    if (row === "deleted") break
  }
  check(row === "deleted", "T25.18 TTL-expired snapshot deleted by gc", `row=${row}`)
} finally {
  await api(`/api/session/${sid}`, "DELETE").catch(() => undefined)
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`)
process.exit(failures)
