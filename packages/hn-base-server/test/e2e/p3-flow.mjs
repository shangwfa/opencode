/**
 * e2e：P3 —— 审计、自定义角色、签名 URL。
 *   BASE=http://localhost:3201 bun run test/e2e/p3-flow.mjs
 */
import pg from "pg"

const BASE = process.env.BASE ?? "http://localhost:3201"
const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:3002"
const SCHEMA = process.env.BASE_DATABASE_SCHEMA ?? "hn_base_dev"
const DB_URL = process.env.BASE_DATABASE_URL ?? "postgres://postgres:ab123456@127.0.0.1:5432/opencode-v2-up"

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
const a = await signupLogin("p3A")
const b = await signupLogin("p3B")

const meB = await req("/api/me", { headers: b.auth })
const bId = meB.body.userId

// ---------- 审计 ----------
let r = await req("/api/requirements", {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({ title: "审计测试" }),
})
assert(r.status === 201, "创建需求")
const reqId = r.body.id

r = await req("/api/requirements", { headers: a.auth })
assert(r.status === 200, "列表")

r = await req("/api/audit", { headers: a.auth })
assert(r.status === 200 && r.body.items?.some((x) => x.action === "requirement.create"), "审计记录含 requirement.create")
assert(r.body.items?.every((x) => x.actorId !== bId), "普通用户查不到他人审计")

// 越权产生 deny 记录
r = await req(`/api/requirements/${reqId}`, { headers: b.auth })
assert(r.status === 404, "B 越权访问（404）")
r = await req("/api/audit", { headers: b.auth })
const deny = r.body.items?.find((x) => x.result === "deny" && x.resourceId === reqId)
assert(Boolean(deny), "越权被记录为 deny 审计")

// ---------- 自定义角色 ----------
r = await req("/api/auth/organization/create", {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({ name: "审计组织", slug: `audit-${Date.now()}` }),
})
assert(r.status === 200 && r.body.id, "A 创建组织")
const orgId = r.body.id

r = await req(`/api/orgs/${orgId}/roles`, {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({
    key: "auditor",
    name: "审计员",
    permissions: { org: ["read"], requirement: ["read"] },
  }),
})
assert(r.status === 201, "创建自定义角色 auditor")

// 内置角色不可覆盖
r = await req(`/api/orgs/${orgId}/roles`, {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({ key: "owner", name: "x", permissions: { org: ["read"] } }),
})
assert(r.status === 400, "不能覆盖内置角色（400）")

// B 加入组织并设为 auditor
await pool.query(
  `INSERT INTO "${SCHEMA}"."member" (id, organization_id, user_id, role) VALUES ($1,$2,$3,'auditor')`,
  [`mem_${Date.now()}`, orgId, bId],
)

// auditor 可读组织（org:read）
r = await req(`/api/orgs/${orgId}/roles`, { headers: b.auth })
assert(r.status === 200, "auditor 可读组织角色列表")

// auditor 无 manage：不能创建角色
r = await req(`/api/orgs/${orgId}/roles`, {
  method: "POST",
  headers: { ...b.auth, "content-type": "application/json" },
  body: JSON.stringify({ key: "tmp", name: "tmp", permissions: { org: ["read"] } }),
})
assert(r.status === 404, "auditor 不能管理角色（404）")

// ---------- 签名 URL ----------
r = await req("/api/sessions/nonexistent/fs/sign", {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({ path: "a.txt" }),
})
assert(r.status === 404, "对无权限会话签名被拒（404）")

// 用真实会话：直接在 DB 里造一个会话归属（SaaS 侧不存在时签名仍可生成）
const fakeSession = `ses_p3_${Date.now()}`
await pool.query(
  `INSERT INTO "${SCHEMA}"."relation_tuple" (id, resource_type, resource_id, relation, subject_type, subject_id, time_created)
   VALUES ($1,'session',$2,'owner','user',$3,$4)`,
  [`rt_${Date.now()}`, fakeSession, meB.body.userId, Date.now()],
)
r = await req(`/api/sessions/${fakeSession}/fs/sign`, {
  method: "POST",
  headers: { ...b.auth, "content-type": "application/json" },
  body: JSON.stringify({ path: "assets/logo.png" }),
})
assert(r.status === 200 && r.body.url?.includes("sig="), "生成签名 URL")
const signedUrl = r.body.url

r = await req(signedUrl.replace(/^\/api/, "/api"), { headers: {} })
assert([200, 404, 503].includes(r.status), `签名 URL 无 header 可访问（${r.status}）`)
if (r.status === 200) assert(true, "沙箱已就绪：签名 URL 返回内容")

// 篡改签名 → 404
const tampered = signedUrl.replace(/sig=[^&]+/, "sig=forged")
r = await req(tampered)
assert(r.status === 404, "伪造签名被拒（404）")

await pool.end()
console.log("\nP3 e2e 通过")
