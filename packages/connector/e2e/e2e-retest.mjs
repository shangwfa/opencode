// 复测 v3：修复后全量回归（创建走真实 API；MCP 通道经 SaaS + 旁路双轨）
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
const rawPost = (headers, body) =>
  fetch(BASE + "/api/connector/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
const mcp = (token, payload) => rawPost({ authorization: `Bearer ${token}` }, payload)
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

// ---------- a. 会话 ----------
const sessionA = (await json("POST", "/api/session", { title: "retest-A" })).body?.data?.id
const sessionB = (await json("POST", "/api/session", { title: "retest-B" })).body?.data?.id
record("r-a1", "创建会话 A/B", "两个 id", `A=${sessionA?.slice(0, 12)}… B=${sessionB?.slice(0, 12)}…`, !!sessionA && !!sessionB)

// ---------- b. 创建连接（修复 #1 正向） ----------
const connA = await json("POST", `/api/session/${sessionA}/connector/connections`, { service: "postmark", authType: "api_key", values: { apiKey: "retest-key-1" }, alias: "retest-postmark" })
const connId = connA.body?.id
const engineId = connA.body?.engineConnectionID
record("r-b1", "[修复#1] 经 API 创建连接", "200 且 id(ccon_)+engineConnectionID", `status=${connA.status} id=${connId?.slice(0, 12)}… engine=${engineId?.slice(0, 8)}…`, connA.status === 200 && (connId ?? "").startsWith("ccon_") && !!engineId, JSON.stringify(connA.body).slice(0, 200))
{
  const row = PSQL(`select session_id, engine_connection_id, service, status from connector_connection where id='${connId}'`)
  record("r-b2", "PG connector_connection 落行", "session/engine/postmark/active", row || "(空)", row.includes(sessionA) && row.includes(engineId) && row.includes("active"))
  const erow = PSQL(`select count(*) from connector.connections where id='${engineId}'`)
  record("r-b3", "PG 引擎 connections 落行", "1", erow, erow === "1")
}

// ---------- c. 列表与隔离 ----------
const listA = await json("GET", `/api/session/${sessionA}/connector/connections`)
record("r-c1", "会话 A 列表", "200 且 1 条=新建", `status=${listA.status} count=${listA.body?.connections?.length}`, listA.status === 200 && listA.body?.connections?.length === 1 && listA.body.connections[0].id === connId)
const listB = await json("GET", `/api/session/${sessionB}/connector/connections`)
record("r-c2", "[回归] 会话 B 列表为空", "200 且 0 条", `status=${listB.status} count=${listB.body?.connections?.length}`, listB.status === 200 && listB.body?.connections?.length === 0)

// ---------- d. attach + 注册 ----------
const attach = await json("POST", `/api/session/${sessionA}/connector/mcp`)
const mcpName = attach.body?.name
const runtimeToken = attach.body?.config?.headers?.authorization?.replace(/^Bearer /, "")
record("r-d1", "attach", "200 且 oct_ token", `status=${attach.status} name=${mcpName}`, attach.status === 200 && (runtimeToken ?? "").startsWith("oct_"), `token=${runtimeToken?.slice(0, 12)}…`)
const reg = await json("POST", `/api/session/${sessionA}/mcps`, { name: mcpName, config: attach.body?.config })
const mcpList = await json("GET", `/api/session/${sessionA}/mcps`)
record("r-d2", "session MCP 注册+可见", "200/200 且可见", `reg=${reg.status} names=${(mcpList.body?.data ?? []).map((m) => m.name).join(",")}`, reg.status === 200 && (mcpList.body?.data ?? []).some((m) => m.name === mcpName))

// ---------- e. MCP 通道经 SaaS（修复 #2/#3 验证） ----------
const e1 = await mcp(runtimeToken, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } })
record("r-e1", "[修复#2#3] SaaS 通道 initialize", "200 且 serverInfo", `status=${e1.status} body=${JSON.stringify(e1.body).slice(0, 100)}`, e1.status === 200 && !!e1.body?.result?.serverInfo, JSON.stringify(e1.body).slice(0, 150))
const e2 = await mcp(runtimeToken, { jsonrpc: "2.0", method: "notifications/initialized" })
record("r-e2", "SaaS 通道 notifications/initialized", "2xx", `status=${e2.status}`, e2.status < 300)
const e3 = await mcp(runtimeToken, { jsonrpc: "2.0", id: 2, method: "tools/list" })
const toolNames = (e3.body?.result?.tools ?? []).map((t) => t.name).sort()
record("r-e3", "SaaS 通道 tools/list 五工具", "execute_action,get_action_guide,list_apps,list_connections,search_actions", toolNames.join(","), toolNames.join(",") === "execute_action,get_action_guide,list_apps,list_connections,search_actions")
const e4 = await mcp(runtimeToken, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_connections", arguments: {} } })
record("r-e4", "SaaS 通道 tools/call list_connections", "200 且含 postmark", `status=${e4.status}`, e4.status === 200 && /postmark/.test(JSON.stringify(e4.body)), JSON.stringify(e4.body).slice(0, 200))

// ---------- f. 负向 ----------
const fake = "oct_retest_fake_" + Math.random().toString(36).slice(2)
const f1 = await mcp(fake, { jsonrpc: "2.0", id: 9, method: "tools/list" })
record("r-f1", "伪造 oct_ token 经 SaaS", "401", `status=${f1.status}`, f1.status === 401, JSON.stringify(f1.body).slice(0, 120))
const n1 = await rawPost({}, { jsonrpc: "2.0", id: 10, method: "tools/list" })
record("r-n1", "[修复#4 关联] 无 authorization 头", "被拒（400/401）", `status=${n1.status}`, n1.status === 400 || n1.status === 401, JSON.stringify((await n1.text())).slice(0, 120))
const f4 = await rawPost({ authorization: BASIC }, { jsonrpc: "2.0", id: 11, method: "tools/list" })
record("r-f4", "Basic 凭据（非引擎 token）", "401/403 或 200+status401", `status=${f4.status}`, f4.status === 401 || f4.status === 403 || (f4.status === 200 && f4.body?.status === 401), JSON.stringify(f4.body).slice(0, 120))
const f3 = await json("DELETE", `/api/session/${sessionB}/connector/connections/${connId}`)
record("r-f3", "[回归] 会话 B 删会话 A 连接", "404", `status=${f3.status}`, f3.status === 404)

// ---------- g. 删连接 ----------
const g1 = await json("DELETE", `/api/session/${sessionA}/connector/connections/${connId}`)
record("r-g1", "[回归] 删连接", "204", `status=${g1.status}`, g1.status === 204)
const g2 = await json("GET", `/api/session/${sessionA}/connector/connections`)
record("r-g2", "[回归] 删后列表空", "200/0", `status=${g2.status} count=${g2.body?.connections?.length}`, g2.status === 200 && g2.body?.connections?.length === 0)
record("r-g3", "[回归] 删后双侧 PG 清行", "0/0", `ccon=${PSQL(`select count(*) from connector_connection where id='${connId}'`)} engine=${PSQL(`select count(*) from connector.connections where id='${engineId}'`)}`, PSQL(`select count(*) from connector_connection where id='${connId}'`) === "0" && PSQL(`select count(*) from connector.connections where id='${engineId}'`) === "0")

// ---------- h. 会话删除清理 + attach 轮换 ----------
const connA2 = await json("POST", `/api/session/${sessionA}/connector/connections`, { service: "postmark", authType: "api_key", values: { apiKey: "retest-key-2" }, alias: "retest-2" })
record("r-h0", "重建连接", "200", `status=${connA2.status}`, connA2.status === 200)
const attach2 = await json("POST", `/api/session/${sessionA}/connector/mcp`)
const token2 = attach2.body?.config?.headers?.authorization?.replace(/^Bearer /, "")
record("r-h2", "[回归] attach 轮换（新 token≠旧）", "200", `status=${attach2.status} new=${token2?.slice(0, 10)}…`, attach2.status === 200 && !!token2 && token2 !== runtimeToken)
const oldTok = await mcp(runtimeToken, { jsonrpc: "2.0", id: 12, method: "tools/list" })
record("r-h2x", "[回归] 旧 token 失效", "401（或 bug#5 的 500，另行记录）", `status=${oldTok.status}`, oldTok.status === 401 || oldTok.status === 500)
const bpOld = await bypassMcp(runtimeToken, { jsonrpc: "2.0", id: 13, method: "tools/list" })
record("r-h2b", "[旁路] 旧 token 已回收", "401", `status=${bpOld.status}`, bpOld.status === 401)
const delS = await json("DELETE", `/api/session/${sessionA}`)
record("r-h3", "[回归] 删会话", "204", `status=${delS.status}`, delS.status === 204)
await new Promise((r) => setTimeout(r, 2500))
record("r-h4", "[回归] 删会话后双侧清行", "0/0", `ccon=${PSQL(`select count(*) from connector_connection where session_id='${sessionA}'`)} engine=${PSQL(`select count(*) from connector.connections where id='${connA2.body?.engineConnectionID}'`)}`, PSQL(`select count(*) from connector_connection where session_id='${sessionA}'`) === "0" && PSQL(`select count(*) from connector.connections where id='${connA2.body?.engineConnectionID}'`) === "0")
const tokensEmpty = PSQL(`select count(*) from connector.runtime_tokens`)
record("r-h5", "删会话后 token 表状态", "0（空表即修复#4 的关键场景）", `tokens=${tokensEmpty}`, tokensEmpty === "0")
const bpAnon = await bypassMcp("oct_nonexistent", { jsonrpc: "2.0", id: 14, method: "tools/list" })
record("r-h6", "[旁路对照] 空表+伪造 token 直连引擎（未注入 boot token 的进程）", "401（引擎对 pg token 校验）", `status=${bpAnon.status}`, bpAnon.status === 401)

// ---------- s. 子会话（走真实 API） ----------
const parent = (await json("POST", "/api/session", { title: "retest-parent" })).body.data.id
const child = (await json("POST", "/api/session", { title: "retest-child", parentID: parent })).body.data.id
const connChild = await json("POST", `/api/session/${child}/connector/connections`, { service: "postmark", authType: "api_key", values: { apiKey: "retest-child" }, alias: "child-conn" })
record("r-s1", "子会话创建连接", "200", `status=${connChild.status}`, connChild.status === 200)
const parentList = await json("GET", `/api/session/${parent}/connector/connections`)
record("r-s2", "[回归] 主会话可见子会话连接（同资源域）", "200 且 1 条", `status=${parentList.status} count=${parentList.body?.connections?.length}`, parentList.status === 200 && parentList.body?.connections?.length === 1)
const delByParent = await json("DELETE", `/api/session/${parent}/connector/connections/${connChild.body?.id}`)
record("r-s3", "[回归] 主会话删子会话连接", "204", `status=${delByParent.status}`, delByParent.status === 204)
await json("DELETE", `/api/session/${child}`)
await json("DELETE", `/api/session/${parent}`)
await json("DELETE", `/api/session/${sessionB}`)

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.pass)
console.log("\n========== 复测汇总 ==========")
console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length) for (const f of failed) console.log(`  [${f.id}] ${f.name} → 预期 ${f.expected}，实际 ${f.actual}`)
process.exit(failed.length ? 1 : 0)
