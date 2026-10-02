// T25.30 复验（时钟稳定后）：PRUNE=1 实例上快照事件遥测 + 实际清理。
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
  return { status: response.status, text: await response.text() }
}

const sid = JSON.parse((await api("/api/session", "POST", {
  model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" },
  sandbox: { cpu: "1", memory: "2Gi", persistMode: "snapshot" },
})).text).data.id
console.log(`session ${sid}`)
try {
  await api(`/api/session/${sid}/shell`, "POST", { command: "mkdir -p /workspace/.cache; echo junk > /workspace/.cache/blob; echo boot" })
  for (let i = 0; i < 60; i++) {
    const done = sql(`select count(*) from session_message where session_id='${sid}' and type='shell' and (data::jsonb->>'status')='exited'`)
    if (done !== "0") break
    await sleep(1000)
  }
  await api(`/api/session/${sid}/snapshot`, "POST")
  for (let i = 0; i < 90; i++) {
    if (sql(`select state from session_snapshot where session_id='${sid}' order by time_created desc limit 1`) === "ready") break
    await sleep(2000)
  }
  await sleep(3000)
  const raw = sql(`select data from event where aggregate_id='${sid}' and type like 'session.sandbox.snapshot.ready%' order by seq desc limit 1`)
  const data = JSON.parse(raw || "{}")
  check(data.workspaceKb !== undefined, "T25.30a ready event carries workspaceKb", raw.slice(0, 140))
  check(data.pruned === true, "T25.30b ready event marks pruned", raw.slice(0, 140))
  const before = sql(`select coalesce(max(seq),0) from session_message where session_id='${sid}'`)
  await api(`/api/session/${sid}/shell`, "POST", { command: "ls /workspace/.cache 2>/dev/null || echo CACHE-GONE" })
  let out = ""
  for (let i = 0; i < 60; i++) {
    out = sql(`select coalesce(data::jsonb->'output'->>'output','') from session_message where session_id='${sid}' and type='shell' and seq > ${before} and (data::jsonb->>'status')='exited' order by seq desc limit 1`)
    if (out.includes("CACHE-GONE")) break
    await sleep(1000)
  }
  check(out.includes("CACHE-GONE"), "T25.30c rebuildable cache pruned inside the sandbox", out.trim().slice(0, 80))
} finally {
  await api(`/api/session/${sid}`, "DELETE").catch(() => undefined)
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`)
process.exit(failures)
