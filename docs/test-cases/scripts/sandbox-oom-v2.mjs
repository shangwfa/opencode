// OOM sampling E2E (T61.V2.2) against a dedicated instance with a 5s scan interval.
import { execFileSync } from "node:child_process"

const BASE = process.env.BASE ?? "http://127.0.0.1:14109"
const PG = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from("opencode:local-e2e").toString("base64")}`
const sql = (q) => execFileSync("psql", [PG, "-X", "-A", "-t", "-q", "-c", q], { encoding: "utf8" }).trim()

const api = async (path, method = "GET", body) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), authorization: auth },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : undefined
}

const runShell = async (sid, command) => {
  const before = Number(sql(`select coalesce(max(seq),0) from session_message where session_id='${sid}'`))
  await api(`/api/session/${sid}/shell`, "POST", { command })
  for (let i = 0; i < 90; i++) {
    const out = sql(
      `select data::jsonb->'output'->>'output' from session_message where session_id='${sid}' and type='shell' and seq > ${before} and data::jsonb->>'status'='exited' order by seq desc limit 1`,
    )
    if (out) return out
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`shell did not finish: ${command}`)
}

const sid = (await api("/api/session", "POST", {
  model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" },
  sandbox: { cpu: "1", memory: "128Mi" },
})).data.id
console.log(`session ${sid}`)
let failures = 0
try {
  const baseline = await runShell(sid, "grep oom_kill /sys/fs/cgroup/memory.events; cat /sys/fs/cgroup/memory.max")
  console.log(`baseline:\n${baseline}`)

  // Let the first scan cycle establish its counter baseline BEFORE the bomb
  // runs, otherwise the first sample may already include every kill and the
  // delta stays zero for all later rounds.
  console.log("waiting 7s for the first scan cycle to baseline...")
  await new Promise((resolve) => setTimeout(resolve, 7_000))

  // Detached allocator that repeatedly grabs 300MiB: each attempt exceeds the
  // 128MiB limit, so the kernel OOM-kills it and the counter climbs.
  await runShell(
    sid,
    `(nohup sh -c 'i=0; while [ $i -lt 20 ]; do python3 -c "b=bytearray(300*1024*1024)" ; i=$((i+1)); done' >/tmp/bomb.log 2>&1 </dev/null &); echo launched`,
  )
  console.log("waiting 25s for >=2 scan cycles...")
  await new Promise((resolve) => setTimeout(resolve, 25_000))

  const after = await runShell(sid, "grep -E '^(oom|oom_kill)' /sys/fs/cgroup/memory.events; cat /sys/fs/cgroup/memory.current")
  console.log(`after:\n${after}`)

  const events = sql(
    `select type || ' ' || data from event where aggregate_id='${sid}' and type like 'session.sandbox.%' order by seq`,
  )
  console.log(`events:\n${events || "(none)"}`)
  const ok = Number(sql(`select count(*) from event where aggregate_id='${sid}' and type like 'session.sandbox.oom%'`)) >= 1
  console.log(`${ok ? "PASS" : "FAIL"} T61.V2.2 session.sandbox.oom present`)
  if (!ok) failures++
} finally {
  await api(`/api/session/${sid}`, "DELETE").catch(() => undefined)
}
process.exit(failures)
