/**
 * 对指定草稿走完平台正常流程：草稿测试（逐步确认）→ 干净成功 → 发布。
 * 用于验证「AI 声称已沉淀但其实没有」的那份草稿。
 */
const BASE = "http://127.0.0.1:15301"
const DRAFT = process.argv[2] ?? "adraft_1fd3c917-1fb6-46dd-b49f-86394046fff7"

const login = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "http://localhost:3001" },
  body: JSON.stringify({ email: "demo@example.com", password: "ab123456" }),
})
const token = login.headers.get("set-auth-token")
if (!token) throw new Error("登录失败")
const req = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { status: res.status, ok: res.ok, body: json, text: text.slice(0, 400) }
}
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const detail = await req("GET", `/api/automation-apps/drafts/${DRAFT}`)
if (!detail.ok) throw new Error(`读取草稿失败 ${detail.status}: ${detail.text}`)
const draft = detail.body
log("草稿", draft.id, `v${draft.version}`, draft.definition.name, "已发布:", draft.publishedAppId ?? "否")
const parameters = Object.fromEntries((draft.definition.parameters ?? []).map((p) => [p.key, p.defaultValue]))

const started = await req("POST", `/api/automation-apps/drafts/${DRAFT}/runs`, {
  version: draft.version,
  requestKey: crypto.randomUUID(),
  parameters,
})
if (![200, 201].includes(started.status)) throw new Error(`启动测试失败 ${started.status}: ${started.text}`)
const runId = started.body.id
log("测试运行", runId, JSON.stringify(parameters).slice(0, 160))

const deadline = Date.now() + 12 * 60_000
let run = started.body
while (Date.now() < deadline) {
  await sleep(2500)
  const res = await req("GET", `/api/automation-apps/runs/${runId}`)
  if (!res.ok) throw new Error(`查询失败 ${res.status}`)
  run = res.body
  log(`status=${run.status} cursor=${run.cursor}/${run.definition.steps.length}`)
  if (run.status === "paused") {
    const cur = run.results[run.cursor]
    log(`  暂停原因=${cur?.pauseReason} ${String(run.error ?? "").slice(0, 120)}`)
    if (cur?.pauseReason === "confirmation") {
      const r = await req("POST", `/api/automation-apps/runs/${runId}/resume`, { action: "confirm" })
      log(`  确认执行此步 → ${r.status}`)
      continue
    }
    if (cur?.pauseReason === "repair_review") {
      const r = await req("POST", `/api/automation-apps/runs/${runId}/resume`, { action: "confirm" })
      log(`  应用修复并执行 → ${r.status}`)
      continue
    }
    break
  }
  if (["succeeded", "failed"].includes(run.status)) break
}

const clean = run.status === "succeeded" &&
  run.results.length === draft.definition.steps.length &&
  run.results.every((r) => r.status === "succeeded" && !r.skipped && !r.repairedOperation)
console.log("\n=== 测试结果 ===")
console.log(JSON.stringify({
  runId,
  status: run.status,
  error: run.error,
  clean,
  steps: run.results.map((r) => ({ id: r.stepId, status: r.status, skipped: !!r.skipped, repaired: !!r.repairedOperation, output: (r.output ?? "").slice(0, 300) })),
}, null, 2))

if (!clean) {
  console.log("\n未达到发布门槛，不发布。")
  process.exit(1)
}

const published = await req("POST", `/api/automation-apps/drafts/${DRAFT}/publish`, { version: draft.version, runId })
console.log("\n=== 发布 ===")
console.log(JSON.stringify({ status: published.status, appId: published.body?.id, version: published.body?.version, error: published.text }, null, 2))
