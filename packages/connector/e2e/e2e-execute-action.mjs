// execute_action 真实执行 e2e：经 SaaS MCP 通道调用 no_auth provider（arxiv 公开 API），无需真实凭据。
// 前置：服务已启动（connector 环境变量齐备）。用法：bun e2e-execute-action.mjs [baseUrl]
const BASE = process.argv[2] ?? "http://127.0.0.1:14963"
const BASIC = "Basic " + Buffer.from("opencode:ab123456").toString("base64")
const results = []
const record = (id, name, expected, actual, pass) => results.push({ id, name, expected, actual, pass: pass ?? String(actual) === String(expected) })
const api = async (method, path, body, headers = {}) => {
  const res = await fetch(BASE + path, { method, headers: { authorization: BASIC, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed = text
  try { parsed = JSON.parse(text) } catch { /* 保留原始文本 */ }
  return { status: res.status, body: parsed }
}
const mcp = async (bearer, methodCall, params) =>
  api("POST", "/api/connector/mcp", { jsonrpc: "2.0", id: crypto.randomUUID(), method: methodCall, params }, { authorization: bearer })

const main = async () => {
  // 1. 创建会话 + 关联一个连接（满足 attach 的 ≥1 连接前置；postmark 宽松校验）
  const session = await api("POST", "/api/session", { title: "e2e-execute-action" })
  const sessionID = session.body?.data?.id ?? session.body?.id
  record("ea-1", "create session", true, Boolean(sessionID))
  if (!sessionID) return finish()
  const conn = await api("POST", `/api/session/${sessionID}/connector/connections`, { service: "postmark", authType: "api_key", values: { apiKey: "e2e-fake-key" } })
  record("ea-2", "associate connection", 200, conn.status)
  // 2. attach → Bearer
  const attach = await api("POST", `/api/session/${sessionID}/connector/mcp`)
  const bearer = attach.body?.config?.headers?.authorization
  record("ea-3", "attach mcp", 200, attach.status)
  if (!bearer) return finish(sessionID)
  const init = await mcp(bearer, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "0" } })
  record("ea-4", "mcp initialize", true, init.body?.body?.result?.serverInfo !== undefined)
  // 3. 真实执行：arxiv.search_papers（no_auth 公开 API，真实第三方 HTTP）
  const guide = await mcp(bearer, "tools/call", { name: "get_action_guide", arguments: { actionId: "arxiv.search_papers" } })
  record("ea-5", "get_action_guide(arxiv)", true, JSON.stringify(guide.body?.body?.result ?? guide.body).includes("query"))
  const exec = await mcp(bearer, "tools/call", { name: "execute_action", arguments: { actionId: "arxiv.search_papers", input: { query: "effect systems", maxResults: 2 } } })
  const execText = JSON.stringify(exec.body?.body?.result ?? exec.body ?? {})
  const isIsError = exec.body?.body?.result?.isError === true
  const hasPapers = !isIsError && /title|summary|arxiv/i.test(execText)
  record("ea-6", "execute_action arxiv real http", "real result", hasPapers ? "real result" : execText.slice(0, 200), hasPapers)
  // 4. 清理
  const listed = await api("GET", `/api/session/${sessionID}/connector/connections`)
  const cid = listed.body?.connections?.[0]?.id
  if (cid) record("ea-7", "remove connection", 204, (await api("DELETE", `/api/session/${sessionID}/connector/connections/${cid}`)).status)
  record("ea-8", "delete session", true, (await api("DELETE", `/api/session/${sessionID}`)).status < 500)
  finish()
}
const finish = async (sessionID) => {
  if (sessionID) await api("DELETE", `/api/session/${sessionID}`).catch(() => null)
  const failed = results.filter((r) => !r.pass)
  console.table(results.map(({ id, name, expected, actual, pass }) => ({ id, name, expected: String(expected).slice(0, 40), actual: String(actual).slice(0, 60), pass })))
  console.log(failed.length === 0 ? "ALL PASS" : `FAILED: ${failed.map((f) => f.id).join(", ")}`)
  process.exit(failed.length === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
