/**
 * e2e：组织协作链路（需先启动服务）。
 *   A 建组织 → A 建组织需求 → B 不可见 → 加入组织 → B 可读 → 移除 → B 不可见
 *
 * 运行：BASE=http://localhost:3201 BASE_DATABASE_SCHEMA=hn_base_dev bun run test/e2e/org-flow.mjs
 */
import pg from "pg"

const BASE = process.env.BASE ?? "http://localhost:3201"
const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:3002"
const SCHEMA = process.env.BASE_DATABASE_SCHEMA ?? "hn_base_dev"
const DB_URL = process.env.BASE_DATABASE_URL ?? "postgres://postgres:ab123456@127.0.0.1:5432/opencode-v2-up"

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

function assert(condition, message) {
  if (!condition) {
    console.error(`✗ ${message}`)
    process.exit(1)
  }
  console.log(`✓ ${message}`)
}

async function signupLogin(tag) {
  const email = `${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`
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
  assert(Boolean(token), `${tag} 登录获取 token`)
  return { email, token, auth: { authorization: `Bearer ${token}` } }
}

const pool = new pg.Pool({ connectionString: DB_URL })

const a = await signupLogin("orgA")
const b = await signupLogin("orgB")

const meB = await req("/api/me", { headers: b.auth })
const bId = meB.body.userId
assert(Boolean(bId), "读取 B 的用户 ID")

// A 创建组织
let r = await req("/api/auth/organization/create", {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({ name: "测试组织", slug: `org-${Date.now()}` }),
})
assert(r.status === 200 && Boolean(r.body?.id), "A 创建组织")
const orgId = r.body.id

// A 创建组织需求
r = await req("/api/requirements", {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({ title: "组织需求", orgId }),
})
assert(r.status === 201 && r.body.orgId === orgId, "A 创建组织需求（org_id 落库）")
const reqId = r.body.id

// B 未加入：不可见
r = await req(`/api/requirements/${reqId}`, { headers: b.auth })
assert(r.status === 404, "B 未加入组织时不可见（404）")

// B 加入组织
await pool.query(
  `INSERT INTO "${SCHEMA}"."member" (id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)`,
  [`mem_${Date.now()}`, orgId, bId, "member"],
)

r = await req(`/api/requirements/${reqId}`, { headers: b.auth })
assert(r.status === 200, "B 加入组织后可读")

// member 不能写（viewer 关系）
r = await req(`/api/requirements/${reqId}`, {
  method: "PATCH",
  headers: { ...b.auth, "content-type": "application/json" },
  body: JSON.stringify({ title: "越权修改" }),
})
assert(r.status === 404, "member 无 write 权限（404，不泄露存在性）")

// 列表可见
r = await req("/api/requirements", { headers: b.auth })
assert(r.body.items?.some((x) => x.id === reqId), "B 的列表中包含组织需求")

// 移除成员：立即失效
await pool.query(`DELETE FROM "${SCHEMA}"."member" WHERE organization_id = $1 AND user_id = $2`, [orgId, bId])
r = await req(`/api/requirements/${reqId}`, { headers: b.auth })
assert(r.status === 404, "移除成员后立即失去访问")

await pool.end()
console.log("\n组织协作链路 e2e 通过")
