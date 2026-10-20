/**
 * e2e：Git 服务连接（内置 mock GitLab）。
 *   需要先启动 hn-base-server。
 *   BASE=http://localhost:3201 bun run test/e2e/git-flow.mjs
 */
import { createServer } from "node:http"

const BASE = process.env.BASE ?? "http://localhost:3201"
const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:3002"
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 3296)
const VALID_TOKEN = "glpat-valid-token-123"

function assert(condition, message) {
  if (!condition) {
    console.error(`✗ ${message}`)
    process.exit(1)
  }
  console.log(`✓ ${message}`)
}

// ---- mock GitLab ----
const mock = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`)
  if (req.headers["private-token"] !== VALID_TOKEN) {
    res.writeHead(401, { "content-type": "application/json" })
    res.end(JSON.stringify({ message: "401 Unauthorized" }))
    return
  }
  if (url.pathname === "/api/v4/user") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ username: "tester", name: "Tester" }))
    return
  }
  if (url.pathname.endsWith("/repository/branches")) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify([
        { name: "main", default: true, protected: true, web_url: "https://gitlab.mock/group/repo/-/tree/main" },
        { name: "feature/REQ-1", default: false, protected: false },
      ]),
    )
    return
  }
  res.writeHead(404, { "content-type": "application/json" })
  res.end(JSON.stringify({ message: "not found" }))
})
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve))

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

const a = await signupLogin("gitA")
const b = await signupLogin("gitB")

// 无效 token → 400
let r = await req("/api/git-providers", {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({
    type: "gitlab",
    displayName: "Mock GitLab",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
    token: "glpat-wrong-token",
  }),
})
assert(r.status === 400 && r.body.field === "token", "无效 token 被拒绝（400）")

// 有效 token → 201
r = await req("/api/git-providers", {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({
    type: "gitlab",
    displayName: "Mock GitLab",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
    token: VALID_TOKEN,
    scope: "read",
  }),
})
assert(r.status === 201 && r.body.id, "注册 Git 服务成功")
assert(!JSON.stringify(r.body).includes(VALID_TOKEN), "响应不含明文 token")
assert(typeof r.body.secretHint === "string", "响应只返回脱敏提示")
const providerId = r.body.id

// 列表（A 可见，B 不可见）
r = await req("/api/git-providers", { headers: a.auth })
assert(r.body.items?.some((x) => x.id === providerId), "A 的列表包含该服务")
r = await req("/api/git-providers", { headers: b.auth })
assert(!r.body.items?.some((x) => x.id === providerId), "B 的列表不含他人服务")

// 列分支
r = await req(`/api/git-providers/${providerId}/branches?repo=https://gitlab.mock/group/repo.git`, { headers: a.auth })
assert(r.status === 200 && r.body.items?.length === 2, "列分支成功")
assert(r.body.items.some((x) => x.name === "main" && x.isDefault), "默认分支标记正确")

// B 越权列分支 → 404
r = await req(`/api/git-providers/${providerId}/branches?repo=group/repo`, { headers: b.auth })
assert(r.status === 404, "B 无权使用该服务（404）")

// 重新校验
r = await req(`/api/git-providers/${providerId}/verify`, { method: "POST", headers: a.auth })
assert(r.status === 200 && r.body.identity?.username === "tester", "重新校验成功")

// 删除
r = await req(`/api/git-providers/${providerId}`, { method: "DELETE", headers: a.auth })
assert(r.status === 200, "删除服务成功")
r = await req("/api/git-providers", { headers: a.auth })
assert(!r.body.items?.some((x) => x.id === providerId), "删除后列表不可见")

mock.close()
console.log("\nGit 服务 e2e 通过")
