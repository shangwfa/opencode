// OAuth 全流程 e2e：client 配置 → 发起 → （人工完成授权）→ 轮询 complete → 关联 oauth2 连接 → MCP 可用
// 用法：bun e2e-oauth.mjs <baseUrl> <clientId> <clientSecret> [callbackBrowser=open|manual]
// client 回调地址需配置为 <baseUrl>/connector/oauth/callback
const BASE = process.argv[2] ?? "http://127.0.0.1:4096"
const CLIENT_ID = process.argv[3]
const CLIENT_SECRET = process.argv[4]
const results = []
const record = (id, name, expected, actual, pass) => results.push({ id, name, expected, actual: String(expected) === String(actual) ? "match" : String(actual).slice(0, 60), pass: pass ?? String(expected) === String(actual) })
const api = async (method, path, body, headers = {}) => {
  const res = await fetch(BASE + path, { method, headers: { authorization: "Basic " + Buffer.from("opencode:ab123456").toString("base64"), "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const main = async () => {
  if (!CLIENT_ID || !CLIENT_SECRET) return console.error("usage: bun e2e-oauth.mjs <baseUrl> <clientId> <clientSecret>")
  // 1. 配置 client（一次性）
  const put = await api("PUT", "/api/connector/oauth/clients/github", { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  record("oa-1", "configure oauth client", 204, put.status)
  // 2. 建会话 + 发起 OAuth
  const session = await api("POST", "/api/session", {})
  const sessionID = session.body?.id ?? session.body?.data?.id
  record("oa-2", "create session", true, Boolean(sessionID))
  const start = await api("POST", `/api/session/${sessionID}/connector/connections/oauth`, { service: "github", alias: "gh-oauth" })
  const url = start.body?.authorizationUrl
  const requestID = start.body?.connectionRequestID
  record("oa-3", "start oauth", true, Boolean(url && requestID), url?.startsWith("https://github.com/login/oauth/authorize"))
  if (!url) return finish(sessionID)
  console.log("\n>>> 请在浏览器打开并完成授权（60s 等待，可多次轮询共 5 分钟）：\n" + url + "\n")
  try { (await import("node:child_process")).execSync(`open "${url}"`) } catch {}
  // 3. 轮询 complete
  let completed = null
  for (let i = 0; i < 60 && !completed?.connection; i++) {
    await sleep(5000)
    completed = (await api("POST", `/api/session/${sessionID}/connector/connections/oauth/${requestID}/complete`, { alias: "gh-oauth" })).body
    if (completed?.status === "failed" || completed?.status === "expired") break
  }
  record("oa-4", "complete oauth → connected", "connected", completed?.status ?? "timeout", completed?.status === "connected")
  record("oa-5", "oauth2 connection associated", true, completed?.connection?.authType === "oauth2")
  // 4. MCP 通道用 oauth2 连接执行真实 GitHub API
  if (completed?.connection) {
    const attach = await api("POST", `/api/session/${sessionID}/connector/mcp`)
    const bearer = attach.body?.config?.headers?.authorization
    // oa-6：不带 connectionName（AI 实际使用形态）——当前因产品缺陷失败（OAuth 连接名为引擎随机 UUID 而非 "default"，store.get(service,"default") 落空 → connectionId=undefined → token 白名单拒绝）
    const exec = await api("POST", "/api/connector/mcp", { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: "execute_action", arguments: { actionId: "github.get_current_user", input: {} } } }, { authorization: bearer })
    const text = JSON.stringify(exec.body ?? {})
    record("oa-6", "execute without connectionName (AI default form)", true, /login/.test(text), /login/.test(text))
    console.log("\n=== oa-6 execute_action github.get_current_user 响应（前 500 字）===\n" + text.slice(0, 500) + "\n")
    // oa-6b：显式引擎 connectionName（经 MCP list_connections 取得）——验证 OAuth 凭据本身真实可用
    const lc = await api("POST", "/api/connector/mcp", { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: "list_connections", arguments: { service: "github" } } }, { authorization: bearer })
    const engineName = JSON.parse(lc.body?.body?.result?.content?.[0]?.text ?? "{}")?.data?.find?.((c) => c.authType === "oauth2")?.connectionName
    const exec2 = await api("POST", "/api/connector/mcp", { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: "execute_action", arguments: { actionId: "github.get_current_user", input: {}, connectionName: engineName } } }, { authorization: bearer })
    const text2 = JSON.stringify(exec2.body ?? {})
    record("oa-6b", "execute with engine connectionName (real github api)", true, /login/.test(text2), /login/.test(text2))
    console.log("=== oa-6b（connectionName=" + engineName + "）响应（前 500 字）===\n" + text2.slice(0, 500) + "\n")
  }
  // 5. 清理
  const listed = await api("GET", `/api/session/${sessionID}/connector/connections`)
  for (const c of listed.body?.connections ?? []) await api("DELETE", `/api/session/${sessionID}/connector/connections/${c.id}`)
  record("oa-7", "cleanup session", true, (await api("DELETE", `/api/session/${sessionID}`)).status < 500)
  finish()
}
const finish = async (sessionID) => {
  if (sessionID) await api("DELETE", `/api/session/${sessionID}`).catch(() => null)
  const failed = results.filter((r) => !r.pass)
  console.table(results)
  console.log(failed.length === 0 ? "ALL PASS" : `FAILED: ${failed.map((f) => f.id).join(", ")}`)
  process.exit(failed.length === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
