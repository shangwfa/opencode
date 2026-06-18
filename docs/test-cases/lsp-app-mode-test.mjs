#!/usr/bin/env node
/**
 * T27.23–T27.27 app 模式 LSP 端到端测试（exec + 手动 daemon 方式）
 *
 * 验证 app 模式下 daemon 能正确处理 worktree 内的文件路径、
 * 项目根检测、降级场景与多 session 隔离。
 *
 * 运行：node docs/test-cases/lsp-app-mode-test.mjs
 * 前提：SaaS (14096) + OpenSandbox (8080) + PVC 已配置
 */
const BASE = "http://localhost:14096"

async function exec(sid, command, timeoutMs = 30000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}/session/${sid}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
      signal: ctrl.signal,
    })
    const data = await res.json()
    return {
      exitCode: data.exitCode,
      stdout: (data.stdout || "").trim(),
      stderr: (data.stderr || "").trim(),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function createSession(opts = {}) {
  const res = await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  })
  return await res.json()
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// 在容器内启动 daemon 并等待就绪
async function startDaemon(sid) {
  // 后台启动 daemon
  await exec(
    sid,
    `nohup env LSP_AGENT_PORT=20877 node /opt/opencode-lsp-daemon/index.js > /tmp/daemon.log 2>&1 & echo $! > /tmp/daemon.pid`,
  )
  // 等待 daemon 就绪（轮询 /lsp/status）
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    const r = await exec(sid, `curl -s --max-time 2 http://localhost:20877/lsp/status 2>/dev/null || echo NOT_READY`)
    if (!r.stdout.includes("NOT_READY") && r.stdout.includes("servers")) {
      return true
    }
  }
  return false
}

// 通过容器内 curl 调 daemon 端点
async function daemonCall(sid, endpoint, body) {
  const r = await exec(
    sid,
    `curl -s --max-time 30 -X POST http://localhost:20877${endpoint} -H 'Content-Type: application/json' -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`,
  )
  try {
    return JSON.parse(r.stdout)
  } catch {
    return { error: r.stdout || r.stderr }
  }
}

let passed = 0
let failed = 0
function check(name, ok, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`)
  if (ok) passed++
  else failed++
}

async function main() {
  console.log("=".repeat(60))
  console.log("T27.23–T27.27 app 模式 LSP 端到端测试")
  console.log("=".repeat(60))

  // ─── T27.23: app 模式 write 触发诊断（worktree 路径）───
  console.log("\n── T27.23 app 模式 worktree 路径正确性 ──")
  const sid23 = (await createSession({ pvcMode: "app", appId: "lsp-t23-" + Date.now() })).id
  if (!sid23) {
    check("T27.23 创建 app session", false)
    return
  }
  await sleep(3000)
  // 初始化 repo + worktree
  await exec(
    sid23,
    `git config --global user.email t@t.com && git config --global user.name T && mkdir -p /workspace/repo && cd /workspace/repo && git init && echo x > R.md && git add . && git commit -m init`,
  )
  // 触发 worktree 创建
  await exec(sid23, `echo trigger`)
  await sleep(3000)
  const wtCheck = await exec(sid23, `ls -d /workspace/worktrees/*/ 2>/dev/null | head -1`)
  const wtDir = wtCheck.stdout.replace(/\/$/, "")
  check("T27.23 worktree 已创建", !!wtDir, `wt=${wtDir}`)

  if (wtDir) {
    // 启动 daemon
    const daemonReady = await startDaemon(sid23)
    check("T27.23 daemon 就绪", daemonReady)

    if (daemonReady) {
      // 在 worktree 写入含错误的 TS 文件
      await exec(sid23, `echo 'const y: number = "not a number"' > ${wtDir}/broken.ts`)
      // touch + diagnostics
      const touch = await daemonCall(sid23, "/lsp/touch", { path: `${wtDir}/broken.ts` })
      await sleep(5) // 等 LSP server 分析
      const diag = await daemonCall(sid23, "/lsp/diagnostics", { path: `${wtDir}/broken.ts`, wait: true })
      const diagStr = JSON.stringify(diag)
      const hasError = diagStr.includes("not assignable") || diagStr.includes("2322")
      check("T27.23 worktree 文件诊断返回", hasError, diagStr.slice(0, 120))
    }
  }

  // ─── T27.24: worktree 下 tsconfig 项目根检测 ──
  console.log("\n── T27.24 app 模式项目根检测（worktree tsconfig） ──")
  if (wtDir) {
    // 在 worktree 放 strict tsconfig
    await exec(sid23, `printf '%s' '{"compilerOptions":{"strict":true,"noImplicitAny":true}}' > ${wtDir}/tsconfig.json`)
    // 写入触发 noImplicitAny 的文件（依赖 tsconfig strict 配置）
    await exec(sid23, `echo 'function f(x) { return x }' > ${wtDir}/implicit.ts`)
    const touch = await daemonCall(sid23, "/lsp/touch", { path: `${wtDir}/implicit.ts` })
    await sleep(5)
    const diag = await daemonCall(sid23, "/lsp/diagnostics", { path: `${wtDir}/implicit.ts`, wait: true })
    const diagStr = JSON.stringify(diag)
    // noImplicitAny (TS7006) 只有 strict 配置才触发，证明读到了 worktree 的 tsconfig
    const hasImplicit = diagStr.includes("implicitly has an 'any'") || diagStr.includes("7006")
    check("T27.24 worktree tsconfig 生效（noImplicitAny）", hasImplicit, diagStr.slice(0, 120))
  }

  // ─── T27.25: daemon 路径不泄露（worktree 路径格式正确）───
  console.log("\n── T27.25 app 模式路径格式 ──")
  if (wtDir) {
    await exec(sid23, `echo 'const greeting: string = "hello"' > ${wtDir}/symbol.ts`)
    const touch = await daemonCall(sid23, "/lsp/touch", { path: `${wtDir}/symbol.ts` })
    await sleep(5)
    const hover = await daemonCall(sid23, "/lsp/hover", { path: `${wtDir}/symbol.ts`, line: 0, character: 6 })
    const hoverStr = JSON.stringify(hover)
    const hasType = hoverStr.includes("const greeting: string")
    // daemon 返回的 uri 应是 file:///workspace/worktrees/...（不含宿主路径）
    const noHostLeak = !hoverStr.includes("/Users/") && !hoverStr.includes("/home/ruomu")
    check("T27.25 hover 返回类型信息", hasType, hoverStr.slice(0, 100))
    check("T27.25 无宿主路径泄露", noHostLeak)
  }

  // ─── T27.26: app 模式 repo 不存在时降级 ──
  console.log("\n── T27.26 app 模式 repo 不存在降级 ──")
  const sid26 = (await createSession({ pvcMode: "app", appId: "lsp-t26-" + Date.now() })).id
  await sleep(3000)
  const noWt = await exec(sid26, `ls -d /workspace/worktrees/*/ 2>/dev/null | wc -l`)
  check("T27.26 无 worktree（repo 不存在）", noWt.stdout.trim() === "0", `count=${noWt.stdout.trim()}`)

  const daemonReady26 = await startDaemon(sid26)
  if (daemonReady26) {
    // 文件直接写在 /workspace（降级行为）
    await exec(sid26, `echo 'const z: number = "bad"' > /workspace/fallback.ts`)
    const touch = await daemonCall(sid26, "/lsp/touch", { path: "/workspace/fallback.ts" })
    await sleep(5)
    const diag = await daemonCall(sid26, "/lsp/diagnostics", { path: "/workspace/fallback.ts", wait: true })
    const diagStr = JSON.stringify(diag)
    const hasError = diagStr.includes("not assignable") || diagStr.includes("2322")
    check("T27.26 降级后 LSP 仍工作（/workspace 根）", hasError, diagStr.slice(0, 100))
  }

  // ─── T27.27: session/app 模式 daemon 隔离 ──
  console.log("\n── T27.27 session/app 模式隔离 ──")
  const sidS = (await createSession({ pvcMode: "session" })).id
  await sleep(3000)
  const daemonReadyS = await startDaemon(sidS)
  if (daemonReadyS) {
    // session 模式写不同错误
    await exec(sidS, `echo 'const a: string = 1' > /workspace/sess.ts`)
    const touchS = await daemonCall(sidS, "/lsp/touch", { path: "/workspace/sess.ts" })
    await sleep(5)
    const diagS = await daemonCall(sidS, "/lsp/diagnostics", { path: "/workspace/sess.ts", wait: true })
    const diagSStr = JSON.stringify(diagS)
    // session 模式：number not assignable to string
    const sessionOk = diagSStr.includes("not assignable")
    check("T27.27 session 模式诊断独立", sessionOk, diagSStr.slice(0, 80))

    // app 模式（复用 sid23）已有诊断
    if (wtDir) {
      const diagApp = await daemonCall(sid23, "/lsp/diagnostics", { path: `${wtDir}/broken.ts`, wait: true })
      const diagAppStr = JSON.stringify(diagApp)
      const appOk = diagAppStr.includes("not assignable")
      check("T27.27 app 模式诊断独立", appOk, diagAppStr.slice(0, 80))
    }
  }

  // ─── 路径越界防护（app 模式下仍生效）───
  console.log("\n── 额外：app 模式 daemon 路径越界防护 ──")
  if (wtDir) {
    const boundary = await daemonCall(sid23, "/lsp/touch", { path: "/etc/passwd" })
    check("app 模式 /etc/passwd 被拒绝", JSON.stringify(boundary).includes("outside workspace") || JSON.stringify(boundary).includes("error"))
  }

  console.log("\n" + "=".repeat(60))
  console.log(`结果: ${passed} 通过, ${failed} 失败`)
  console.log("=".repeat(60))
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error("FATAL:", e)
  process.exit(1)
})
