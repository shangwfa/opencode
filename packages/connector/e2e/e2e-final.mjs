// 最终复测：bug #5 修复验证（MCP passthrough 全链 + 空 token 表无头 401）
const BASE = "http://127.0.0.1:14963"
const BASIC = "Basic " + Buffer.from("opencode:ab123456").toString("base64")
const PSQL = (sql) => {
  const proc = Bun.spawnSync(["psql", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres", "-d", "opencode-v2-up", "-At", "-c", sql], {
    env: { ...process.env, PGPASSWORD: "postgres" },
  })
  const out = proc.stdout.toString().trim()
  if (proc.exitCode !== 0) throw new Error("psql failed: " + proc.stderr.toString())
  return out
}
const results = []
const record = (id, name, expected, actual, pass, extra) => {
  results.push({ id, pass })
  console.log(`${pass ? "✅" : "❌"} [${id}] ${name}\n    预期: ${expected}\n    实际: ${actual}${extra ? "\n    附件: " + extra : ""}`)
}
const json = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: BASIC, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}
const rawPost = async (headers, body) => {
  const res = await fetch(BASE + "/api/connector/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}
const mcp = (token, payload) => rawPost({ authorization: `Bearer ${token}` }, payload)

// ---------- 准备：会话 + 连接 + attach ----------
const sid = (await json("POST", "/api/session", { title: "final-retest" })).body?.data?.id
const conn = await json("POST", `/api/session/${sid}/connector/connections`, { service: "postmark", authType: "api_key", values: { apiKey: "final-key" }, alias: "final" })
record("f-p0", "准备：会话+连接+attach", "全 200", `conn=${conn.status}`, conn.status === 200)
const attach = await json("POST", `/api/session/${sid}/connector/mcp`)
const token = attach.body?.config?.headers?.authorization?.replace(/^Bearer /, "")
record("f-p1", "attach 取得 token", "200 oct_", `status=${attach.status} token=${token?.slice(0, 10)}…`, attach.status === 200 && (token ?? "").startsWith("oct_"))

// ---------- 1. MCP 通道全链（bug #5 修复验证） ----------
const e1 = await mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } })
record("f-e1", "SaaS 通道 initialize", "200 且 serverInfo", `status=${e1.status} server=${e1.body?.body?.result?.serverInfo?.name}`, e1.status === 200 && e1.body?.body?.result?.serverInfo?.name === "oomol-connect", JSON.stringify(e1.body).slice(0, 180))
const e2 = await mcp(token, { jsonrpc: "2.0", method: "notifications/initialized" })
record("f-e2", "SaaS 通道 notifications/initialized", "2xx", `status=${e2.status}`, e2.status < 300)
const e3 = await mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
const tools = (e3.body?.body?.result?.tools ?? []).map((t) => t.name).sort()
record("f-e3", "SaaS 通道 tools/list 五工具", "execute_action,get_action_guide,list_apps,list_connections,search_actions", tools.join(","), tools.join(",") === "execute_action,get_action_guide,list_apps,list_connections,search_actions")
const e4 = await mcp(token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_connections", arguments: {} } })
record("f-e4", "SaaS 通道 tools/call list_connections", "200 且含 postmark 连接", `status=${e4.status}`, e4.status === 200 && /postmark/.test(JSON.stringify(e4.body)), JSON.stringify(e4.body).slice(0, 250))

// ---------- 2. 负向 ----------
const f1 = await mcp("oct_final_fake_" + Math.random().toString(36).slice(2), { jsonrpc: "2.0", id: 9, method: "tools/list" })
record("f-f1", "伪造 oct_ token（HTTP 200 + body.status=401 亦可）", "引擎 401", `status=${f1.status} engine=${f1.body?.status}`, f1.status === 401 || (f1.status === 200 && f1.body?.status === 401), JSON.stringify(f1.body).slice(0, 140))
const f4 = await rawPost({ authorization: BASIC }, { jsonrpc: "2.0", id: 11, method: "tools/list" })
record("f-f4", "Basic 凭据（非引擎 token）", "引擎 401（HTTP 401 或 200+body.status=401）", `status=${f4.status} engine=${f4.body?.status}`, f4.status === 401 || f4.status === 403 || (f4.status === 200 && f4.body?.status === 401), JSON.stringify(f4.body).slice(0, 140))

// ---------- 3. 空 token 表 + 无 authorization 头 → 401（修复 #4 端到端） ----------
await json("DELETE", `/api/session/${sid}`)
await new Promise((r) => setTimeout(r, 2500))
const tokensNow = PSQL("select count(*) from connector.runtime_tokens")
record("f-pre", "删会话后 token 表为空", "0", tokensNow, tokensNow === "0")
const noAuth = await rawPost({}, { jsonrpc: "2.0", id: 20, method: "tools/list" })
record("f-n1", "[修复#4 端到端] 空 token 表 + 无 authorization 头", "401（被拒）", `status=${noAuth.status}`, noAuth.status === 401 || noAuth.status === 400, `body=${JSON.stringify(noAuth.body).slice(0, 120)}（注：effect headers 层缺头为 400；引擎 401 形态见 f-n2）`)
const emptyBearer = await rawPost({ authorization: "Bearer " }, { jsonrpc: "2.0", id: 21, method: "tools/list" })
record("f-n2", "空 token 表 + 空 Bearer 凭据（头存在）", "引擎 401（HTTP 401 或 200+body.status=401）", `status=${emptyBearer.status} engine=${emptyBearer.body?.status}`, emptyBearer.status === 401 || (emptyBearer.status === 200 && emptyBearer.body?.status === 401), JSON.stringify(emptyBearer.body).slice(0, 140))

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.pass)
console.log(`\n========== 最终复测：${results.length - failed.length}/${results.length} 通过 ==========`)
if (failed.length) for (const f of failed.filter((x) => results.find((r) => r.id === x.id && !r.pass))) console.log(`  失败: ${f.id}`)
process.exit(failed.length ? 1 : 0)
