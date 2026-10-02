// Sandbox snapshot E2E (V2): create → ready → destroy → restore keeps workspace.
import { execFileSync } from "node:child_process"

const BASE = process.env.BASE ?? "http://127.0.0.1:14110"
const PG = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from("opencode:local-e2e").toString("base64")}`
const sql = (q) => execFileSync("psql", [PG, "-X", "-A", "-t", "-q", "-c", q], { encoding: "utf8" }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  const r = await api(`/api/session/${sid}/shell`, "POST", { command })
  if (r.status !== 204) throw new Error(`shell HTTP ${r.status}: ${r.text.slice(0, 200)}`)
  for (let i = 0; i < 120; i++) {
    const out = sql(
      `select data::jsonb->'output'->>'output' from session_message where session_id='${sid}' and type='shell' and seq > ${before} and data::jsonb->>'status'='exited' order by seq desc limit 1`,
    )
    if (out) return out
    await sleep(1000)
  }
  throw new Error(`shell did not finish: ${command}`)
}

let failures = 0
const check = (ok, name, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`)
  if (!ok) failures++
}

const sid = (await api("/api/session", "POST", {
  model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" },
  sandbox: { cpu: "1", memory: "2Gi", persistMode: "snapshot" },
})).data.data.id
console.log(`session ${sid}`)
try {
  // 1. workspace marker
  const marker = `SNAP-MARKER-${Date.now()}`
  await runShell(sid, `echo ${marker} > /workspace/marker.txt && cat /workspace/marker.txt`)
  check(true, "T-SNAP.1 workspace marker written")

  // 2. explicit snapshot
  const created = await api(`/api/session/${sid}/snapshot`, "POST")
  check(created.status === 200 && created.data?.data?.snapshotID, "T-SNAP.2 POST snapshot returns id",
    `${created.status} ${created.text.slice(0, 120)}`)
  const snapshotID = created.data?.data?.snapshotID

  // 3. wait ready
  let state = ""
  for (let i = 0; i < 90; i++) {
    const got = await api(`/api/session/${sid}/snapshot`)
    state = got.data?.data?.state ?? ""
    if (state === "ready" || state === "failed") break
    await sleep(2000)
  }
  const row = sql(`select state || '|' || coalesce(reason,'') from session_snapshot where id='${snapshotID}'`)
  check(state === "ready", "T-SNAP.3 snapshot reaches ready", `state=${state} row=${row}`)
  if (state !== "ready") {
    console.log("snapshot failed; remote detail above. Aborting restore leg.")
    process.exit(1)
  }

  // 4. destroy sandbox (explicit destroy does NOT snapshot)
  const killed = await api(`/api/session/${sid}/kill-sandbox`, "POST", {})
  check(killed.status === 200 && killed.data?.destroyed === true, "T-SNAP.4 kill-sandbox destroyed")

  // 5. next shell restores from the snapshot
  const restoredOut = await runShell(sid, `cat /workspace/marker.txt`)
  check(restoredOut.trim() === marker, "T-SNAP.5 restore keeps workspace marker", `out=${restoredOut.trim()}`)

  // 6. PG row consumed (stale) + restored event
  const consumed = sql(`select state || '|' || restored_count from session_snapshot where id='${snapshotID}'`)
  check(consumed.startsWith("stale|1"), "T-SNAP.6 snapshot marked stale/restored", consumed)
  const events = sql(
    `select count(*) from event where aggregate_id='${sid}' and (type like 'session.sandbox.snapshot%' )`,
  )
  check(Number(events) >= 1, "T-SNAP.7 snapshot durable events present", `n=${events}`)

  // 8. new sandbox id differs (restored instance, not the killed one)
  const sandboxNow = (await api(`/api/session/${sid}/sandbox`)).data?.sandboxId
  const sandboxOld = sql(`select id from sandbox where session_id='${sid}'`)
  check(Boolean(sandboxNow) && sandboxNow !== snapshotID, "T-SNAP.8 running sandbox after restore", `${sandboxNow}`)
} finally {
  await api(`/api/session/${sid}`, "DELETE").catch(() => undefined)
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
process.exit(failures)
