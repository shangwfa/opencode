/**
 * 27-session-lsp.md 综合端到端测试
 * 覆盖 T27.1-T27.7.6 (daemon 端点) + T27.19-21 (防御) + PG/沙箱状态
 * 运行: node docs/test-cases/lsp-full-e2e-test.mjs
 */
const BASE = "http://localhost:14096"
const PORT = 20877

async function fetchJSON(url, opts = {}, timeoutMs = 60000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal })
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function exec(sid, command, timeoutMs = 60000) {
  const d = await fetchJSON(`${BASE}/session/${sid}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  }, timeoutMs)
  return { exitCode: d.exitCode, stdout: (d.stdout || "").trim(), stderr: (d.stderr || "").trim() }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function record(id, name, pass, detail = "") {
  const status = pass ? "✅" : "❌"
  const line = `${status} ${id} ${name}${detail ? " — " + detail : ""}`
  console.log(line)
  results.push({ id, name, pass, detail })
}

async function daemonReady(sid) {
  for (let i = 0; i < 30; i++) {
    await sleep(2000)
    const r = await exec(sid, `curl -s --max-time 2 http://localhost:${PORT}/lsp/status 2>/dev/null || echo NOT_READY`, 10000)
    if (!r.stdout.includes("NOT_READY") && r.stdout.includes("servers")) return true
  }
  return false
}

async function daemonCall(sid, endpoint, body, method = "POST") {
  const payload = JSON.stringify(body).replace(/'/g, "'\\''")
  const cmd = method === "GET"
    ? `curl -s --max-time 30 http://localhost:${PORT}${endpoint}`
    : `curl -s --max-time 30 -X POST http://localhost:${PORT}${endpoint} -H 'Content-Type: application/json' -d '${payload}'`
  const r = await exec(sid, cmd, 45000)
  try { return JSON.parse(r.stdout) } catch { return { raw: r.stdout, stderr: r.stderr } }
}

async function main() {
  console.log("═".repeat(65))
  console.log("27-session-lsp.md 综合端到端测试")
  console.log("═".repeat(65))

  // ── 创建 session + keepAlive ──
  const session = await fetchJSON(`${BASE}/session`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })
  const SID = session.id
  console.log(`Session: ${SID}`)
  await fetchJSON(`${BASE}/session/${SID}/keep-alive`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: '{"enabled":true}',
  })
  await sleep(5000)

  // ── 设置 TS 项目 ──
  console.log("\n── 设置 TS 项目 ──")
  await exec(SID, `git config --global user.email t@t.com && git config --global user.name T`)
  await exec(SID, `mkdir -p /workspace/ts-project && cd /workspace/ts-project`)
  await exec(SID, `cd /workspace/ts-project && printf '%s' '{"compilerOptions":{"strict":true,"target":"ES2020"},"include":["*.ts"]}' > tsconfig.json`)
  await exec(SID, `cd /workspace/ts-project && printf '%s\\n' 'const x: string = 123' > test.ts`)
  await exec(SID, `cd /workspace/ts-project && printf '%s\\n' 'function foo(a: number): string { return a }' >> test.ts`)
  await exec(SID, `cd /workspace/ts-project && printf '%s\\n' 'export { foo }' >> test.ts`)
  // iface.ts + impl.ts
  await exec(SID, `cd /workspace/ts-project && printf '%s\\n' 'export interface Greeter { greet(name: string): string }' > iface.ts`)
  await exec(SID, `cd /workspace/ts-project && printf '%s\\n' 'import { Greeter } from "./iface"' > impl.ts`)
  await exec(SID, `cd /workspace/ts-project && printf '%s\\n' 'export class HelloGreeter implements Greeter { greet(name: string) { return "Hello " + name } }' >> impl.ts`)
  // caller.ts
  await exec(SID, `cd /workspace/ts-project && printf '%s\\n' 'import { HelloGreeter } from "./impl"' > caller.ts`)
  await exec(SID, `cd /workspace/ts-project && printf '%s\\n' 'const g = new HelloGreeter()' >> caller.ts`)
  await exec(SID, `cd /workspace/ts-project && printf '%s\\n' 'export function run() { return g.greet("world") }' >> caller.ts`)
  // symbol.ts
  await exec(SID, `cd /workspace/ts-project && printf '%s\\n' 'const greeting: string = "hello"' > symbol.ts`)
  await exec(SID, `cd /workspace/ts-project && printf '%s\\n' 'function shout(s: string) { return s.toUpperCase() }' >> symbol.ts`)

  const WT = "/workspace/ts-project"

  // ── 启动 daemon ──
  console.log("── 启动 daemon ──")
  await exec(SID, `nohup env LSP_AGENT_PORT=${PORT} LSP_WORKSPACE_ROOT=${WT} node /opt/opencode-lsp-daemon/index.js > /tmp/daemon.log 2>&1 & echo $! > /tmp/daemon.pid`)
  const ready = await daemonReady(SID)
  if (!ready) {
    console.log("❌ daemon 启动失败，查看日志:")
    console.log((await exec(SID, "cat /tmp/daemon.log | tail -20")).stdout)
    process.exit(1)
  }
  console.log("daemon 就绪")

  // ════════════════════════════════════════════════
  // T27.1 Daemon 启动与状态查询
  // ════════════════════════════════════════════════
  console.log("\n── T27.1-T27.7.6 Daemon 端点测试 ──")
  const status0 = await daemonCall(SID, "/lsp/status", {}, "GET")
  // warmup 可能已启动 TS server，所以 servers 可能非空
  record("T27.1", "Daemon 启动与状态查询", !!status0.servers, JSON.stringify(status0).slice(0, 80))

  // T27.2 touch + TS server 启动
  const touch = await daemonCall(SID, "/lsp/touch", { path: `${WT}/test.ts` })
  await sleep(8000)
  const status1 = await daemonCall(SID, "/lsp/status", {}, "GET")
  const tsRunning = JSON.stringify(status1).includes('"typescript"') && JSON.stringify(status1).includes("running")
  record("T27.2", "TypeScript Server 自动启动", touch.version === 0 && tsRunning, `touch=${JSON.stringify(touch)} status=${JSON.stringify(status1).slice(0, 80)}`)

  // T27.3 类型错误诊断
  const diag = await daemonCall(SID, "/lsp/diagnostics", { path: `${WT}/test.ts`, wait: true })
  const diagStr = JSON.stringify(diag)
  const hasTypeError = diagStr.includes("not assignable") && diagStr.includes("2322")
  record("T27.3", "TypeScript 类型错误诊断", hasTypeError, diagStr.slice(0, 120))

  // T27.4 Hover
  const hover = await daemonCall(SID, "/lsp/hover", { path: `${WT}/test.ts`, line: 0, character: 6 })
  const hoverStr = JSON.stringify(hover)
  const hasHover = hoverStr.includes("const x: string")
  record("T27.4", "Hover 信息查询", hasHover, hoverStr.slice(0, 100))

  // T27.5 Go-to-Definition
  const def = await daemonCall(SID, "/lsp/definition", { path: `${WT}/test.ts`, line: 0, character: 6 })
  const defStr = JSON.stringify(def)
  const hasDef = defStr.includes("locations") && (defStr.includes("test.ts") || defStr.includes("0"))
  record("T27.5", "Go-to-Definition", hasDef, defStr.slice(0, 100))

  // T27.6 Find References
  const refs = await daemonCall(SID, "/lsp/references", { path: `${WT}/test.ts`, line: 1, character: 16 })
  record("T27.6", "Find References", Array.isArray(refs.locations), JSON.stringify(refs).slice(0, 80))

  // T27.7.1 Go-to-Implementation
  await daemonCall(SID, "/lsp/touch", { path: `${WT}/iface.ts` })
  await daemonCall(SID, "/lsp/touch", { path: `${WT}/impl.ts` })
  await sleep(5000)
  const impl = await daemonCall(SID, "/lsp/implementation", { path: `${WT}/iface.ts`, line: 0, character: 17 })
  const implStr = JSON.stringify(impl)
  const hasImpl = implStr.includes("impl.ts") || implStr.includes("HelloGreeter")
  record("T27.7.1", "Go-to-Implementation", hasImpl, implStr.slice(0, 100))

  // T27.7.2 Document Symbol
  const sym = await daemonCall(SID, "/lsp/documentSymbol", { path: `${WT}/impl.ts` })
  const symStr = JSON.stringify(sym)
  const hasSym = symStr.includes("HelloGreeter") || symStr.includes("greet")
  record("T27.7.2", "Document Symbol", hasSym, symStr.slice(0, 100))

  // T27.7.3 Workspace Symbol
  const wsym = await daemonCall(SID, "/lsp/workspaceSymbol", { query: "Greeter" })
  const wsymStr = JSON.stringify(wsym)
  const hasWsym = wsymStr.includes("Greeter")
  record("T27.7.3", "Workspace Symbol", hasWsym, wsymStr.slice(0, 100))

  // T27.7.4 Prepare Call Hierarchy
  const prep = await daemonCall(SID, "/lsp/prepareCallHierarchy", { path: `${WT}/impl.ts`, line: 1, character: 47 })
  const prepStr = JSON.stringify(prep)
  const hasPrep = prepStr.includes("greet") || (Array.isArray(prep.items) && prep.items.length > 0)
  record("T27.7.4", "Prepare Call Hierarchy", hasPrep, prepStr.slice(0, 100))

  // T27.7.5 Incoming Calls
  await daemonCall(SID, "/lsp/touch", { path: `${WT}/caller.ts` })
  await sleep(5000)
  const incoming = await daemonCall(SID, "/lsp/incomingCalls", { path: `${WT}/impl.ts`, line: 1, character: 47 })
  const incomingStr = JSON.stringify(incoming)
  const hasIncoming = incomingStr.includes("run") || incomingStr.includes("caller")
  record("T27.7.5", "Incoming Calls", hasIncoming, incomingStr.slice(0, 100))

  // T27.7.6 Outgoing Calls
  const outgoing = await daemonCall(SID, "/lsp/outgoingCalls", { path: `${WT}/caller.ts`, line: 2, character: 16 })
  const outgoingStr = JSON.stringify(outgoing)
  const hasOutgoing = outgoingStr.includes("greet")
  record("T27.7.6", "Outgoing Calls", hasOutgoing, outgoingStr.slice(0, 100))

  // ════════════════════════════════════════════════
  // T27.19-21 防御逻辑（新 daemon bundle）
  // ════════════════════════════════════════════════
  console.log("\n── T27.19-21 防御逻辑（新 bundle）──")

  // T27.19 路径越界
  const boundary1 = await daemonCall(SID, "/lsp/touch", { path: "../../../etc/passwd" })
  const boundary2 = await daemonCall(SID, "/lsp/touch", { path: "/etc/shadow" })
  const b1Rejected = JSON.stringify(boundary1).includes("outside workspace")
  const b2Rejected = JSON.stringify(boundary2).includes("outside workspace")
  record("T27.19", "路径越界拒绝", b1Rejected && b2Rejected, `../../../etc/passwd→${JSON.stringify(boundary1).slice(0, 50)} /etc/shadow→${JSON.stringify(boundary2).slice(0, 50)}`)

  // T27.20 请求体过大（通过 exec 发 2MB）
  const bigResult = await exec(SID,
    `head -c 2097152 /dev/urandom | base64 -w0 > /tmp/big.json && printf '{"path":"' > /tmp/p.json && cat /tmp/big.json >> /tmp/p.json && printf '"}' >> /tmp/p.json && curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:${PORT}/lsp/touch -H 'Content-Type: application/json' --data-binary @/tmp/p.json`,
    30000)
  record("T27.20", "请求体大小限制", bigResult.stdout === "413", `HTTP ${bigResult.stdout}`)

  // T27.21 非法 JSON
  const badJson = await exec(SID,
    `curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:${PORT}/lsp/touch -H 'Content-Type: application/json' -d 'not a json'`,
    10000)
  const badJsonBody = await exec(SID,
    `curl -s -X POST http://localhost:${PORT}/lsp/touch -H 'Content-Type: application/json' -d 'not a json'`,
    10000)
  const is400 = badJson.stdout === "400"
  const hasInvalidJson = badJsonBody.stdout.includes("invalid JSON")
  record("T27.21", "非法 JSON 返回 400", is400 && hasInvalidJson, `HTTP=${badJson.stdout} body=${badJsonBody.stdout.slice(0, 50)}`)

  // ════════════════════════════════════════════════
  // PG 数据 + 沙箱状态
  // ════════════════════════════════════════════════
  console.log("\n── PG 数据 + 沙箱状态 ──")

  // PG via SaaS container's DATABASE_URL
  const pgResult = await exec(SID,
    `echo "SELECT id, pvc_mode, app_id, directory FROM session ORDER BY time_created DESC LIMIT 5;" | PGPASSWORD=\${PGPASSWORD:-opencode} psql -h \${PGHOST:-localhost} -U \${PGUSER:-opencode} -d \${PGDATABASE:-opencode} -t 2>&1 || echo PG_NOT_AVAILABLE`,
    10000)

  // sandbox table
  const sbResult = await exec(SID,
    `echo "SELECT session_id, state, keep_alive FROM sandbox ORDER BY time_updated DESC LIMIT 5;" | PGPASSWORD=\${PGPASSWORD:-opencode} psql -h \${PGHOST:-localhost} -U \${PGUSER:-opencode} -d \${PGDATABASE:-opencode} -t 2>&1 || echo PG_NOT_AVAILABLE`,
    10000)

  console.log("PG session 表（最近 5 条）:")
  console.log(pgResult.stdout.split("\n").map(l => "  " + l).join("\n"))
  console.log("\nPG sandbox 表（最近 5 条）:")
  console.log(sbResult.stdout.split("\n").map(l => "  " + l).join("\n"))

  // 沙箱容器状态
  console.log("\n沙箱容器状态:")
  const dockerPs = await exec(SID, `docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null || echo NO_DOCKER`, 10000)

  // ── daemon stderr 验证（T27.x 新增）──
  console.log("\n── stderr pipe 验证 ──")
  const daemonLog = await exec(SID, "cat /tmp/daemon.log | grep -c '\\[tsserver\\]' || echo 0", 10000)
  const hasStderr = daemonLog.stdout.trim() !== "0"
  record("stderr", "tsserver stderr 已 pipe 到 daemon 日志", hasStderr, `${daemonLog.stdout.trim()} 行 [tsserver] 日志`)

  // ── shutdown ──
  console.log("\n── T27.7 Daemon 优雅关闭 ──")
  const shutdownRes = await daemonCall(SID, "/lsp/shutdown", {})
  await sleep(2000)
  const afterShutdown = await exec(SID, `curl -s --max-time 2 http://localhost:${PORT}/lsp/status 2>&1 || echo SHUTDOWN_OK`, 10000)
  const isDown = afterShutdown.stdout.includes("SHUTDOWN_OK") || afterShutdown.stdout.includes("refused")
  record("T27.7", "Daemon 优雅关闭", shutdownRes.ok === true && isDown, `shutdown=${JSON.stringify(shutdownRes)} after=${afterShutdown.stdout.slice(0, 50)}`)

  // ════════════════════════════════════════════════
  // 汇总
  // ════════════════════════════════════════════════
  const passed = results.filter((r) => r.pass).length
  const failed = results.filter((r) => !r.pass).length
  console.log("\n" + "═".repeat(65))
  console.log(`结果: ${passed} 通过, ${failed} 失败, 共 ${results.length} 项`)
  if (failed > 0) {
    console.log("\n失败项:")
    results.filter((r) => !r.pass).forEach((r) => console.log(`  ❌ ${r.id} ${r.name} — ${r.detail}`))
  }
  console.log("═".repeat(65))

  // 清理
  await fetch(`${BASE}/session/${SID}/kill-sandbox`, { method: "POST" }).catch(() => {})
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1) })
