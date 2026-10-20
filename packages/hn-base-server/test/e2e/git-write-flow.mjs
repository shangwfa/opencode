/**
 * e2e：Git 写链路（mock GitLab）——建仓 → 提交 → 开 MR → webhook merged → 需求 done。
 *   BASE=http://localhost:3201 bun run test/e2e/git-write-flow.mjs
 */
import { createHmac } from "node:crypto"
import { createServer } from "node:http"
import pg from "pg"

const BASE = process.env.BASE ?? "http://localhost:3201"
const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:3002"
const SCHEMA = process.env.BASE_DATABASE_SCHEMA ?? "hn_base_dev"
const DB_URL = process.env.BASE_DATABASE_URL ?? "postgres://postgres:ab123456@127.0.0.1:5432/opencode-v2-up"
const MOCK_PORT = 3298
const VALID_TOKEN = "glpat-write-token-999"

function assert(condition, message) {
  if (!condition) {
    console.error(`✗ ${message}`)
    process.exit(1)
  }
  console.log(`✓ ${message}`)
}

// ---------------- mock GitLab ----------------
const state = { mrCreated: false, commitActions: 0, projectCreated: false }
const mock = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`)
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  if (req.headers["private-token"] !== VALID_TOKEN) return json(401, { message: "unauthorized" })

  let raw = ""
  req.on("data", (c) => (raw += c))
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {}
    if (url.pathname === "/api/v4/user") return json(200, { username: "tester" })
    if (url.pathname === "/api/v4/projects" && req.method === "POST") {
      state.projectCreated = true
      return json(200, {
        path_with_namespace: `group/${body.name}`,
        web_url: `http://gitlab.mock/group/${body.name}`,
      })
    }
    if (url.pathname.endsWith("/repository/commits") && req.method === "POST") {
      state.commitActions = body.actions?.length ?? 0
      return json(200, { id: "abc1234" })
    }
    if (url.pathname.endsWith("/merge_requests") && req.method === "POST") {
      state.mrCreated = true
      return json(200, {
        iid: 7,
        web_url: "http://gitlab.mock/group/repo/-/merge_requests/7",
        state: "opened",
        source_branch: body.source_branch,
        target_branch: body.target_branch,
      })
    }
    if (url.pathname.endsWith("/repository/branches")) {
      return json(200, [{ name: "main", default: true, protected: false }])
    }
    return json(404, { message: "not found" })
  })
})
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r))

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
const a = await signupLogin("gwA")

// 注册 Git 服务
let r = await req("/api/git-providers", {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({
    type: "gitlab",
    displayName: "Mock GitLab",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
    token: VALID_TOKEN,
    scope: "write",
  }),
})
assert(r.status === 201, "注册 Git 服务")
const providerId = r.body.id

// 建仓
r = await req(`/api/git-providers/${providerId}/repos`, {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({ name: "demo-repo", visibility: "private", initReadme: true }),
})
assert(r.status === 201 && r.body.repo?.path === "group/demo-repo", "建仓成功（path 归一）")
assert(state.projectCreated, "mock 收到建仓请求")

// 提交（多文件）
r = await req(`/api/git-providers/${providerId}/commit`, {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({
    repo: "group/demo-repo",
    branch: "feature/REQ-1",
    startBranch: "main",
    message: "feat: 接入订单中心",
    actions: [
      { action: "create", path: "src/order.ts", content: "export const x = 1" },
      { action: "update", path: "README.md", content: "# demo" },
    ],
  }),
})
assert(r.status === 200 && r.body.commitId === "abc1234", "提交成功（一次多文件）")
assert(state.commitActions === 2, "mock 收到 2 个文件操作")

// 需求：创建 → in_progress
r = await req("/api/requirements", {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({ title: "Git 写链路", repoUrl: "http://gitlab.mock/group/demo-repo" }),
})
assert(r.status === 201, "创建需求")
const reqId = r.body.id

r = await req(`/api/requirements/${reqId}`, {
  method: "PATCH",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({ status: "in_progress" }),
})
assert(r.status === 200 && r.body.status === "in_progress", "状态 open → in_progress")

// 非法迁移：in_progress → done（必须经过 pending_publish）
r = await req(`/api/requirements/${reqId}`, {
  method: "PATCH",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({ status: "done" }),
})
assert(r.status === 409 && r.body.code === "invalid_status_transition", "非法状态迁移被拒（409）")

// 开 MR
r = await req(`/api/requirements/${reqId}/changes`, {
  method: "POST",
  headers: { ...a.auth, "content-type": "application/json" },
  body: JSON.stringify({
    providerInstanceId: providerId,
    repo: "group/demo-repo",
    sourceBranch: "feature/REQ-1",
    targetBranch: "main",
    title: "feat: 接入订单中心",
  }),
})
assert(r.status === 201 && r.body.number === 7, "创建 MR 成功")
assert(state.mrCreated, "mock 收到 MR 请求")
const changeId = r.body.id

r = await req(`/api/requirements/${reqId}`, { headers: a.auth })
assert(r.body.status === "pending_publish", "开 MR 后自动进入 pending_publish")

// webhook：merged → 需求 done
const payload = {
  object_kind: "merge_request",
  object_attributes: { iid: 7, state: "merged" },
  project: { path_with_namespace: "group/demo-repo" },
}
const raw = JSON.stringify(payload)
const eventId = `evt-${Date.now()}`
r = await req(`/api/git/webhook/gitlab/${providerId}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-gitlab-token": VALID_TOKEN, "x-gitlab-event-uuid": eventId },
  body: raw,
})
assert(r.status === 200 && r.body.status === "done", "webhook merged → 需求 done")

const changeRow = await pool.query(`SELECT state, time_merged FROM "${SCHEMA}"."requirement_change" WHERE id=$1`, [changeId])
assert(changeRow.rows[0]?.state === "merged" && Number(changeRow.rows[0]?.time_merged) > 0, "requirement_change 更新为 merged")

// 幂等
r = await req(`/api/git/webhook/gitlab/${providerId}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-gitlab-token": VALID_TOKEN, "x-gitlab-event-uuid": eventId },
  body: raw,
})
assert(r.status === 200 && r.body.duplicate === true, "重复事件幂等（duplicate）")

// 错误签名
r = await req(`/api/git/webhook/gitlab/${providerId}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-gitlab-token": "wrong", "x-gitlab-event-uuid": "evt-bad" },
  body: raw,
})
assert(r.status === 401, "错误签名被拒（401）")

// provider 与实例不匹配 → 拒绝（防止跨 provider 伪造）
r = await req(`/api/git/webhook/github/${providerId}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": `gh-${Date.now()}` },
  body: "{}",
})
assert(r.status === 400, "provider 与实例不匹配被拒（400）")

await pool.end()
mock.close()
console.log("\nGit 写链路 e2e 通过")
