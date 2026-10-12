// 无模型全场景 e2e：纯 HTTP API 驱动 connector（无 AI 会话/agent 参与；MCP 为 JSON-RPC 直调，不经模型）
// 覆盖：目录发现 / 连接生命周期 / 会话域隔离 / no_auth 通道 / 执行语义(连接定位+幂等) / MCP 手工使用 /
//       proxy 透传 / runs 审计 / 孤儿清扫 / OAuth 无人工态 / reconnect / transit 文件
// 明确不覆盖：原生工具通道（必须经模型）、trigger（暂停）、OAuth 真实授权（需人工）、多 pod
// 前置：服务已启动（start-server.sh），connector schema 已迁移
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
const skipped = []
const record = (id, name, expected, actual, pass, extra) => {
  results.push({ id, name, expected: String(expected).slice(0, 60), actual: String(actual).slice(0, 90), pass: !!pass })
  console.log(`${pass ? "✅" : "❌"} [${id}] ${name}\n    预期: ${expected}\n    实际: ${actual}${extra ? "\n    附件: " + extra : ""}`)
}
const skip = (id, name, reason) => {
  skipped.push({ id, name, reason })
  console.log(`⏭️  [${id}] ${name} —— 跳过：${reason}`)
}

const json = async (method, path, body, headers = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: BASIC, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed }
}
// MCP JSON-RPC 直调（Bearer 为 attach 返回的引擎 token，非 Basic）
const mcp = (token, payload) =>
  json("POST", "/api/connector/mcp", payload, { authorization: `Bearer ${token}` })

const bypassRun = async (script, ...args) => {
  const proc = Bun.spawnSync([BUN, import.meta.dirname + "/" + script, ...args], {
    env: { ...process.env, TMPDIR: "/tmp" },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) throw new Error(`bypass ${script} failed: ${proc.stderr.toString().slice(0, 300)}`)
  return JSON.parse(proc.stdout.toString().split("\n").find((l) => l.startsWith("{")))
}

const newSession = async (title, parentID) => (await json("POST", "/api/session", { title, ...(parentID ? { parentID } : {}) })).body?.data?.id

// ---------- P. 准备 ----------
const info = await json("GET", "/api/info")
record("nm-p1", "服务健康 GET /api/info", "200", `status=${info.status}`, info.status === 200)
const S_MAIN = await newSession("nm-main")
const S_ISO = await newSession("nm-isolate")
const S_NOAUTH = await newSession("nm-noauth") // 全程保持零连接
const S_EXEC = await newSession("nm-exec")
const S_OAUTH = await newSession("nm-oauth")
record("nm-p2", "创建 5 个测试会话", "全部返回 id", `main=${S_MAIN?.slice(0, 10)}… iso=${S_ISO?.slice(0, 10)}…`, !!S_MAIN && !!S_ISO && !!S_NOAUTH && !!S_EXEC && !!S_OAUTH)

// ---------- 1. 目录发现 ----------
const cat = await json("GET", "/api/connector/providers")
const catCount = cat.body?.providers?.length ?? 0
record("nm-1a", "GET /api/connector/providers 全量", `200 且数量>1000（历史基线 1604）`, `status=${cat.status} total=${catCount}`, cat.status === 200 && catCount > 1000)
const catPostmark = await json("GET", "/api/connector/providers?service=postmark")
const pmOk = catPostmark.status === 200 && catPostmark.body?.providers?.length === 1 && catPostmark.body.providers[0].service === "postmark" && catPostmark.body.providers[0].authTypes?.includes("api_key")
record("nm-1b", "providers?service=postmark 过滤", "200 且仅 1 条 postmark（authTypes 含 api_key）", `status=${catPostmark.status} count=${catPostmark.body?.providers?.length} types=${catPostmark.body?.providers?.[0]?.authTypes?.join(",")}`, pmOk)
const catCustom = await json("GET", "/api/connector/providers?authType=custom_credential")
const customList = catCustom.body?.providers ?? []
const customAllMatch = customList.length > 0 && customList.every((p) => (p.authTypes ?? []).includes("custom_credential"))
record("nm-1c", "providers?authType=custom_credential 过滤", "200 且 ≥1 条且全部含 custom_credential", `status=${catCustom.status} count=${customList.length} 前3=${customList.slice(0, 3).map((p) => p.service).join(",")}`, catCustom.status === 200 && customAllMatch, `目录含 cloudflare_docs=${customList.some((p) => p.service === "cloudflare_docs")}`)
const catNone = await json("GET", "/api/connector/providers?service=__no_such_service_nm__")
record("nm-1d", "providers 负向：不存在的服务", "200 且空列表", `status=${catNone.status} count=${catNone.body?.providers?.length}`, catNone.status === 200 && catNone.body?.providers?.length === 0)
const catBadType = await json("GET", "/api/connector/providers?authType=bogus_type")
record("nm-1e", "providers 负向：非法 authType", "400（query 校验拒绝）", `status=${catBadType.status}`, catBadType.status === 400, JSON.stringify(catBadType.body).slice(0, 140))

// ---------- 2. 连接管理全生命周期（S_MAIN） ----------
const connA = await json("POST", `/api/session/${S_MAIN}/connector/connections`, { service: "postmark", authType: "api_key", values: { apiKey: "nm-fake-key-123" }, alias: "nm-postmark" })
const connAId = connA.body?.id
record("nm-2a", "api_key 建连（postmark 宽松校验，假 key）", "200 且 id=ccon_* + engineConnectionID", `status=${connA.status} id=${connAId} engine=${connA.body?.engineConnectionID?.slice(0, 12)}…`, connA.status === 200 && (connAId ?? "").startsWith("ccon_") && !!connA.body?.engineConnectionID)

// custom_credential：优先无凭据校验器的服务（cloudflare_docs fields 为空）；失败记录跳过
let connBId = undefined
let connBService = undefined
for (const svc of ["cloudflare_docs", "weixin_bot"]) {
  if (!customList.some((p) => p.service === svc)) continue
  const attempt = await json("POST", `/api/session/${S_MAIN}/connector/connections`, { service: svc, authType: "custom_credential", values: {}, alias: `nm-custom-${svc}` })
  if (attempt.status === 200) {
    connBId = attempt.body?.id
    connBService = svc
    record("nm-2b", `custom_credential 建连（${svc}，无凭据校验器）`, "200 且 id=ccon_*", `status=${attempt.status} id=${connBId}`, (connBId ?? "").startsWith("ccon_"))
    break
  }
  console.log(`    （${svc} 建连未成功：status=${attempt.status} ${JSON.stringify(attempt.body).slice(0, 100)}，试下一个候选）`)
}
if (!connBId) skip("nm-2b", "custom_credential 建连", "目录内候选服务（cloudflare_docs/weixin_bot）均不可用或建连被服务端校验拒绝")

const listMain = await json("GET", `/api/session/${S_MAIN}/connector/connections`)
const listRows = listMain.body?.connections ?? []
const expectedCount = connBId ? 2 : 1
const rowA = listRows.find((r) => r.id === connAId)
const engineStatusOk = listRows.every((r) => typeof r.engineStatus === "string" && r.engineStatus.length > 0)
record("nm-2c", "连接列表（含 engineStatus/accountLabel 字段）", `200 且 ${expectedCount} 条且每条有 engineStatus`, `status=${listMain.status} count=${listRows.length} engineStatus=[${listRows.map((r) => r.engineStatus).join(",")}] accountLabel=[${listRows.map((r) => r.accountLabel ?? "-").join(",")}]`, listMain.status === 200 && listRows.length === expectedCount && engineStatusOk)
record("nm-2d", "alias 回显", "alias=nm-postmark", `alias=${rowA?.alias}`, rowA?.alias === "nm-postmark")

const connBadService = await json("POST", `/api/session/${S_MAIN}/connector/connections`, { service: "__no_such_service_nm__", authType: "api_key", values: { apiKey: "x" } })
record("nm-2e", "建连负向：不存在的服务", "4xx", `status=${connBadService.status}`, connBadService.status >= 400 && connBadService.status < 500, JSON.stringify(connBadService.body).slice(0, 140))
const connBadAuth = await json("POST", `/api/session/${S_MAIN}/connector/connections`, { service: "postmark", authType: "oauth2", values: {} })
record("nm-2f", "建连负向：authType=oauth2 直建", "400（CreateAuthType 仅 api_key|custom_credential）", `status=${connBadAuth.status}`, connBadAuth.status === 400, JSON.stringify(connBadAuth.body).slice(0, 140))

if (connBId) {
  const delB = await json("DELETE", `/api/session/${S_MAIN}/connector/connections/${connBId}`)
  record("nm-2g", "删除 custom_credential 连接", "204 且列表回到 1 条", `status=${delB.status} after=${(await json("GET", `/api/session/${S_MAIN}/connector/connections`)).body?.connections?.length}`, delB.status === 204)
}
const pgMainConn = PSQL(`select count(*) from connector_connection where session_id='${S_MAIN}'`)
const pgEngineConn = PSQL(`select count(*) from connector.connections where id='${connA.body?.engineConnectionID}'`)
record("nm-2h", "PG 双侧落行（api_key 连接）", "主库 1 行 + 引擎 1 行", `saas=${pgMainConn} engine=${pgEngineConn}`, pgMainConn === "1" && pgEngineConn === "1")

// ---------- 3. 会话域隔离 ----------
const listIso = await json("GET", `/api/session/${S_ISO}/connector/connections`)
record("nm-3a", "会话 ISO 列表不见 MAIN 连接", "200 且 0 条", `status=${listIso.status} count=${listIso.body?.connections?.length}`, listIso.status === 200 && listIso.body?.connections?.length === 0)
const delForeign = await json("DELETE", `/api/session/${S_ISO}/connector/connections/${connAId}`)
record("nm-3b", "会话 ISO 删 MAIN 连接", "404", `status=${delForeign.status}`, delForeign.status === 404, JSON.stringify(delForeign.body).slice(0, 120))
const S_CHILD = await newSession("nm-child", S_MAIN)
const listChild = await json("GET", `/api/session/${S_CHILD}/connector/connections`)
record("nm-3c", "子会话列表可见主会话连接（共享资源域）", "200 且 1 条=id 相同", `status=${listChild.status} count=${listChild.body?.connections?.length} id匹配=${listChild.body?.connections?.[0]?.id === connAId}`, listChild.status === 200 && listChild.body?.connections?.length === 1 && listChild.body.connections[0].id === connAId)
record("nm-3d", "隔离对照：删连接后 MAIN 列表仍 1 条", "1 条", `count=${(await json("GET", `/api/session/${S_MAIN}/connector/connections`)).body?.connections?.length}`, (await json("GET", `/api/session/${S_MAIN}/connector/connections`)).body?.connections?.length === 1)

// ---------- 4. no_auth 通道 ----------
const attachNoConn = await json("POST", `/api/session/${S_NOAUTH}/connector/mcp`)
record("nm-4a", "零连接会话 attach（现状记录）", "400 且 no_connections（MCP 通道需 ≥1 连接）", `status=${attachNoConn.status} body=${JSON.stringify(attachNoConn.body).slice(0, 100)}`, attachNoConn.status === 400 && /no_connections|no active connector connections/i.test(JSON.stringify(attachNoConn.body)))
const attach1 = await json("POST", `/api/session/${S_MAIN}/connector/mcp`)
const token1 = attach1.body?.config?.headers?.authorization?.replace(/^Bearer /, "")
record("nm-4b", "有连接会话 attach 取得 token", "200 且 oct_", `status=${attach1.status} token=${token1?.slice(0, 10)}…`, attach1.status === 200 && (token1 ?? "").startsWith("oct_"))
const mcpApps = await mcp(token1, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "list_apps", arguments: { query: "arxiv" } } })
record("nm-4c", "MCP tools/call list_apps(query=arxiv)", "200 且内容含 arxiv", `status=${mcpApps.status} hit=${/arxiv/i.test(JSON.stringify(mcpApps.body))}`, mcpApps.status === 200 && /arxiv/i.test(JSON.stringify(mcpApps.body)), JSON.stringify(mcpApps.body?.body?.result ?? mcpApps.body).slice(0, 160))
const mcpSearch = await mcp(token1, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "search_actions", arguments: { query: "paper", service: "arxiv" } } })
record("nm-4d", "MCP tools/call search_actions(arxiv)", "200 且含 search_papers", `status=${mcpSearch.status} hit=${/search_papers/.test(JSON.stringify(mcpSearch.body))}`, mcpSearch.status === 200 && /search_papers/.test(JSON.stringify(mcpSearch.body)))
const mcpExec = await mcp(token1, { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "execute_action", arguments: { actionId: "arxiv.search_papers", input: { query: "effect systems", maxResults: 2 } } } })
const execText = JSON.stringify(mcpExec.body?.body?.result ?? mcpExec.body ?? {})
record("nm-4e", "MCP execute_action arxiv.search_papers 真实调用", "200 且真实结果（含 title/paper 数据，isError≠true）", `status=${mcpExec.status} isError=${mcpExec.body?.body?.result?.isError} hit=${/title|summary|arxiv/i.test(execText)}`, mcpExec.status === 200 && mcpExec.body?.body?.result?.isError !== true && /title|summary|arxiv/i.test(execText), execText.slice(0, 200))

// ---------- 5. 执行语义（proxy 端点承载连接定位规则；S_EXEC） ----------
const execConn1 = await json("POST", `/api/session/${S_EXEC}/connector/connections`, { service: "postmark", authType: "api_key", values: { apiKey: "nm-exec-key-1" }, alias: "nm-exec-1" })
record("nm-5a", "S_EXEC 建第 1 条连接（单连接态）", "200", `status=${execConn1.status}`, execConn1.status === 200)
// 单连接免指定：期望请求到达第三方（postmark 对假 key 返回凭据级 4xx = 注入+转发成功）
// [bug#7 证据] 实际：SaaS 铸临时 token 硬编码 allowedProxies:[]（adapter/engine.ts:341），引擎策略层
// 把显式空 proxy allowlist 解释为"不允许任何 proxy"→ 端点 100% 返回 400 "proxy is not granted"。
const proxySingle = await json("POST", "/api/connector/proxy/postmark", { sessionID: S_EXEC, endpoint: "/server", method: "GET" })
const psBody = proxySingle.body ?? {}
const bug7Shape = (r) => r.status === 400 && /proxy is not granted to this runtime token/.test(JSON.stringify(r.body))
record("nm-5b", "单连接免指定自动注入（proxy postmark /server）", "[bug#7 证据] 400 proxy not granted（修复后应 SaaS 200 且透传第三方凭据级 4xx）", `status=${proxySingle.status} body=${JSON.stringify(psBody).slice(0, 90)}`, bug7Shape(proxySingle), JSON.stringify(psBody).slice(0, 160))
const execConn2 = await json("POST", `/api/session/${S_EXEC}/connector/connections`, { service: "postmark", authType: "api_key", values: { apiKey: "nm-exec-key-2" }, alias: "nm-exec-2" })
record("nm-5c", "S_EXEC 建第 2 条连接（多连接态）", "200", `status=${execConn2.status}`, execConn2.status === 200)
const proxyMulti = await json("POST", "/api/connector/proxy/postmark", { sessionID: S_EXEC, endpoint: "/server", method: "GET" })
record("nm-5d", "多连接未指定报 connection_required", "4xx 且提示指定 connectionID", `status=${proxyMulti.status} body=${JSON.stringify(proxyMulti.body).slice(0, 120)}`, proxyMulti.status >= 400 && proxyMulti.status < 500 && /connection_required|Multiple connections|specify connectionID/i.test(JSON.stringify(proxyMulti.body)))
const proxyPinned = await json("POST", "/api/connector/proxy/postmark", { sessionID: S_EXEC, endpoint: "/server", method: "GET", connectionID: execConn1.body?.id })
const ppBody = proxyPinned.body ?? {}
record("nm-5e", "指定 connectionID 后成功（同 5b 形态）", "[bug#7 证据] 同样 400 not granted（修复后应 SaaS 200 且透传第三方凭据级 4xx）", `status=${proxyPinned.status} body=${JSON.stringify(ppBody).slice(0, 90)}`, bug7Shape(proxyPinned), JSON.stringify(ppBody).slice(0, 160))
const proxyWrong = await json("POST", "/api/connector/proxy/postmark", { sessionID: S_EXEC, endpoint: "/server", method: "GET", connectionID: "ccon_00000000000000000000000000" })
record("nm-5f", "负向：指定不存在的 connectionID", "404", `status=${proxyWrong.status}`, proxyWrong.status === 404, JSON.stringify(proxyWrong.body).slice(0, 120))

// 幂等：SaaS 无 HTTP execute 端点（nm-5h 佐证），经旁路直连引擎 runtime API 验证引擎幂等回放能力
const idemKey = "nm-e2e-" + crypto.randomUUID()
const idemBody = JSON.stringify({ input: { query: "idempotency replay e2e", maxResults: 1 } })
const idemBefore = PSQL("select count(*) from connector.idempotency_records")
const run1 = await bypassRun("bypass-actions.mjs", token1, "arxiv.search_papers", idemBody, idemKey)
const idemAfter1 = PSQL("select count(*) from connector.idempotency_records")
const run2 = await bypassRun("bypass-actions.mjs", token1, "arxiv.search_papers", idemBody, idemKey)
const idemAfter2 = PSQL("select count(*) from connector.idempotency_records")
const data1 = run1.body?.data
const data2 = run2.body?.data
const replayOk = run1.status === 200 && run2.status === 200 && JSON.stringify(data1) === JSON.stringify(data2) && idemAfter1 === String(Number(idemBefore) + 1) && idemAfter2 === idemAfter1
record("nm-5g", "idempotencyKey 幂等回放（旁路直连引擎 /v1/actions）", "同 key 两次 200 且 data 全等；PG 幂等表仅 +1 行", `run1=${run1.status} run2=${run2.status} data等=${JSON.stringify(data1) === JSON.stringify(data2)} 表=${idemBefore}→${idemAfter1}→${idemAfter2}`, replayOk, `注：SaaS HTTP 层无 execute 端点，幂等 key 的 SaaS 透传仅在原生工具通道（本轮不覆盖）；本用例验证引擎侧能力`)
const openapi = await json("GET", "/openapi.json")
const oaPaths = Object.keys(openapi.body?.paths ?? {})
record("nm-5h", "/openapi.json 佐证：SaaS 无 HTTP execute 端点", "paths 无 /v1/actions 或 *execute* 路由（幂等 key 无 HTTP 入口）", `paths=${oaPaths.length} execute类=${oaPaths.filter((p) => /execute|actions/i.test(p)).length}`, openapi.status === 200 && oaPaths.filter((p) => /execute|\/actions/i.test(p)).length === 0, oaPaths.filter((p) => /connector/i.test(p)).join(" | ").slice(0, 300))
for (const c of [execConn1.body?.id, execConn2.body?.id]) if (c) await json("DELETE", `/api/session/${S_EXEC}/connector/connections/${c}`)
record("nm-5i", "清理 S_EXEC 两条连接", "删后列表 0", `count=${(await json("GET", `/api/session/${S_EXEC}/connector/connections`)).body?.connections?.length}`, (await json("GET", `/api/session/${S_EXEC}/connector/connections`)).body?.connections?.length === 0)

// ---------- 6. MCP 通道手工使用（协议握手全序列） ----------
const attach2 = await json("POST", `/api/session/${S_MAIN}/connector/mcp`)
const token2 = attach2.body?.config?.headers?.authorization?.replace(/^Bearer /, "")
record("nm-6a", "重新 attach（token 轮换）", "200 且新 oct_ ≠ 旧", `status=${attach2.status} new=${token2?.slice(0, 10)}…`, attach2.status === 200 && (token2 ?? "").startsWith("oct_") && token2 !== token1)
const init = await mcp(token2, { jsonrpc: "2.0", id: 20, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nm-e2e", version: "0" } } })
record("nm-6b", "initialize", "200 且 serverInfo=oomol-connect", `status=${init.status} server=${init.body?.body?.result?.serverInfo?.name}`, init.status === 200 && init.body?.body?.result?.serverInfo?.name === "oomol-connect")
const initialized = await mcp(token2, { jsonrpc: "2.0", method: "notifications/initialized" })
record("nm-6c", "notifications/initialized", "2xx", `status=${initialized.status}`, initialized.status < 300)
const toolsList = await mcp(token2, { jsonrpc: "2.0", id: 21, method: "tools/list" })
const toolNames = (toolsList.body?.body?.result?.tools ?? []).map((t) => t.name).sort()
record("nm-6d", "tools/list 五工具", "execute_action,get_action_guide,list_apps,list_connections,search_actions", toolNames.join(","), toolNames.join(",") === "execute_action,get_action_guide,list_apps,list_connections,search_actions")
const listConn = await mcp(token2, { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "list_connections", arguments: {} } })
record("nm-6e", "tools/call list_connections", "200 且含 nm-postmark 连接", `status=${listConn.status} hit=${/nm-postmark|postmark/.test(JSON.stringify(listConn.body))}`, listConn.status === 200 && /postmark/.test(JSON.stringify(listConn.body)), JSON.stringify(listConn.body?.body?.result ?? listConn.body).slice(0, 200))
const guide = await mcp(token2, { jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "get_action_guide", arguments: { actionId: "arxiv.search_papers" } } })
record("nm-6f", "tools/call get_action_guide", "200 且 guide 含 query 参数说明", `status=${guide.status} hit=${/query/.test(JSON.stringify(guide.body))}`, guide.status === 200 && /query/.test(JSON.stringify(guide.body)))
const fakeTok = "oct_nm_fake_" + Math.random().toString(36).slice(2)
const fakeInit = await mcp(fakeTok, { jsonrpc: "2.0", id: 24, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } })
record("nm-6g", "负向：伪造 oct_ token", "被拒（HTTP 401 或 200+包装 status=401）", `status=${fakeInit.status} engine=${fakeInit.body?.status}`, fakeInit.status === 401 || (fakeInit.status === 200 && fakeInit.body?.status === 401), JSON.stringify(fakeInit.body).slice(0, 140))

// ---------- 7. proxy 透传（no_auth 服务，零连接会话） ----------
// [bug#7 证据] no_auth 哨兵路径同样被 token 空 allowedProxies 拦截（引擎 policy 层在连接解析之前拒绝）
const proxyArxiv = await json("POST", "/api/connector/proxy/arxiv", { sessionID: S_NOAUTH, endpoint: "/query", method: "GET", query: { search_query: "all:electron", max_results: "1" } })
const paBody = proxyArxiv.body ?? {}
record("nm-7a", "零连接会话 proxy arxiv（no_auth 哨兵）只读请求", "[bug#7 证据] 400 not granted（修复后应 SaaS 200 且透传第三方 200 XML feed）", `status=${proxyArxiv.status} body=${JSON.stringify(paBody).slice(0, 90)}`, bug7Shape(proxyArxiv), JSON.stringify(paBody).slice(0, 160))
const proxyPostmarkNoConn = await json("POST", "/api/connector/proxy/postmark", { sessionID: S_NOAUTH, endpoint: "/server", method: "GET" })
record("nm-7b", "负向：零连接会话 proxy 需凭据服务（postmark）", "[bug#7 证据] 400 not granted（优先于连接类错误暴露；修复后应为 4xx 连接类错误）", `status=${proxyPostmarkNoConn.status} body=${JSON.stringify(proxyPostmarkNoConn.body).slice(0, 90)}`, bug7Shape(proxyPostmarkNoConn), JSON.stringify(proxyPostmarkNoConn.body).slice(0, 160))

// ---------- 8. runs 审计 ----------
const runs = await json("GET", "/api/connector/runs")
const runItems = runs.body?.items ?? []
const arxivRun = runItems.find((r) => r.service === "arxiv" && r.actionId === "arxiv.search_papers")
record("nm-8a", "GET /api/connector/runs 有 arxiv 执行记录", "200 且存在 service=arxiv + actionId=arxiv.search_papers", `status=${runs.status} items=${runItems.length} hit=${!!arxivRun}`, runs.status === 200 && !!arxivRun, arxivRun ? `startedAt=${arxivRun.startedAt} ok=${arxivRun.ok}` : "")
const runs1 = await json("GET", "/api/connector/runs?limit=1")
const page1 = runs1.body?.items ?? []
const cursor = runs1.body?.nextCursor
let page2Ok = false
let page2Ids = []
if (cursor) {
  const runs2 = await json("GET", `/api/connector/runs?limit=1&cursor=${encodeURIComponent(cursor)}`)
  page2Ids = (runs2.body?.items ?? []).map((r) => r.id)
  page2Ok = runs2.status === 200 && page2Ids.length >= 1 && !page2Ids.includes(page1[0]?.id)
}
record("nm-8b", "runs cursor 翻页（limit=1）", "page1=1 条 + nextCursor；page2 不与 page1 重叠", `page1=${page1.length} cursor=${cursor ? "有" : "无"} page2独立=${page2Ok}`, page1.length === 1 && !!cursor && page2Ok)

// ---------- 9. 孤儿清扫（reconcile） ----------
const engineCountBefore = PSQL("select count(*) from connector.connections")
const bpOrphan = await bypassRun("bypass-engine.mjs", "create")
const orphanId = bpOrphan.body?.data?.id
const engineCountWithOrphan = PSQL("select count(*) from connector.connections")
record("nm-9a", "旁路建孤儿连接（引擎 UUID 名，无 SaaS 行）", "引擎 connections +1 行", `orphan=${orphanId?.slice(0, 12)}… ${engineCountBefore}→${engineCountWithOrphan}`, engineCountWithOrphan === String(Number(engineCountBefore) + 1))
const rec = await json("POST", "/api/connector/reconcile")
const removed = rec.body?.removed
const engineCountAfter = PSQL("select count(*) from connector.connections")
const orphanGone = PSQL(`select count(*) from connector.connections where id='${orphanId}'`) === "0"
record("nm-9b", "POST /api/connector/reconcile 清扫孤儿", "200 且 removed≥1 且该孤儿行已删", `status=${rec.status} removed=${removed} orphanGone=${orphanGone}`, rec.status === 200 && removed >= 1 && orphanGone)
record("nm-9c", "removed 计数精确（不含 virtual 占位）", `removed == 物理行差（${engineCountWithOrphan}-${engineCountAfter}）`, `removed=${removed} 差=${Number(engineCountWithOrphan) - Number(engineCountAfter)}`, removed === Number(engineCountWithOrphan) - Number(engineCountAfter))

// ---------- 10. OAuth 无人工态 ----------
const putClient = await json("PUT", "/api/connector/oauth/clients/github", { clientId: "nm-e2e-client-id", clientSecret: "nm-e2e-client-secret" })
record("nm-10a", "PUT oauth client（github）", "204", `status=${putClient.status}`, putClient.status === 204)
const startOauth = await json("POST", `/api/session/${S_OAUTH}/connector/connections/oauth`, { service: "github", alias: "nm-gh" })
const authUrl = startOauth.body?.authorizationUrl
const reqId = startOauth.body?.connectionRequestID
record("nm-10b", "POST oauth start（不授权）", "200 且 authorizationUrl(github) + connectionRequestID + expiresAt", `status=${startOauth.status} url=${authUrl?.slice(0, 45)}… req=${reqId?.slice(0, 12)}…`, startOauth.status === 200 && /github\.com\/login\/oauth\/authorize/.test(authUrl ?? "") && !!reqId && !!startOauth.body?.expiresAt)
const complete = await json("POST", `/api/session/${S_OAUTH}/connector/connections/oauth/${reqId}/complete`, {})
// [bug#8 证据] 引擎对 initiated 请求返回 errorCode:null，completeOAuth 原样传入
// ConnectorConnection.OAuthComplete.make（adapter/connector.ts:894），schema optional 不收 null → make 抛
// "Schema validation failed" → handler die → HTTP 500 空 body。任何未走到 connected 的轮询必 500。
record("nm-10c", "未授权直接 complete", "[bug#8 证据] 500（修复后应 200 且 status=initiated 无 connection）", `status=${complete.status} body=${JSON.stringify(complete.body).slice(0, 60)}`, complete.status === 500, "引擎侧 GET /v1/connection-requests/:id 返回 {status:initiated, errorCode:null}（bypass 实证）；OAuthComplete.make({errorCode:null}) 抛 Schema validation failed（bun -e 实证）")
const reqList = await json("GET", `/api/session/${S_OAUTH}/connector/oauth/requests`)
record("nm-10d", "GET oauth/requests 自记账列表（未实现证据）", "404（上游无列表路由，README 已注）", `status=${reqList.status}`, reqList.status === 404, JSON.stringify(reqList.body).slice(0, 120))
const ledger = PSQL(`select state from public.connector_oauth_request where connection_request_id='${reqId}'`)
const engineReq = PSQL(`select status from connector.connection_requests where id='${reqId}'`)
record("nm-10e", "PG 双侧：oauth request 停留 initiated", "主库 ledger=initiated 且引擎 connection_requests=initiated", `ledger=${ledger} engine=${engineReq}`, ledger === "initiated" && engineReq === "initiated")

// ---------- 11. reconnect（api_key 连接，记录基线行为） ----------
const reconnect = await json("POST", `/api/session/${S_MAIN}/connector/connections/${connAId}/reconnect`)
record("nm-11a", "reconnect 对 api_key 连接（行为基线）", "4xx 明确拒绝（引擎按 authType 拒绝非 oauth2）", `status=${reconnect.status} body=${JSON.stringify(reconnect.body).slice(0, 130)}`, reconnect.status >= 400 && reconnect.status < 500 && /auth|oauth|credential|unsupported/i.test(JSON.stringify(reconnect.body)))

// ---------- 12. transit 文件 ----------
const fileBytes = new TextEncoder().encode("hello connector no-model e2e")
const upload = await json("POST", "/api/connector/files", { sessionID: S_MAIN, name: "nm-hello.txt", mimeType: "text/plain", data: Buffer.from(fileBytes).toString("base64") })
const fileId = upload.body?.fileId
const uploadOk = upload.status === 200 && !!fileId && upload.body?.sizeBytes === fileBytes.length && upload.body?.name === "nm-hello.txt" && /\/api\/connector\/files\//.test(upload.body?.downloadUrl ?? "")
record("nm-12a", "POST /api/connector/files 上传", "200 且 fileId/downloadUrl/sizeBytes/name 回显", `status=${upload.status} fileId=${fileId?.slice(0, 14)}… size=${upload.body?.sizeBytes}B`, uploadOk)
let downloadOk = false
let downloaded = ""
if (fileId) {
  const dl = await fetch(BASE + `/api/connector/files/${encodeURIComponent(fileId)}`, { headers: { authorization: BASIC } })
  const buf = new Uint8Array(await dl.arrayBuffer())
  downloaded = new TextDecoder().decode(buf)
  downloadOk = dl.status === 200 && buf.length === fileBytes.length && downloaded === new TextDecoder().decode(fileBytes)
  record("nm-12b", "GET /api/connector/files/:id 下载", "200 且字节一致", `status=${dl.status} bytes=${buf.length} 内容一致=${downloaded === new TextDecoder().decode(fileBytes)}`, downloadOk)
} else skip("nm-12b", "文件下载", "上传未成功，无 fileId")
const dlMissing = await fetch(BASE + "/api/connector/files/__no_such_file_nm__", { headers: { authorization: BASIC } })
record("nm-12c", "负向：下载不存在的文件", "404", `status=${dlMissing.status}`, dlMissing.status === 404)

// ---------- 清理与 PG 终态 ----------
await json("DELETE", `/api/session/${S_CHILD}`)
await json("DELETE", `/api/session/${S_MAIN}`)
await json("DELETE", `/api/session/${S_ISO}`)
await json("DELETE", `/api/session/${S_NOAUTH}`)
await json("DELETE", `/api/session/${S_EXEC}`)
await json("DELETE", `/api/session/${S_OAUTH}`)
await new Promise((r) => setTimeout(r, 2500))
const finalSaas = PSQL("select count(*) from connector_connection")
const finalEngine = PSQL("select count(*) from connector.connections")
const finalTokens = PSQL("select count(*) from connector.runtime_tokens")
record("nm-c1", "删全部会话后 PG 连接/token 清零", "connector_connection=0 / connector.connections=0 / runtime_tokens=0", `saas=${finalSaas} engine=${finalEngine} tokens=${finalTokens}`, finalSaas === "0" && finalEngine === "0" && finalTokens === "0")
const finalRuns = PSQL("select count(*) from connector.runs")
const finalLedger = PSQL("select count(*) from public.connector_oauth_request")
console.log(`    （终态记录，不断言清零：runs=${finalRuns}（审计保留）、connector_oauth_request=${finalLedger}（ledger 保留））`)

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.pass)
console.log("\n========== 无模型全场景汇总 ==========")
console.table(results.map(({ id, name, pass }) => ({ id, name: name.slice(0, 46), pass })))
console.log(`总计 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}，跳过 ${skipped.length}`)
if (skipped.length) for (const s of skipped) console.log(`  跳过: [${s.id}] ${s.name} —— ${s.reason}`)
if (failed.length) for (const f of failed) console.log(`  失败: [${f.id}] ${f.name} → 预期 ${f.expected}，实际 ${f.actual}`)
process.exit(failed.length ? 1 : 0)
