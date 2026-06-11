#!/usr/bin/env node
/**
 * 路径泄露端到端测试 — 真实开发流程
 *
 * 模拟 SaaS 生产完整流程：创建会话 → exec 拉代码 → AI 开发 → AI Review → exec 提交
 * 每个阶段都扫描路径泄露。
 *
 * 用法:
 *   node docs/test-cases/path-leak-real-workflow-test.mjs
 *
 * 前提: 本地测试环境已启动（容器 + TCP 转发）
 */

const BASE = "http://localhost:14096"
const GIT_REPO = "https://oauth2:eY8gCHMpNWrJpRLHDvK3f286MQp1OmJiCA.01.0y10q698d@gitlab.shadow-rpa.net/frontend/xybot-front-home-v3.git"
const PROJECT_DIR = "/workspace/xybot-front-home-v3"

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
    for (const part of messages[i].parts || []) {
      if (part.type === "text" && part.text) {
        allLeaks.push(...scanLeaks(part.text, `msg[${i}]/text`))
      }
      if (part.type === "tool" && part.state) {
        const toolName = part.tool || "?"
        if (part.state.input) allLeaks.push(...scanLeaks(JSON.stringify(part.state.input), `msg[${i}]/tool-input/${toolName}`))
        if (part.state.output) allLeaks.push(...scanLeaks(part.state.output, `msg[${i}]/tool-output/${toolName}`))
        if (part.state.title) allLeaks.push(...scanLeaks(part.state.title, `msg[${i}]/tool-title/${toolName}`))
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

async function sendMsg(sid, text) {
  console.log(`  📤 发送: "${text.slice(0, 80)}..."`)
  const start = Date.now()
  const result = await api(`/session/${sid}/message`, "POST", {
    parts: [{ type: "text", text }],
  })
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  const info = result.info || {}
  const textParts = (result.parts || []).filter(p => p.type === "text")
  const toolParts = (result.parts || []).filter(p => p.type === "tool")
  const summary = textParts.map(p => p.text).join(" ").slice(0, 200).replace(/\n/g, " ")
  console.log(`  📥 ${elapsed}s model=${info.modelID || "?"} tools=[${toolParts.map(p => p.tool).join(",") || "-"}]`)
  if (summary) console.log(`     回复: ${summary}`)
  return result
}

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
    printLeaks(leaks)
  }
  return { result, leaks }
}

async function main() {
  console.log("═".repeat(60))
  console.log("  路径泄露测试 — 真实开发流程")
  console.log("═".repeat(60))

  const allLeaks = []
  let sid
  let step = 0

  try {
    // ── WF-1: 健康检查 + 创建会话 ──
    step++
    console.log(`\n━━ Step ${step} [WF-1]: 创建会话 ━━`)
    const session1 = await api("/session", "POST", {})
    sid = session1.id
    console.log(`  ✅ Session: ${sid}`)

    // ── WF-2: 配置权限 ──
    step++
    console.log(`\n━━ Step ${step} [WF-2]: 配置权限 ━━`)
    await api("/global/config", "PATCH", {
      permission: { bash: "allow", edit: "allow", write: "allow", glob: "allow", grep: "allow", list: "allow", read: "allow", webfetch: "allow" },
    })
    await sleep(3)
    const session2 = await api("/session", "POST", {})
    sid = session2.id
    console.log(`  ✅ 权限已配置, 新 SID: ${sid}`)

    // ── WF-3: exec 拉取代码 ──
    step++
    console.log(`\n━━ Step ${step} [WF-3]: exec 拉取代码 ━━`)
    const { result: cloneResult, leaks: cloneLeaks } = await execCmd(
      sid,
      `rm -rf ${PROJECT_DIR} && git clone ${GIT_REPO} ${PROJECT_DIR} --depth 1 2>&1 && echo "CLONE_OK"`,
      "git clone"
    )
    allLeaks.push(...cloneLeaks)
    if (cloneResult.exitCode !== 0) {
      console.log(`  ❌ clone 失败: exitCode=${cloneResult.exitCode}`)
      console.log(`  stdout: ${(cloneResult.stdout || "").slice(0, 200)}`)
      console.log(`  stderr: ${(cloneResult.stderr || "").slice(0, 200)}`)
      throw new Error("git clone 失败")
    }
    console.log(`  ✅ 代码已克隆到 ${PROJECT_DIR}`)

    // 验证文件存在
    const { result: lsResult } = await execCmd(sid, `ls ${PROJECT_DIR}/package.json && echo "HAS_PKG"`, "验证项目文件")
    if (!(lsResult.stdout || "").includes("HAS_PKG")) {
      throw new Error("项目文件不存在")
    }
    console.log("  ✅ 项目文件验证通过")

    // ── WF-3.5: 更新 session 工作目录 ──
    step++
    console.log(`\n━━ Step ${step} [WF-3.5]: 更新 session 工作目录 ━━`)
    const patchResult = await api(`/session/${sid}`, "PATCH", { directory: PROJECT_DIR })
    console.log(`  ✅ directory 已更新为 ${patchResult.directory}`)

    // ── WF-4: keepAlive ──
    step++
    console.log(`\n━━ Step ${step} [WF-4]: keepAlive ━━`)
    await api(`/session/${sid}/keep-alive`, "POST", { enabled: true })
    console.log("  ✅ keepAlive 已启用")

    // ── WF-5: AI 需求分析 ──
    step++
    console.log(`\n━━ Step ${step} [WF-5]: AI 需求分析 ━━`)
    await sendMsg(sid, `请分析当前项目的技术栈和目录结构。用 glob 搜索主要文件，用 read 读取 package.json，告诉我这是什么项目、用了什么技术栈。`)

    // ── WF-6: AI 开发 ──
    step++
    console.log(`\n━━ Step ${step} [WF-6]: AI 开发 ━━`)
    await sendMsg(sid, `请在当前项目中创建 src/utils/formatDate.ts，导出函数 formatDate(date: Date): string，把日期格式化为 YYYY-MM-DD HH:mm:ss 格式。请先用 glob 看一下 src 目录结构，然后用 write 创建文件。`)

    // ── WF-7: AI Review ──
    step++
    console.log(`\n━━ Step ${step} [WF-7]: AI Review ━━`)
    await sendMsg(sid, `请 review 你刚才创建的 src/utils/formatDate.ts 文件。先用 read 读取内容，然后检查代码质量、类型安全、边界处理，给出改进建议。如果有问题请用 edit 修复。`)

    // ── WF-8: exec 提交 ──
    step++
    console.log(`\n━━ Step ${step} [WF-8]: exec 提交代码 ━━`)
    const { result: addResult, leaks: addLeaks } = await execCmd(
      sid,
      `cd ${PROJECT_DIR} && git add -A && git status --short`,
      "git add"
    )
    allLeaks.push(...addLeaks)

    const { result: commitResult, leaks: commitLeaks } = await execCmd(
      sid,
      `cd ${PROJECT_DIR} && git commit -m "feat(utils): add formatDate utility" && git log --oneline -3`,
      "git commit"
    )
    allLeaks.push(...commitLeaks)
    console.log(`  ✅ 代码已提交: ${(commitResult.stdout || "").split("\n").pop()}`)

    // ── WF-9: 汇总检查 ──
    step++
    console.log(`\n━━ Step ${step} [WF-9]: 汇总检查路径泄露 ━━`)

    const messages = await api(`/session/${sid}/message`)
    console.log(`  📊 共 ${messages.length} 条消息`)

    const toolCalls = []
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "tool") toolCalls.push(part.tool)
      }
    }
    const toolSummary = {}
    for (const t of toolCalls) toolSummary[t] = (toolSummary[t] || 0) + 1
    console.log(`  🔧 工具调用: ${toolCalls.length} 次 — ${Object.entries(toolSummary).map(([k, v]) => `${k}×${v}`).join(", ")}`)

    const msgLeaks = collectLeaksFromMessages(messages)
    allLeaks.push(...msgLeaks)

    // exec 泄露去重
    const uniqueLeaks = []
    const seen = new Set()
    for (const l of allLeaks) {
      const key = `${l.match}|${l.source}`
      if (!seen.has(key)) {
        seen.add(key)
        uniqueLeaks.push(l)
      }
    }

    if (uniqueLeaks.length > 0) {
      console.log(`\n  ❌ 发现 ${uniqueLeaks.length} 处路径泄露:\n`)
      printLeaks(uniqueLeaks)
    } else {
      console.log("  ✅ 未发现宿主机路径泄露")
    }

    // 打印 AI 环境信息
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text && (part.text.includes("Working directory") || part.text.includes("技术栈"))) {
          console.log(`\n  📋 AI 关键回复:\n${part.text.slice(0, 400)}`)
        }
      }
    }

    // 最终结果
    console.log("\n" + "═".repeat(60))
    if (uniqueLeaks.length === 0) {
      console.log("  ✅ 真实开发流程测试通过：全程未泄露宿主机路径")
    } else {
      console.log(`  ❌ 测试失败：共发现 ${uniqueLeaks.length} 处路径泄露`)
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
