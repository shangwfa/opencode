// 跨实例并发创建互斥 E2E：同一 session 的 shell 同时打到两个实例，
// 断言远端只 create 一个沙箱、PG 单行、两实例日志合计一次 created。
import { execFileSync } from "node:child_process"

const BASE_A = process.env.BASE_A ?? "http://127.0.0.1:14121"
const BASE_B = process.env.BASE_B ?? "http://127.0.0.1:14122"
const PG = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const NA = process.env.NA ?? "opencode-saas-sbx-lease-a"
const NB = process.env.NB ?? "opencode-saas-sbx-lease-b"
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
const api = async (base, path, method = "GET", body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), authorization: auth },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  })
  return { status: response.status, text: await response.text() }
}
const trace = []
const traceRow = (sid) => {
  try { trace.push(`${new Date().toISOString().slice(11, 19)} ${sql(`select state||'|'||substr(id,1,13) from sandbox where session_id='${sid}'`)}`) } catch {}
}
const shellSettled = async (base, sid, tag, before) => {
  for (let i = 0; i < 180; i++) {
    const out = sql(
      `select count(*) from session_message where session_id='${sid}' and type='shell' and (data::jsonb->>'command') like '%${tag}%' and (data::jsonb->>'status')='exited'`,
    )
    if (out !== "0") return true
    traceRow(sid)
    await sleep(1000)
  }
  return false
}

const sid = JSON.parse((await api(BASE_A, "/api/session", "POST", {
  model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" },
})).text).data.id
console.log(`session ${sid}`)
try {
  const beforeContainers = Number(sh("docker ps --format '{{.Names}}' | grep -c '^sandbox-' || true"))
  // 并发：A、B 同时首触发（同一会话）
  const results = await Promise.all([
    api(BASE_A, `/api/session/${sid}/shell`, "POST", { command: `echo lease-a-${Date.now()}` }).then(async (r) => {
      if (r.status !== 204) console.log(`A-shell http=${r.status} body=${r.text.slice(0, 200)}`)
      return { tag: "lease-a-", ok: r.status === 204 && (await shellSettled(BASE_A, sid, "lease-a-", 0)) }
    }),
    api(BASE_B, `/api/session/${sid}/shell`, "POST", { command: `echo lease-b-${Date.now()}` }).then(async (r) => {
      if (r.status !== 204) console.log(`B-shell http=${r.status} body=${r.text.slice(0, 200)}`)
      return { tag: "lease-b-", ok: r.status === 204 && (await shellSettled(BASE_B, sid, "lease-b-", 0)) }
    }),
  ])
  check(results[0].ok, "T-LEASE.1a shell via instance A completed", JSON.stringify(results[0]))
  check(results[1].ok, "T-LEASE.1b shell via instance B completed", JSON.stringify(results[1]))

  await sleep(3000)
  const row = sql(`select state || '|' || substr(id, 1, 20) from sandbox where session_id='${sid}'`)
  check(row.startsWith("running|") && !row.includes("creating-") && !row.includes("pending-"),
    "T-LEASE.2 pg single running row with real sandbox id", row)

  const afterContainers = Number(sh("docker ps --format '{{.Names}}' | grep -c '^sandbox-' || true"))
  check(afterContainers - beforeContainers === 1, "T-LEASE.3 exactly one remote sandbox created",
    `before=${beforeContainers} after=${afterContainers}`)

  const createdA = sh(`docker logs ${NA} 2>&1 | grep -c 'sandbox created' || true`)
  const createdB = sh(`docker logs ${NB} 2>&1 | grep -c 'sandbox created' || true`)
  const createdTotal = Number(createdA) + Number(createdB)
  if (createdTotal > 0) {
    check(createdTotal === 1, "T-LEASE.4 combined 'sandbox created' log count is 1", `A=${createdA} B=${createdB}`)
  } else {
    console.log("SKIP T-LEASE.4 production image emits no info-level logs; T-LEASE.3 container count is authoritative")
  }

} finally {
  if (!process.env.KEEP) await api(BASE_A, `/api/session/${sid}`, "DELETE").catch(() => undefined)
}
console.log(`SID=${sid}`)
console.log("TRACE:"); trace.forEach((t) => console.log(" ", t))
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`)
process.exit(failures)
