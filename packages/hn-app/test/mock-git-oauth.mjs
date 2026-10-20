/**
 * mock Git OAuth 服务（GitHub 风格），用于本地验证 OAuth2 连接流程。
 * 配合：GIT_GITHUB_CLIENT_ID/SECRET + GIT_OAUTH_BASE=http://127.0.0.1:3297
 *
 * 端点：
 *  - GET  /login/oauth/authorize → 302 回 redirect_uri?code=mock-code&state=...
 *  - POST /login/oauth/access_token → { access_token }
 *  - GET  /api/v3/user → 身份（GitHubClient 在非 github.com 时用 {base}/api/v3）
 */
import { createServer } from "node:http"

const PORT = Number(process.env.MOCK_OAUTH_PORT ?? 3297)

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (url.pathname === "/login/oauth/authorize") {
    const redirect = url.searchParams.get("redirect_uri")
    const state = url.searchParams.get("state") ?? ""
    if (!redirect) return json(400, { error: "missing redirect_uri" })
    const target = new URL(redirect)
    target.searchParams.set("code", "mock-code")
    target.searchParams.set("state", state)
    res.writeHead(302, { location: target.toString() })
    res.end()
    return
  }

  if (url.pathname === "/login/oauth/access_token") {
    return json(200, { access_token: "mock-oauth-token", token_type: "bearer", scope: "repo read:user" })
  }

  if (url.pathname === "/api/v3/user") {
    if (req.headers.authorization !== "Bearer mock-oauth-token") {
      return json(401, { message: "unauthorized" })
    }
    return json(200, { login: "oauth-user", name: "OAuth User" })
  }

  return json(404, { message: "not found" })
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock Git OAuth on http://127.0.0.1:${PORT}`)
})
