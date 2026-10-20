/**
 * mock GitLab（验证 Git 服务连接 + 应用创建）。
 *   bun run test/mock-gitlab.mjs
 * 记录最近一次提交的文件动作，便于断言脚手架是否写入。
 */
import { createServer } from "node:http"

const PORT = Number(process.env.MOCK_GITLAB_PORT ?? 3299)
const TOKEN = process.env.MOCK_GITLAB_TOKEN ?? "glpat-valid-token-123"

export const state = {
  projects: new Set(),
  lastCommit: null,
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === "/__state") return json(200, { projects: [...state.projects], lastCommit: state.lastCommit })
  if (req.headers["private-token"] !== TOKEN) return json(401, { message: "401 Unauthorized" })

  let raw = ""
  req.on("data", (c) => (raw += c))
  req.on("end", () => {
    let body = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      body = {}
    }

    if (url.pathname === "/api/v4/user") return json(200, { username: "mock-user", name: "Mock User" })

    if (url.pathname === "/api/v4/groups") {
      return json(200, [
        { full_path: "team-alpha", name: "Team Alpha" },
        { full_path: "team-beta", name: "Team Beta" },
      ])
    }

    if (url.pathname === "/api/v4/projects" && req.method === "POST") {
      state.projects.add(body.name)
      return json(200, {
        path_with_namespace: `group/${body.name}`,
        web_url: `http://gitlab.mock/group/${body.name}`,
      })
    }

    if (url.pathname.endsWith("/repository/commits") && req.method === "POST") {
      state.lastCommit = {
        branch: body.branch,
        message: body.commit_message,
        files: (body.actions ?? []).map((a) => a.file_path),
      }
      return json(200, { id: "abc1234" })
    }

    if (url.pathname.endsWith("/repository/branches") && req.method === "POST") {
      return json(201, { name: body.branch || "unknown" })
    }

    if (url.pathname.endsWith("/repository/branches")) {
      return json(200, [
        { name: "main", default: true, protected: false, web_url: "http://gitlab.mock/group/repo/-/tree/main" },
        { name: "develop", default: false, protected: false },
      ])
    }

    if (url.pathname.match(/\/api\/v4\/projects\/[^/]+$/)) {
      return json(200, { path_with_namespace: "group/repo", web_url: "http://gitlab.mock/group/repo" })
    }

    return json(404, { message: "not found" })
  })
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock GitLab on http://127.0.0.1:${PORT} (token=${TOKEN})`)
})
