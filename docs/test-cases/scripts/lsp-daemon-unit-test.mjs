#!/usr/bin/env node
// 路径 A — LSP daemon 单元测试（宿主机直跑 daemon bundle + HTTP 验证）
//
// 验证容器内 LSP daemon 的全部 13 个端点，无需 SaaS 栈或 OpenSandbox。
// 已于 2026-06-13 在 macOS (ARM) + Node v22 实测全绿（含崩溃修复回归）。
//
// 用法：
//   cd packages/opencode && bun run build:daemon   # 先构建 daemon bundle
//   node docs/test-cases/scripts/lsp-daemon-unit-test.mjs
//
// 依赖：宿主机能 npm install typescript（脚本会在临时项目内安装 TS 7.x）。

import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execSync } from "node:child_process"

const PORT = Number(process.env.LSP_AGENT_PORT ?? 20877)
const BASE = `http://localhost:${PORT}`
const REPO = resolve(import.meta.dirname, "../../../packages/opencode")
const DAEMON = join(REPO, "docker/opt/opencode-lsp-daemon/index.js")

let pass = 0
let fail = 0
const results = []
function check(name, ok, detail = "") {
  results.push({ name, ok, detail })
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`)
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return r.json()
}
async function get(path) {
  return (await fetch(BASE + path)).json()
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1. 准备测试项目 ──
const dir = mkdtempSync(join(tmpdir(), "lsp-unit-"))
mkdirSync(join(dir, "src"))
writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2020" }, include: ["**/*.ts"] }))
writeFileSync(join(dir, "src/test.ts"), "const x: string = 123\nfunction foo(a: number): string { return a }\nexport { foo }\n")
writeFileSync(join(dir, "src/iface.ts"), "export interface Greeter { greet(name: string): string }\n")
writeFileSync(join(dir, "src/impl.ts"), 'import { Greeter } from "./iface"\nexport class HelloGreeter implements Greeter {\n  greet(name: string) { return `Hello ${name}` }\n}\n')
writeFileSync(join(dir, "src/caller.ts"), 'import { HelloGreeter } from "./impl"\nconst g = new HelloGreeter()\nexport function run() { return g.greet("world") }\n')
console.log(`测试项目: ${dir}`)

console.log("安装 typescript ...")
execSync("npm init -y >/dev/null 2>&1 && npm install --no-save typescript >/dev/null 2>&1", { cwd: dir })

// ── 2. 启动 daemon（LSP_WORKSPACE_ROOT 覆盖默认 /workspace 以便本地测试）──
const daemon = spawn("node", [DAEMON], {
  env: { ...process.env, LSP_AGENT_PORT: String(PORT), LSP_WORKSPACE_ROOT: dir, PATH: `${join(dir, "node_modules/.bin")}:${process.env.PATH}` },
  stdio: ["ignore", "pipe", "pipe"],
})
daemon.stdout.on("data", () => {})
daemon.stderr.on("data", () => {})

async function cleanup() {
  daemon.kill()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
process.on("exit", cleanup)

try {
  await sleep(3000)

  // ── T27.1 status（daemon 检测到 tsconfig.json 会预热 TS server）──
  console.log("\n[T27.1] Daemon 启动与状态查询")
  const s1 = await get("/lsp/status")
  check("status 返回有效服务器列表", Array.isArray(s1.servers) && s1.servers.length >= 0, JSON.stringify(s1))

  // ── T27.2 touch → TS server 自动启动 ──
  console.log("\n[T27.2] TypeScript Server 自动启动")
  const t = await post("/lsp/touch", { path: join(dir, "src/test.ts") })
  check("touch 返回 version", t.version === 0, JSON.stringify(t))
  await sleep(9000)
  const s2 = await get("/lsp/status")
  check("status 显示 typescript running", s2.servers?.[0]?.id === "typescript" && s2.servers?.[0]?.status === "running", JSON.stringify(s2))

  // ── T27.3 diagnostics ──
  console.log("\n[T27.3] TypeScript 类型错误诊断")
  const d = await post("/lsp/diagnostics", { path: join(dir, "src/test.ts"), wait: true })
  const allDiags = Object.values(d.diagnostics ?? {}).flat()
  const ts2322 = allDiags.filter((x) => x.code === 2322)
  check("检测到 TS2322 类型错误", ts2322.length >= 1, `共 ${allDiags.length} 条诊断, TS2322 ×${ts2322.length}`)

  // ── T27.4 hover ──
  console.log("\n[T27.4] Hover 信息查询")
  const h = await post("/lsp/hover", { path: join(dir, "src/test.ts"), line: 0, character: 6 })
  const hoverStr = JSON.stringify(h.contents ?? "")
  check("hover 返回 const x: string", hoverStr.includes("const x: string"), hoverStr.slice(0, 80))

  // ── T27.5 definition ──
  console.log("\n[T27.5] Go-to-Definition")
  const def = await post("/lsp/definition", { path: join(dir, "src/test.ts"), line: 0, character: 6 })
  check("definition 返回 1 个位置", def.locations?.length === 1, JSON.stringify(def.locations?.[0]?.range?.start))

  // ── T27.6 references ──
  console.log("\n[T27.6] Find References")
  const ref = await post("/lsp/references", { path: join(dir, "src/test.ts"), line: 1, character: 9 })
  check("references 返回数组", Array.isArray(ref.locations), `${ref.locations?.length ?? 0} refs`)

  // touch 接口/实现/调用方文件让 LSP 索引
  for (const f of ["iface.ts", "impl.ts", "caller.ts"]) await post("/lsp/touch", { path: join(dir, "src", f) })
  await sleep(4000)

  // ── T27.7.1 implementation ──
  console.log("\n[T27.7.1] Go-to-Implementation")
  const impl = await post("/lsp/implementation", { path: join(dir, "src/iface.ts"), line: 0, character: 17 })
  check("implementation 找到 HelloGreeter", (impl.locations ?? []).some((l) => l.uri.includes("impl.ts")), `${impl.locations?.length ?? 0} 个实现`)

  // ── T27.7.2 documentSymbol ──
  console.log("\n[T27.7.2] Document Symbol")
  const ds = await post("/lsp/documentSymbol", { path: join(dir, "src/impl.ts") })
  const names = (ds.symbols ?? []).map((x) => x.name)
  check("documentSymbol 含 HelloGreeter", names.includes("HelloGreeter"), names.join(", "))

  // ── T27.7.3 workspaceSymbol ──
  console.log("\n[T27.7.3] Workspace Symbol")
  const ws = await post("/lsp/workspaceSymbol", { query: "Greeter" })
  const wsNames = (ws.symbols ?? []).map((x) => x.name)
  check("workspaceSymbol 含 Greeter", wsNames.includes("Greeter"), wsNames.join(", "))

  // ── T27.7.4 prepareCallHierarchy ──
  console.log("\n[T27.7.4] Prepare Call Hierarchy")
  const pch = await post("/lsp/prepareCallHierarchy", { path: join(dir, "src/impl.ts"), line: 2, character: 2 })
  check("prepareCallHierarchy 返回 greet item", (pch.items ?? []).some((i) => i.name === "greet"), `${pch.items?.length ?? 0} items`)

  // ── T27.7.5 incomingCalls ──
  console.log("\n[T27.7.5] Incoming Calls")
  const ic = await post("/lsp/incomingCalls", { path: join(dir, "src/impl.ts"), line: 2, character: 2 })
  check("incomingCalls: run 调用 greet", (ic.calls ?? []).some((c) => c.from?.name === "run"), `${ic.calls?.length ?? 0} calls`)

  // ── T27.7.6 outgoingCalls ──
  console.log("\n[T27.7.6] Outgoing Calls")
  const oc = await post("/lsp/outgoingCalls", { path: join(dir, "src/caller.ts"), line: 2, character: 16 })
  check("outgoingCalls: run 调用 greet", (oc.calls ?? []).some((c) => c.to?.name === "greet"), `${oc.calls?.length ?? 0} calls`)

  // ── T27.7 shutdown ──
  console.log("\n[T27.7] Daemon 优雅关闭")
  await post("/lsp/shutdown", {})
  await sleep(1000)
  let refused = false
  try { await get("/lsp/status") } catch { refused = true }
  check("shutdown 后连接被拒绝", refused, refused ? "connection refused" : "still responding")
} catch (err) {
  console.error("\n测试异常:", err.message)
  fail++
} finally {
  await cleanup()
}

console.log(`\n${"─".repeat(50)}`)
console.log(`结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
