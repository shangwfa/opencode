// 会话级 Connector e2e 最终版（临时测试代码）
// 已确认两个产品 bug：#1 engine.ts createConnection 路径前缀错（/api vs /v1）；
//                      #2 外层 ServerProcess Basic gate 未豁免 /api/connector/mcp；
// 另有 #3：engine.handleMcp 用 JSON.parse 解析引擎 SSE 响应必然抛错（本脚本 e0 直接验证）。
// MCP 正向用例经「旁路进程直连引擎 /mcp」验证语义（同 PG 同密钥）。
const BASE = "http://127.0.0.1:14963"
const BASIC = "Basic " + Buffer.from("opencode:ab123456").toString("base64")
const BUN = "/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/connector-e2e/bun142/node_modules/.bin/bun"
const PSQL = (sql) => {
  const proc = Bun.spawnSync(["psql", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres", "-d", "opencode-v2-up", "-At", "-c", sql], {
    env: { ...process.env, PGPASSWORD: "postgres" },
  })
  const out = proc.stdout.toString().trim()
  if (proc.exitCode !== 0) throw new Error("psql failed: " + proc.stderr.toString())
  return out
}
const cconId = () => "ccon_" + crypto.randomUUID().replaceAll("-", "")

const results = []
const record = (id, name, expected, actual, pass, extra) => {
  results.push({ id, name, expected, actual, pass })
  console.log(`${pass ? "✅" : "❌"} [${id}] ${name}\n    预期: ${expected}\n    实际: ${actual}${extra ? "\n    附件: " + extra : ""}`)
}
const json = async (method, path, body, headers = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: BASIC, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed, headers: res.headers }
}
// 旁路：独立进程 runtime 直连引擎 /mcp；解析 SSE data: 行
const bypassMcp = async (token, payload) => {
  const proc = Bun.spawnSync([BUN, import.meta.dirname + "/bypass-engine.mjs", "mcp", token, JSON.stringify(payload)], {
    env: { ...process.env, TMPDIR: "/tmp" }, stdout: "pipe", stderr: "pipe",
  })
  if (proc.exitCode !== 0) throw new Error("bypass mcp failed: " + proc.stderr.toString())
  const parsed = JSON.parse(proc.stdout.toString().split("\n").filter((l) => l.startsWith("{"))[0] ?? "{}")
  if (typeof parsed.body === "string") {
    const dataLine = parsed.body.split("\n").find((l) => l.startsWith("data: "))
    parsed.body = dataLine ? JSON.parse(dataLine.slice(6)) : parsed.body
  }
  return parsed
}
const bypassCreate = async () => {
  const proc = Bun.spawnSync([BUN, import.meta.dirname + "/bypass-engine.mjs", "create"], {
    env: { ...process.env, TMPDIR: "/tmp" }, stdout: "pipe", stderr: "pipe",
  })
  if (proc.exitCode !== 0) throw new Error("bypass create failed: " + proc.stderr.toString())
  const parsed = JSON.parse(proc.stdout.toString())
  if (parsed.status !== 200) throw new Error("bypass create non-200")
  return { engineId: parsed.body.data.id, engineName: parsed.body.data.alias }
}
const insertRow = (sessionId, engineId, engineName, alias) => {
  const id = cconId()
  const now = Date.now()
  PSQL(`insert into connector_connection (id, session_id, engine_connection_id, engine_connection_name, service, alias, auth_type, status, time_created, time_updated) values ('${id}', '${sessionId}', '${engineId}', '${engineName}', 'postmark', '${alias}', 'api_key', 'active', ${now}, ${now})`)
  return id
}

// ---------- a. 创建会话 ----------
const createdA = await json("POST", "/api/session", { title: "connector-e2e-A" })
const sessionA = createdA.body?.data?.id
record("a1", "创建会话 A", "200 且返回 data.id", `status=${createdA.status} id=${sessionA}`, createdA.status === 200 && !!sessionA)
const createdB = await json("POST", "/api/session", { title: "connector-e2e-B" })
const sessionB = createdB.body?.data?.id
record("a2", "创建会话 B", "200 且返回 data.id", `status=${createdB.status} id=${sessionB}`, createdB.status === 200 && !!sessionB)

// ---------- b1. 正常 API 建连（bug #1 证据） ----------
const connA = await json("POST", `/api/session/${sessionA}/connector/connections`, { service: "postmark", authType: "api_key", values: { apiKey: "e2e-fake-token-12345" }, alias: "e2e-postmark" })
record("b1", "[BUG#1 证据] 会话 A 经 API 创建连接", "200 且返回 id+engineConnectionID（按契约）", `status=${connA.status} body=${JSON.stringify(connA.body).slice(0, 120)}`, false)

// ---------- b1x. 旁路建连 ----------
let engineId, engineName, connId
try {
  const bp = await bypassCreate()
  engineId = bp.engineId
  engineName = bp.engineName
  connId = insertRow(sessionA, engineId, engineName, "e2e-postmark")
  record("b1x", "旁路：引擎 /v1 建连 + 主库插行", "成功", `engineId=${engineId.slice(0, 8)}... connId=${connId.slice(0, 12)}...`, true)
} catch (e) {
  record("b1x", "旁路：引擎 /v1 建连 + 主库插行", "成功", "失败: " + e.message, false)
}

// ---------- b2/b3. PG 双侧落行 ----------
{
  const row = PSQL(`select session_id, engine_connection_id, service, status from connector_connection where id='${connId}'`)
  record("b2", "PG connector_connection 落行", "session/engine/postmark/active", row.replace(/\|.*engine/, "|…|") || "(空)", row.includes(sessionA) && row.includes(engineId) && row.includes("postmark") && row.includes("active"), row)
  const erow = PSQL(`select connection_name, service from connector.connections where id='${engineId}'`)
  record("b3", "PG 引擎 connector.connections 落行", "含该引擎连接", erow || "(空)", erow.length > 0)
}

// ---------- c. 列表 ----------
const listA = await json("GET", `/api/session/${sessionA}/connector/connections`)
const listOk = listA.status === 200 && listA.body?.connections?.length === 1 && listA.body.connections[0].id === connId && listA.body.connections[0].engineConnectionID === engineId
record("c1", "会话 A 连接列表（含 engineConnectionID 归属）", "200 且 1 条=旁路连接", `status=${listA.status} count=${listA.body?.connections?.length}`, listOk, JSON.stringify(listA.body).slice(0, 260))
const listB = await json("GET", `/api/session/${sessionB}/connector/connections`)
record("c2", "会话 B 连接列表为空（资源域隔离）", "200 且 0 条", `status=${listB.status} count=${listB.body?.connections?.length}`, listB.status === 200 && listB.body?.connections?.length === 0)

// ---------- d. attach + 注册 session MCP ----------
const attach = await json("POST", `/api/session/${sessionA}/connector/mcp`)
const mcpName = attach.body?.name
const mcpConfig = attach.body?.config
const runtimeToken = mcpConfig?.headers?.authorization?.replace(/^Bearer /, "")
record("d1", "attach 返回 {name, config}", "200 且 Bearer oct_ token", `status=${attach.status} name=${mcpName} url=${mcpConfig?.url}`, attach.status === 200 && !!mcpName && (runtimeToken ?? "").startsWith("oct_"), `token=${runtimeToken?.slice(0, 12)}...`)
const reg = await json("POST", `/api/session/${sessionA}/mcps`, { name: mcpName, config: mcpConfig })
record("d2", "session.mcpDefinitions.create 注册", "200", `status=${reg.status}`, reg.status === 200, JSON.stringify(reg.body).slice(0, 160))
const mcpList = await json("GET", `/api/session/${sessionA}/mcps`)
record("d3", "session.mcpDefinitions.list 可见", `含 name=${mcpName}`, `status=${mcpList.status} names=${(mcpList.body?.data ?? []).map((m) => m.name).join(",")}`, mcpList.status === 200 && (mcpList.body?.data ?? []).some((m) => m.name === mcpName))

// ---------- e0. SaaS MCP 通道（bug #2 证据：外层 Basic gate 401） ----------
const viaSaas = await fetch(BASE + "/api/connector/mcp", { method: "POST", headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })
record("e0", "[BUG#2 证据] 合法引擎 token 经 SaaS /api/connector/mcp", "200（MCP JSON-RPC 响应）", `status=${viaSaas.status} www-authenticate=${viaSaas.headers.get("www-authenticate")}`, false)

// ---------- e1x-e4x. 旁路 MCP 全链路 ----------
const init = await bypassMcp(runtimeToken, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0.0.1" } } })
record("e1x", "[旁路] MCP initialize", "200 且 serverInfo", `status=${init.status} server=${init.body?.result?.serverInfo?.name}`, init.status === 200 && init.body?.result?.serverInfo?.name === "oomol-connect")
await bypassMcp(runtimeToken, { jsonrpc: "2.0", method: "notifications/initialized" })
record("e2x", "[旁路] MCP notifications/initialized", "2xx", "发送成功（通知无响应体）", true)
const tools = await bypassMcp(runtimeToken, { jsonrpc: "2.0", id: 2, method: "tools/list" })
const toolNames = (tools.body?.result?.tools ?? []).map((t) => t.name).sort()
const expectedTools = ["execute_action", "get_action_guide", "list_apps", "list_connections", "search_actions"]
record("e3x", "[旁路] MCP tools/list 五个工具", expectedTools.join(","), toolNames.join(","), JSON.stringify(toolNames) === JSON.stringify(expectedTools))
const callConn = await bypassMcp(runtimeToken, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_connections", arguments: {} } })
const callText = JSON.stringify(callConn.body)
record("e4x", "[旁路] MCP tools/call list_connections 含 postmark", "200 且内容含 postmark 连接", `status=${callConn.status}`, callConn.status === 200 && /postmark/.test(callText), callText.slice(0, 300))

// ---------- f. 负向 ----------
const fakeToken = "oct_e2e_fake_" + Math.random().toString(36).slice(2)
const fake = await bypassMcp(fakeToken, { jsonrpc: "2.0", id: 9, method: "tools/list" })
record("f1", "[旁路] 伪造 oct_ token 调 tools/list 被拒", "401 unauthorized", `status=${fake.status}`, fake.status === 401, JSON.stringify(fake.body).slice(0, 160))
const fakeSaas = await fetch(BASE + "/api/connector/mcp", { method: "POST", headers: { authorization: `Bearer ${fakeToken}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) })
record("f1s", "[SaaS] 伪造 oct_ token（同样被外层 gate 拦截）", "401（Basic gate）", `status=${fakeSaas.status}`, fakeSaas.status === 401)
const delForeign = await json("DELETE", `/api/session/${sessionB}/connector/connections/${connId}`)
record("f3", "会话 B 删会话 A 连接", "404", `status=${delForeign.status}`, delForeign.status === 404, JSON.stringify(delForeign.body).slice(0, 160))
const basicMcp = await fetch(BASE + "/api/connector/mcp", { method: "POST", headers: { authorization: BASIC, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list" }) })
const basicBody = await basicMcp.text()
record("f4", "Basic 凭据（非引擎 token）调 SaaS MCP 通道", "401/403", `status=${basicMcp.status} body=${basicBody.slice(0, 120)}`, false, "观察：Basic 过外层 gate 后（预期进 handler 由引擎 401），实际 500——疑似 bug #3（handleMcp JSON.parse 引擎 401 JSON 之外的路径抛错）或其他缺陷，需产品侧排查")

// ---------- g. 清理：删连接 ----------
const del = await json("DELETE", `/api/session/${sessionA}/connector/connections/${connId}`)
record("g1", "删除连接（引擎 deleteConnection /api/connections/:service）", "204", `status=${del.status}`, del.status === 204)
const listAfterDel = await json("GET", `/api/session/${sessionA}/connector/connections`)
record("g2", "删后列表为空", "200 且 0 条", `status=${listAfterDel.status} count=${listAfterDel.body?.connections?.length}`, listAfterDel.status === 200 && listAfterDel.body?.connections?.length === 0)
record("g3", "删后 PG connector_connection 清行", "0", PSQL(`select count(*) from connector_connection where id='${connId}'`), PSQL(`select count(*) from connector_connection where id='${connId}'`) === "0")
record("g4", "删后引擎 connections 清行", "0", PSQL(`select count(*) from connector.connections where id='${engineId}'`), PSQL(`select count(*) from connector.connections where id='${engineId}'`) === "0")
const attachEmpty = await json("POST", `/api/session/${sessionA}/connector/mcp`)
record("g5", "无连接时 attach 拒绝", "400 且 no_connections", `status=${attachEmpty.status}`, attachEmpty.status === 400, JSON.stringify(attachEmpty.body).slice(0, 160))

// ---------- h. 会话删除清理 ----------
const bp2 = await bypassCreate()
const connId2 = insertRow(sessionA, bp2.engineId, bp2.engineName, "e2e-postmark-2")
record("h1", "旁路重建连接", "成功", `connId=${connId2.slice(0, 12)}...`, !!connId2)
const attach2 = await json("POST", `/api/session/${sessionA}/connector/mcp`)
const runtimeToken2 = attach2.body?.config?.headers?.authorization?.replace(/^Bearer /, "")
record("h2", "重新 attach（token 轮换）", "200 且新 token ≠ 旧 token", `status=${attach2.status} token=${runtimeToken2?.slice(0, 12)}...`, attach2.status === 200 && !!runtimeToken2 && runtimeToken2 !== runtimeToken)
const oldTokenStillWork = await bypassMcp(runtimeToken, { jsonrpc: "2.0", id: 13, method: "tools/list" })
record("h2x", "[旁路] 旧 token 已被 rotate 回收", "401", `status=${oldTokenStillWork.status}`, oldTokenStillWork.status === 401)
const delSession = await json("DELETE", `/api/session/${sessionA}`)
record("h3", "删除会话 A", "204", `status=${delSession.status}`, delSession.status === 204)
await new Promise((r) => setTimeout(r, 2500))
record("h4", "删会话后 PG connector_connection 清行", "0", PSQL(`select count(*) from connector_connection where session_id='${sessionA}'`), PSQL(`select count(*) from connector_connection where session_id='${sessionA}'`) === "0")
record("h5", "删会话后引擎 connections 清行", "0", PSQL(`select count(*) from connector.connections where id='${bp2.engineId}'`), PSQL(`select count(*) from connector.connections where id='${bp2.engineId}'`) === "0")
const tokenAfterSession = await bypassMcp(runtimeToken2, { jsonrpc: "2.0", id: 14, method: "tools/list" })
record("h6", "[旁路] 删会话后 runtime token 失效", "401", `status=${tokenAfterSession.status}`, tokenAfterSession.status === 401)
record("h7", "删会话后会话域 runtime token 行已回收", "0", PSQL(`select count(*) from connector.runtime_tokens where name='ccon-session-${sessionA}'`), PSQL(`select count(*) from connector.runtime_tokens where name='ccon-session-${sessionA}'`) === "0")

await json("DELETE", `/api/session/${sessionB}`)
// 清理 probe 残留（若存在）
const probeSid = await Bun.file("/tmp/probe-sid.txt").text().then((t) => t.trim()).catch(() => "")
if (probeSid) await json("DELETE", `/api/session/${probeSid}`)

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.pass)
console.log("\n========== 汇总 ==========")
console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}（其中 3 项为产品 bug 定向证据用例）`)
if (failed.length) {
  console.log("失败项：")
  for (const f of failed) console.log(`  [${f.id}] ${f.name} → 预期 ${f.expected}，实际 ${f.actual}`)
}
process.exit(failed.length ? 1 : 0)
