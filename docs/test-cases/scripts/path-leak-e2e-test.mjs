#!/usr/bin/env node
/**
 * 路径泄露端到端测试
 *
 * 验证 SaaS 沙箱模式下 LLM 看不到宿主机真实路径。
 * 流程：创建 session → exec 拉代码 → AI 消息触发各工具 → 检查所有输出中宿主机路径。
 *
 * 实际 API 格式:
 *   POST /message 同步返回（阻塞等 AI 完成）
 *   tool part: { type: "tool", tool: "read", state: { input: {...}, output: "..." } }
 *   text part: { type: "text", text: "..." }
 *   step-start / step-finish / reasoning: 其他辅助 part
 *
 * 用法:
 *   node docs/test-cases/scripts/path-leak-e2e-test.mjs
 *
 * 前提: 本地测试环境已启动（容器 + TCP 转发）
 */

const BASE = "http://localhost:14096"

const LEAK_PATTERNS = [
  { re: /\/Users\/ruomu/gi, name: "macOS用户路径 /Users/ruomu" },
  { re: /\/private\/var\/folders/gi, name: "macOS tmp symlink /private/var/folders" },
  { re: /host\.docker\.internal/gi, name: "Docker host.docker.internal" },
  { re: /172\.18\.\d+\.\d+/g, name: "内网IP 172.18.x.x" },
]

async function api(path, method = "GET", body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } }
  if (body) opts.body = JSON.stringify(body)
  const resp = await fetch(`${BASE}${path}`, opts)
  const text = await resp.text()
  try { return JSON.parse(text) } catch { return text }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

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
    const msg = messages[i]
    for (const part of msg.parts || []) {
      // 文本
      if (part.type === "text" && part.text) {
        allLeaks.push(...scanLeaks(part.text, `msg[${i}]/text`))
      }
      // 工具: state.input + state.output
      if (part.type === "tool" && part.state) {
        const toolName = part.tool || "?"
        const input = part.state.input
        const output = part.state.output
        if (input) {
          allLeaks.push(...scanLeaks(JSON.stringify(input), `msg[${i}]/tool-input/${toolName}`))
        }
        if (output) {
          allLeaks.push(...scanLeaks(output, `msg[${i}]/tool-output/${toolName}`))
        }
        // title 也检查
        if (part.state.title) {
          allLeaks.push(...scanLeaks(part.state.title, `msg[${i}]/tool-title/${toolName}`))
        }
      }
    }
  }
  return allLeaks
}

function printLeaks(leaks) {
  for (const l of leaks) {
    console.log(`  ❌ [${l.source}] ${l.pattern}: "${l.match}"`)
    console.log(`     上下文: ...${l.context}...`)
  }
}

async function sendMsg(sid, text, timeoutMs = 180_000) {
  console.log(`  📤 发送: "${text.slice(0, 80)}..."`)
  const start = Date.now()
  const result = await api(`/session/${sid}/message`, "POST", {
    parts: [{ type: "text", text }],
  })
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  const info = result.info || {}
  const textParts = (result.parts || []).filter(p => p.type === "text")
  const toolParts = (result.parts || []).filter(p => p.type === "tool")
  const summary = textParts.map(p => p.text).join(" ").slice(0, 150).replace(/\n/g, " ")
  console.log(`  📥 ${elapsed}s model=${info.modelID || "?"} tools=[${toolParts.map(p => p.tool).join(",") || "-"}]`)
  if (summary) console.log(`     回复: ${summary}`)
  return result
}

async function main() {
  console.log("═".repeat(60))
  console.log("  路径泄露端到端测试 (SaaS 沙箱)")
  console.log("═".repeat(60))

  let sid
  let step = 0

  try {
    // Step 1: 健康检查
    step++
    console.log(`\n━━ Step ${step}: 健康检查 ━━`)
    const r = await fetch(`${BASE}/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    if (!r.ok) throw new Error(`API 不可用: ${r.status}`)
    const probe = await r.json()
    sid = probe.id
    console.log(`  ✅ 服务正常, 临时 SID: ${sid}`)

    // Step 2: 配置权限
    step++
    console.log(`\n━━ Step ${step}: 配置权限 ━━`)
    await api("/global/config", "PATCH", {
      permission: { bash: "allow", edit: "allow", write: "allow", glob: "allow", grep: "allow", list: "allow", read: "allow", webfetch: "allow" },
    })
    await sleep(3)
    // 权限变更导致实例 dispose，创建新 session
    const session2 = await api("/session", "POST", {})
    sid = session2.id
    console.log(`  ✅ 权限已配置, 新 SID: ${sid}`)

    // Step 3: 初始化沙箱
    step++
    console.log(`\n━━ Step ${step}: 初始化沙箱 (exec) ━━`)
    const init = await api(`/session/${sid}/exec`, "POST", {
      command: "mkdir -p /workspace/test-project && cd /workspace/test-project && git init && echo 'console.log(\"hello\")' > index.js && echo '# Test Project' > README.md && mkdir -p src && echo 'export const foo = 1' > src/mod.ts",
    })
    if (init.exitCode !== 0) throw new Error(`exec 失败: ${init.stderr}`)
    await api(`/session/${sid}/keep-alive`, "POST", { enabled: true })
    console.log("  ✅ 沙箱已初始化, keepAlive 已启用")

    // Step 4: read 工具
    step++
    console.log(`\n━━ Step ${step}: read 工具 ━━`)
    await sendMsg(sid, "请用 read 工具读取 /workspace/test-project/README.md 的完整内容，把结果告诉我")

    // Step 5: glob 工具
    step++
    console.log(`\n━━ Step ${step}: glob 工具 ━━`)
    await sendMsg(sid, "请用 glob 工具在 /workspace/test-project 中搜索 **/*.ts 模式的文件")

    // Step 6: grep 工具
    step++
    console.log(`\n━━ Step ${step}: grep 工具 ━━`)
    await sendMsg(sid, "请用 grep 工具在 /workspace/test-project 中搜索关键词 console")

    // Step 7: list 工具
    step++
    console.log(`\n━━ Step ${step}: list 工具 ━━`)
    await sendMsg(sid, "请用 list 工具列出 /workspace/test-project 目录的内容")

    // Step 8: write 工具
    step++
    console.log(`\n━━ Step ${step}: write 工具 ━━`)
    await sendMsg(sid, "请用 write 工具在 /workspace/test-project/src/utils.ts 写入: export function add(a: number, b: number) { return a + b }")

    // Step 9: edit 工具
    step++
    console.log(`\n━━ Step ${step}: edit 工具 ━━`)
    await sendMsg(sid, "请用 edit 工具把 /workspace/test-project/README.md 中的 'Test Project' 替换为 'My Project'")

    // Step 10: bash 工具
    step++
    console.log(`\n━━ Step ${step}: bash 工具 ━━`)
    await sendMsg(sid, "请用 bash 工具执行: cd /workspace/test-project && ls -la && pwd && git status")

    // Step 11: 让 AI 报告环境信息
    step++
    console.log(`\n━━ Step ${step}: AI 报告环境信息 ━━`)
    await sendMsg(sid, "请告诉我你当前的 Working directory 和 Workspace root 的完整路径。看一下你的系统提示中 <env> 块的内容，把 Working directory 和 Workspace root 的值一字不差地告诉我。")

    // Step 12: 汇总检查
    step++
    console.log(`\n━━ Step ${step}: 汇总检查路径泄露 ━━`)
    const messages = await api(`/session/${sid}/message`)
    console.log(`  📊 共 ${messages.length} 条消息`)

    // 统计工具调用
    const toolCalls = []
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "tool") toolCalls.push(part.tool)
      }
    }
    console.log(`  🔧 工具调用: ${toolCalls.length} 次 — ${[...new Set(toolCalls)].join(", ")}`)

    const leaks = collectLeaksFromMessages(messages)

    if (leaks.length > 0) {
      console.log(`\n  ❌ 发现 ${leaks.length} 处路径泄露:\n`)
      printLeaks(leaks)
    } else {
      console.log("  ✅ 未发现宿主机路径泄露")
    }

    // 打印 AI 报告的环境信息
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text && (part.text.includes("Working directory") || part.text.includes("Workspace root"))) {
          console.log(`\n  📋 AI 报告的环境信息:\n${part.text.slice(0, 500)}`)
        }
      }
    }

    // 最终结果
    console.log("\n" + "═".repeat(60))
    if (leaks.length === 0) {
      console.log("  ✅ 测试通过：所有工具调用均未泄露宿主机路径")
    } else {
      console.log(`  ❌ 测试失败：共发现 ${leaks.length} 处路径泄露`)
      process.exit(1)
    }
    console.log("═".repeat(60))

  } catch (err) {
    console.error(`\n💥 测试出错: ${err.message}`)
    console.error(err.stack)
    process.exit(2)
  }
}

main()
