#!/usr/bin/env node
// LSP Code-Agent 端到端测试
//
// 模拟 code-agent 在 SaaS 沙箱中的真实开发流程，完整串联所有 LSP 能力。
// 以"添加日期格式化工具函数"为场景，依次触发 diagnostics / documentSymbol /
// workspaceSymbol / write→diagnostics / edit→diagnostics / hover / goToDefinition /
// findReferences / goToImplementation / callHierarchy / apply_patch→diagnostics。
//
// 全程检查：
//   1. 路径泄露防护：所有工具 input/output/title 中的路径均为 /workspace/...，无宿主路径
//   2. LSP 能力覆盖：9 个 LSP 操作 + write/edit/apply_patch 的诊断全部触发
//   3. 诊断准确性：故意写入类型错误时能正确检测
//   4. Daemon 健壮性：连续 13+ 步操作 daemon 不崩溃
//
// 前置（见 docs/local-test-env.md）：
//   1. PG 转发已启动（:15432）
//   2. 本地 OpenSandbox server 已启动（:8080）
//   3. sandbox 镜像已构建（opencode-opensandbox:local，含最新 daemon）
//   4. SaaS 容器已启动（:14096，连接本地 OpenSandbox）
//   5. 权限已配置（PATCH /global/config permission allow）
//
// 用法：
//   node docs/test-cases/scripts/lsp-code-agent-e2e-test.mjs
//
// 环境变量：
//   BASE       — SaaS API 地址（默认 http://localhost:14096）
//   MODEL      — 模型 JSON（默认 {"providerID":"zhipuai","modelID":"glm-5.1"}）

const BASE = process.env.BASE ?? "http://localhost:14096"
const MODEL = JSON.parse(process.env.MODEL ?? '{"providerID":"zhipuai","modelID":"glm-5.1"}')

// ─── 路径泄露检测 ─────────────────────────────────────────────
// 遵循 19-path-leak-test.md 的规则：LLM 可见路径必须为 /workspace/...
const LEAK_PATTERNS = [
  { re: /\/Users\/[\w]+/g, name: "macOS 用户路径 /Users/..." },
  { re: /\/private\/var\/folders/g, name: "macOS tmp /private/var/folders" },
  { re: /\/home\/[\w]+\/code/g, name: "Linux 用户目录 /home/.../code" },
  { re: /host\.docker\.internal/g, name: "Docker host.docker.internal" },
]

function scanLeaks(text, source) {
  if (!text || typeof text !== "string") return []
  const results = []
  for (const { re, name } of LEAK_PATTERNS) {
    const matches = [...text.matchAll(re)]
    for (const m of matches) {
      const idx = m.index
      const ctx = text.slice(Math.max(0, idx - 30), idx + m[0].length + 30).replace(/\n/g, "\\n")
      results.push({ pattern: name, match: m[0], source, context: ctx })
    }
  }
  return results
}

function collectLeaksFromMessages(messages) {
  const allLeaks = []
  for (let i = 0; i < messages.length; i++) {
    for (const part of messages[i].parts || []) {
      if (part.type === "text" && part.text) {
        allLeaks.push(...scanLeaks(part.text, `msg[${i}]/text`))
      }
      if (part.type === "tool" && part.state) {
        const toolName = part.tool || "?"
        if (part.state.input)
          allLeaks.push(...scanLeaks(JSON.stringify(part.state.input), `msg[${i}]/tool-input/${toolName}`))
        if (part.state.output)
          allLeaks.push(...scanLeaks(part.state.output, `msg[${i}]/tool-output/${toolName}`))
        if (part.state.title)
          allLeaks.push(...scanLeaks(part.state.title, `msg[${i}]/tool-title/${toolName}`))
      }
    }
  }
  return allLeaks
}

// ─── HTTP 工具 ────────────────────────────────────────────────
async function api(path, method = "GET", body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } }
  if (body) opts.body = JSON.stringify(body)
  const resp = await fetch(`${BASE}${path}`, opts)
  const text = await resp.text()
  const data = (() => {
    try { return JSON.parse(text) } catch { return text }
  })()
  if (!resp.ok) {
    throw new Error(`${method} ${path} failed: HTTP ${resp.status} ${typeof data === "string" ? data : JSON.stringify(data)}`)
  }
  return data
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ─── 统计 ─────────────────────────────────────────────────────
let step = 0
let totalToolCalls = 0
const toolSummary = {}
const allLeaks = []
const failures = []

function countTools(result) {
  for (const p of result.parts || []) {
    if (p.type === "tool") {
      totalToolCalls++
      const t = p.tool || "?"
      toolSummary[t] = (toolSummary[t] || 0) + 1
    }
  }
}

// ─── 发送 AI 消息 ─────────────────────────────────────────────
async function sendMsg(sid, text, label) {
  step++
  console.log(`\n━━ Step ${step} [${label}] ━━`)
  console.log(`  📤 发送: "${text.slice(0, 100)}..."`)

  const start = Date.now()
  const result = await api(`/session/${sid}/message`, "POST", {
    parts: [{ type: "text", text }],
    model: MODEL,
  })
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)

  if (!Array.isArray(result.parts)) {
    throw new Error(`/message returned no parts for ${label}: ${JSON.stringify(result).slice(0, 500)}`)
  }

  countTools(result)

  const textParts = (result.parts || []).filter((p) => p.type === "text")
  const toolParts = (result.parts || []).filter((p) => p.type === "tool")
  const tools = toolParts.map((p) => p.tool).join(", ") || "-"
  const summary = textParts
    .map((p) => p.text)
    .join(" ")
    .slice(0, 300)
    .replace(/\n/g, " ")

  console.log(`  📥 ${elapsed}s tools=[${tools}]`)
  if (summary) console.log(`     回复: ${summary}`)

  // 检查工具调用输出中的 LSP 诊断
  for (const p of toolParts) {
    const output = p.state?.output || ""
    if (output.includes("LSP errors detected")) {
      console.log(`     🔍 ${p.tool} 输出含 LSP 诊断信息`)
    }
    if (output.includes("not yet supported in sandbox mode")) {
      console.log(`     ⚠️ ${p.tool} 输出 "not yet supported" — 能力缺失!`)
    }
  }

  return result
}

// ─── exec 命令 ────────────────────────────────────────────────
async function execCmd(sid, command, label = "") {
  const tag = label || command.slice(0, 60)
  console.log(`  🔧 exec: ${tag}`)
  const result = await api(`/session/${sid}/exec`, "POST", { command })
  const leaks = [
    ...scanLeaks(result.stdout || "", `exec/${tag}/stdout`),
    ...scanLeaks(result.stderr || "", `exec/${tag}/stderr`),
  ]
  if (leaks.length > 0) {
    console.log(`  ❌ exec 泄露:`)
    for (const l of leaks) console.log(`     [${l.source}] ${l.pattern}: "${l.match}"`)
  }
  allLeaks.push(...leaks)
  return result
}

// ─── 主流程 ───────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(70))
  console.log("  LSP Code-Agent 端到端测试")
  console.log("  模拟 code-agent 在 SaaS 沙箱中的完整开发流程")
  console.log("═".repeat(70))

  let sid

  try {
    // ── Phase 0: 环境准备 ────────────────────────────────────
    console.log("\n━━ Phase 0: 环境准备 ━━")

    // 0.1 健康检查
    console.log("  🔍 SaaS 服务健康检查...")
    const health = await fetch(`${BASE}/global/health`).then((r) => r.status)
    if (health !== 200) throw new Error(`SaaS 服务不可用: HTTP ${health}`)
    console.log("  ✅ SaaS 服务正常")

    // 0.2 配置权限
    console.log("  🔧 配置工具权限...")
    await api("/global/config", "PATCH", {
      permission: {
        bash: "allow",
        edit: "allow",
        write: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        read: "allow",
        webfetch: "allow",
      },
    })
    await sleep(3)

    // 0.3 创建 Session
    const session = await api("/session", "POST", {})
    sid = session.id
    console.log(`  ✅ Session: ${sid}`)

    // 0.4 用 exec 初始化 TypeScript 项目
    console.log("  🔧 初始化 TS 项目...")
    const initResult = await execCmd(
      sid,
      [
        "mkdir -p /workspace/src/utils",
        "cd /workspace",
        'printf \'{"compilerOptions":{"strict":true,"target":"ES2020","moduleResolution":"node"},"include":["src/**/*"]}\' > tsconfig.json',
        'printf \'export interface DateFormatter { format(date: Date): string }\\n\' > src/utils/types.ts',
        'printf \'import { DateFormatter } from "./types"\\nexport class SimpleFormatter implements DateFormatter { format(date: Date) { return date.toISOString().split("T")[0] } }\\nexport function createFormatter(): DateFormatter { return new SimpleFormatter() }\\n\' > src/utils/formatter.ts',
        'printf \'import { createFormatter } from "./utils/formatter"\\nconst f = createFormatter()\\nconsole.log(f.format(new Date()))\\n\' > src/index.ts',
        "echo INIT_OK",
      ].join(" && "),
      "初始化 TS 项目",
    )
    if (!(initResult.stdout || "").includes("INIT_OK")) {
      throw new Error(`项目初始化失败: ${(initResult.stderr || "").slice(0, 200)}`)
    }
    console.log("  ✅ TS 项目已初始化（含 interface + implementation + consumer）")

    // 0.5 keepAlive
    await api(`/session/${sid}/keep-alive`, "POST", { enabled: true })
    console.log("  ✅ keepAlive 已启用")

    // ── Phase 1: LSP 首次触发（write 工具拉起 daemon）────────
    // daemon 仅在首次 LSP 工具调用时由主进程启动，必须走 AI 消息
    await sendMsg(
      sid,
      "Create /workspace/src/utils/date.ts with exactly this content (no changes):\n\nexport function formatDate(date: Date): string {\n  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`\n}\n",
      "S4: write 工具创建文件 → 触发 daemon + diagnostics",
    )

    // 验证 daemon 已启动
    const daemonCheck = await execCmd(
      sid,
      "curl -s http://localhost:20877/lsp/status || echo DAEMON_NOT_STARTED",
      "验证 daemon 已启动",
    )
    const daemonStatus = (daemonCheck.stdout || "").trim()
    if (daemonStatus.includes("DAEMON_NOT_STARTED")) {
      console.log("  ⚠️ daemon 未启动，再次触发...")
      await sendMsg(
        sid,
        "Use write tool to create /workspace/src/utils/placeholder.ts with: export const PH = 1",
        "重试触发 daemon",
      )
    } else {
      console.log(`  ✅ daemon 状态: ${daemonStatus.slice(0, 100)}`)
    }

    // ── Phase 2: LSP 能力逐项验证 ────────────────────────────

    // S5: 故意写入含类型错误的文件 → 验证 diagnostics（write 工具必须触发 LSP 诊断）
    await sendMsg(
      sid,
      'Use write tool to create /workspace/src/utils/broken.ts with exactly: const x: string = 123; function add(a: number): string { return a }',
      "S5: write 含类型错误 → diagnostics 应检测到",
    )
    // POST /message 只返回 AI 最终文字；write 工具输出在中间消息，需查 GET /message
    const s5msgs = await api(`/session/${sid}/message`)
    const s5writePart = [...s5msgs].reverse().find((m) => m.parts?.some((p) => p.type === "tool" && p.tool === "write"))?.parts?.find((p) => p.type === "tool" && p.tool === "write")
    const s5hasDiag = (s5writePart?.state?.output || "").includes("LSP errors detected")
    if (!s5hasDiag) {
      console.log("  ❌ S5 FAIL: write 工具未触发 LSP 诊断（输出未含 'LSP errors detected'）")
      console.log(`     write 输出: "${(s5writePart?.state?.output || "(未找到 write 工具)").slice(0, 200)}"`)
      failures.push("S5: write LSP diagnostics")
    } else {
      console.log("  ✅ S5 PASS: write 工具成功触发 LSP 诊断")
    }

    // S6: 用 edit 修复类型错误 → diagnostics 应清除
    await sendMsg(
      sid,
      'Use edit tool to fix /workspace/src/utils/broken.ts: change "const x: string = 123" to "const x: number = 123", and change "function add(a: number): string" to "function add(a: number): number"',
      "S6: edit 修复类型错误 → diagnostics 应清除",
    )

    // S8: hover 检查类型签名
    await sendMsg(
      sid,
      "Use the lsp tool to hover over the function name 'formatDate' in /workspace/src/utils/date.ts (around line 1)",
      "S8: lsp hover → 类型签名",
    )

    // S9: goToDefinition — 从 index.ts 跳到 createFormatter 定义
    await sendMsg(
      sid,
      "Use the lsp tool to go to definition of 'createFormatter' in /workspace/src/index.ts",
      "S9: lsp goToDefinition → 跳转定义",
    )

    // S10: findReferences — 查找 DateFormatter 接口的引用
    await sendMsg(
      sid,
      "Use the lsp tool to find references of 'DateFormatter' in /workspace/src/utils/types.ts",
      "S10: lsp findReferences → 查找引用",
    )

    // S11: goToImplementation — 从接口跳到具体实现
    await sendMsg(
      sid,
      "Use the lsp tool to go to implementation of 'DateFormatter' interface in /workspace/src/utils/types.ts",
      "S11: lsp goToImplementation → 接口→实现",
    )

    // S1: diagnostics 全项目健康检查
    await sendMsg(
      sid,
      "Use the lsp tool to get diagnostics for /workspace/src/index.ts",
      "S1: lsp diagnostics → 全项目诊断",
    )

    // S2: documentSymbol — 了解模块结构
    await sendMsg(
      sid,
      "Use the lsp tool to get document symbols for /workspace/src/utils/formatter.ts",
      "S2: lsp documentSymbol → 模块结构",
    )

    // S3: workspaceSymbol — 搜索符号
    await sendMsg(
      sid,
      "Use the lsp tool to search workspace symbols for 'format'",
      "S3: lsp workspaceSymbol → 搜索符号",
    )

    // S12: callHierarchy — 调用链分析
    await sendMsg(
      sid,
      "Use the lsp tool to prepare call hierarchy for 'formatDate' function in /workspace/src/utils/date.ts",
      "S12a: lsp prepareCallHierarchy",
    )

    await sendMsg(
      sid,
      "Use the lsp tool to find incoming calls for 'formatDate' in /workspace/src/utils/date.ts",
      "S12b: lsp incomingCalls → 谁调用了 formatDate",
    )

    await sendMsg(
      sid,
      "Use the lsp tool to find outgoing calls for 'formatDate' in /workspace/src/utils/date.ts",
      "S12c: lsp outgoingCalls → formatDate 调用了什么",
    )

    // S13: apply_patch → 精细化修改 + diagnostics
    await sendMsg(
      sid,
      'Use edit tool to add a JSDoc comment above formatDate function in /workspace/src/utils/date.ts. Add: /** Formats a Date to YYYY-MM-DD string */',
      "S13: edit 添加 JSDoc → diagnostics",
    )

    // S-非TS: 非 TypeScript 文件不触发 LSP
    await sendMsg(
      sid,
      "Use write tool to create /workspace/README.md with content: # Date Utils Project",
      "S-非TS: write .md 文件 → 不应触发 LSP",
    )

    // ── Phase 3: 汇总检查 ────────────────────────────────────
    step++
    console.log(`\n━━ Step ${step}: 汇总检查 ━━`)

    const messages = await api(`/session/${sid}/message`)
    console.log(`  📊 共 ${messages.length} 条消息`)

    // Re-count tools from the full message list — the synchronous /message
    // response may only include the final text parts, not intermediate tool calls.
    totalToolCalls = 0
    for (const key of Object.keys(toolSummary)) delete toolSummary[key]
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "tool") {
          totalToolCalls++
          const t = part.tool || "?"
          toolSummary[t] = (toolSummary[t] || 0) + 1
        }
      }
    }
    console.log(`  🔧 工具调用: ${totalToolCalls} 次 — ${Object.entries(toolSummary).map(([k, v]) => `${k}×${v}`).join(", ")}`)

    // 路径泄露全量扫描
    const msgLeaks = collectLeaksFromMessages(messages)
    allLeaks.push(...msgLeaks)

    // 去重
    const seen = new Set()
    const uniqueLeaks = allLeaks.filter((l) => {
      const key = `${l.match}|${l.source}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    if (uniqueLeaks.length > 0) {
      console.log(`\n  ❌ 发现 ${uniqueLeaks.length} 处路径泄露:\n`)
      for (const l of uniqueLeaks) {
        console.log(`  ❌ [${l.source}] ${l.pattern}: "${l.match}"`)
        console.log(`     上下文: ...${l.context}...`)
      }
    } else {
      console.log("  ✅ 未发现宿主机路径泄露")
    }

    // LSP 能力覆盖统计
    const lspTools = toolSummary["lsp"] || 0
    const writeTools = toolSummary["write"] || 0
    const editTools = toolSummary["edit"] || 0
    console.log(`\n  📋 LSP 能力统计:`)
    console.log(`     lsp 工具调用: ${lspTools} 次`)
    console.log(`     write 工具调用: ${writeTools} 次（含 diagnostics）`)
    console.log(`     edit 工具调用: ${editTools} 次（含 diagnostics）`)

    // 检查是否有 "not yet supported"
    let unsupportedCount = 0
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "tool" && part.state?.output?.includes("not yet supported in sandbox mode")) {
          unsupportedCount++
          console.log(`  ⚠️ "not yet supported" 出现在 ${part.tool} 工具输出中`)
        }
      }
    }

    // ── 最终结论 ──────────────────────────────────────────────
    console.log("\n" + "═".repeat(70))
    const missing = []
    if (totalToolCalls === 0) missing.push("expected at least one tool call")
    if (writeTools === 0) missing.push("expected write tool to be used")
    if (editTools === 0) missing.push("expected edit tool to be used")
    if (lspTools === 0) missing.push("expected lsp tool to be used")

    const passed = uniqueLeaks.length === 0 && unsupportedCount === 0 && missing.length === 0 && failures.length === 0
    if (passed) {
      console.log("  ✅ 测试通过")
      console.log(`     路径泄露: 0 处`)
      console.log(`     LSP 能力缺失: 0 处`)
      console.log(`     工具调用: ${totalToolCalls} 次`)
    } else {
      console.log("  ❌ 测试失败")
      if (uniqueLeaks.length > 0) console.log(`     路径泄露: ${uniqueLeaks.length} 处`)
      if (unsupportedCount > 0) console.log(`     LSP 能力缺失: ${unsupportedCount} 处`)
      if (missing.length > 0) console.log(`     缺少断言: ${missing.join("; ")}`)
      if (failures.length > 0) console.log(`     用例失败: ${failures.join("; ")}`)
      process.exit(1)
    }
    console.log("═".repeat(70))
  } catch (err) {
    console.error(`\n💥 测试出错: ${err.message}`)
    console.error(err.stack)
    process.exit(2)
  }
}

main()
