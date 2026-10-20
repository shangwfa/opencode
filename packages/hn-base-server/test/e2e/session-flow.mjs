/**
 * e2e：需求 → 会话创建 → 代理读取 → 归属隔离 → 级联删除。
 * 需要 opencode SaaS 可访问（默认 http://localhost:14096）。
 *   BASE=http://localhost:3201 bun run test/e2e/session-flow.mjs
 */
import pg from "pg"

const BASE = process.env.BASE ?? "http://localhost:3201"
const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:3002"
const SCHEMA = process.env.BASE_DATABASE_SCHEMA ?? "hn_base_dev"
const DB_URL = process.env.BASE_DATABASE_URL ?? "postgres://postgres:ab123456@127.0.0.1:5432/opencode-v2-up"
const DIRECTORY = process.env.E2E_DIRECTORY ?? "/tmp"

function assert(condition, message) {
  if (!condition) {
    console.error(`✗ ${message}`)
    process.exit(1)
  }
  console.log(`✓ ${message}`)
}

async function req(path, init = {}) {
  const headers = new Headers(init.headers ?? {})
  headers.set("origin", ORIGIN)
  const res = await fetch(BASE + path, { ...init, headers })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text.slice(0, 150)
  }
  return { status: res.status, body, headers: res.headers }
}

async function signupLogin(tag) {
  const email = `${tag}_${Date.now()}@example.com`
  const password = "Passw0rd!123"
  await req("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: tag }),
  })
  const r = await req("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  let token = r.headers.get("set-auth-token")
  if (!token) token = (r.headers.get("set-cookie") ?? "").match(/better-auth\.session_token=([^;]+)/)?.[1]
  assert(Boolean(token), `${tag} 登录`)
  return { auth: { authorization: `Bearer ${token}` } }
}

const pool = new pg.Pool({ connectionString: DB_URL })
const a = await signupLogin("sesA")
const b = await signupLogin("sesB")

// A 建需求
let r = await req("/api/requirements", {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({ title: "会话流测试" }),
})
assert(r.status === 201, "A 创建需求")
const reqId = r.body.id

// A 在需求下建会话
r = await req("/api/sessions", {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({ requirementId: reqId, title: "需求对话", directory: DIRECTORY }),
})
assert(r.status === 201 && r.body.session?.id, `A 创建会话（${r.status}）`)
const sessionId = r.body.session.id

// PG 校验：requirement_session + 元组
const rs = await pool.query(
  `SELECT requirement_id, role FROM "${SCHEMA}"."requirement_session" WHERE session_id = $1`,
  [sessionId],
)
assert(rs.rows[0]?.requirement_id === reqId && rs.rows[0]?.role === "primary", "requirement_session 落库正确")

const tuples = await pool.query(
  `SELECT relation, subject_type FROM "${SCHEMA}"."relation_tuple" WHERE resource_type='session' AND resource_id=$1 ORDER BY relation`,
  [sessionId],
)
const relations = tuples.rows.map((x) => `${x.relation}:${x.subject_type}`)
assert(relations.includes("owner:user") && relations.includes("parent:requirement"), "会话元组含 owner + parent")

// 详情 / 消息 / 文件
r = await req(`/api/sessions/${sessionId}`, { headers: a.auth })
assert(r.status === 200 && r.body.id === sessionId, "代理读取会话详情")

r = await req(`/api/sessions/${sessionId}/messages`, { headers: a.auth })
assert(r.status === 200, "代理读取消息列表")

r = await req(`/api/sessions/${sessionId}/fs?path=${encodeURIComponent(DIRECTORY)}`, { headers: a.auth })
// 本地 SaaS 未接沙箱时返回 503（上游语义透传）；接入沙箱后应为 200
assert([200, 503].includes(r.status), `代理读取文件列表（${r.status}${r.status === 503 ? "：本地无沙箱，预期" : ""}）`)
if (r.status === 503) assert(r.body.code === "upstream_unavailable", "503 语义正确透传")

// 列表包含
r = await req("/api/sessions", { headers: a.auth })
assert(r.body.items?.some((x) => x.id === sessionId), "A 的会话列表包含该会话")

// B 越权
r = await req(`/api/sessions/${sessionId}`, { headers: b.auth })
assert(r.status === 404, "B 无法访问他人会话（404）")
r = await req(`/api/sessions/${sessionId}/messages`, { headers: b.auth })
assert(r.status === 404, "B 无法读取他人消息（404）")
r = await req(`/api/sessions/${sessionId}/fs?path=/tmp`, { headers: b.auth })
assert(r.status === 404, "B 无法读取他人文件（404）")

// 删除需求 → 会话 parent 元组级联删除 → 不可访问
r = await req(`/api/requirements/${reqId}`, { method: "DELETE", headers: a.auth })
assert(r.status === 200, "A 删除需求")
r = await req(`/api/sessions/${sessionId}`, { headers: a.auth })
assert(r.status === 404, "需求删除后会话访问被收回（级联删除元组）")

await pool.end()
console.log("\n会话流 e2e 通过")
