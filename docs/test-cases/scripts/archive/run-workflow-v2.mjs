#!/usr/bin/env node
const BASE = "http://localhost:14096"
const SID = process.env.SESSION_ID
if (!SID) { console.error("需要 SESSION_ID"); process.exit(1) }

const TIMEOUT = 180_000 // 3 min per agent

async function api(path, method, body) {
  const opts = { method: method || "GET", headers: { "Content-Type": "application/json" } }
  if (body) opts.body = JSON.stringify(body)
  const r = await fetch(`${BASE}${path}`, opts)
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { _raw: t.slice(0, 200), _status: r.status } }
}

const STEPS = [
  { agent: "requirement-agent", label: "需求确认",
    prompt: "帮我做一个简易的待办事项 Web 应用。功能：添加待办、标记完成、删除待办、按状态筛选。非功能需求：响应式设计、暗色模式、localStorage 持久化。技术约束：纯前端 React+TypeScript。请直接生成 requirement.md" },
  { agent: "design-agent", label: "技术方案",
    prompt: "请读取 /workspace/requirement.md，设计技术方案，直接写入 /workspace/design.md" },
  { agent: "task-planner-agent", label: "任务生成",
    prompt: "请读取 /workspace/requirement.md 和 /workspace/design.md，生成任务列表，直接写入 /workspace/task.md" },
  { agent: "code-agent", label: "代码生成",
    prompt: "请读取 /workspace/task.md、/workspace/design.md 和 /workspace/requirement.md，按任务实现代码，写入 /workspace/src/ 目录。同时创建 package.json。" },
  { agent: "review-agent", label: "代码Review",
    prompt: "请读取 /workspace/requirement.md 和 /workspace/design.md，然后查看 /workspace/src/ 下所有代码，生成 review 报告写入 /workspace/review-report.md" },
]

function getAssistantText(msgs, agent) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    const info = m.info || {}
    if (info.role === "assistant" && info.agent === agent) {
      const parts = m.parts || []
      const texts = parts.filter(p => p.type === "text").map(p => p.text).filter(Boolean)
      const tools = parts.filter(p => p.type === "tool").map(p => {
        const t = p.tool || {}
        const state = p.state || {}
        return `${t.name || "?"}(${JSON.stringify(state.input || {}).slice(0, 80)}) [${state.status}]`
      })
      return { texts, tools, found: true }
    }
  }
  return { texts: [], tools: [], found: false }
}

async function runStep(step) {
  console.log(`\n${"=".repeat(55)}`)
  console.log(`▶ ${step.label} (${step.agent})`)
  console.log(`${"=".repeat(55)}`)

  // Send async
  const send = await api(`/session/${SID}/prompt_async`, "POST", {
    agent: step.agent,
    parts: [{ type: "text", text: step.prompt }],
  })
  console.log(`  发送: status=${send._status || "204"}`)

  // Poll
  const start = Date.now()
  let lastPrint = 0
  while (Date.now() - start < (step.agent === "code-agent" ? 300000 : TIMEOUT)) {
    await new Promise(r => setTimeout(r, 4000))
    
    const msgs = await api(`/session/${SID}/message`)
    if (!Array.isArray(msgs)) continue

    const { texts, tools, found } = getAssistantText(msgs, step.agent)
    
    if (found) {
      // Show tool progress
      if (tools.length > lastPrint) {
        for (let i = lastPrint; i < tools.length; i++) {
          console.log(`  🔧 ${tools[i]}`)
        }
        lastPrint = tools.length
      }

      // Check if AI has text response (done)
      if (texts.length > 0 && texts.some(t => t.length > 20)) {
        console.log(`  ✅ 完成: ${texts.join(" ").slice(0, 300)}`)
        return true
      }
    }

    const elapsed = Math.round((Date.now() - start) / 1000)
    if (elapsed % 15 === 0) {
      process.stdout.write(`  ⏳ ${elapsed}s\n`)
    }
  }
  console.log(`  ⏰ 超时`)
  return false
}

async function main() {
  console.log("🚀 多Agent工作流测试")
  console.log(`   Session: ${SID}`)

  for (const step of STEPS) {
    await runStep(step)
  }

  // Final summary
  console.log(`\n${"=".repeat(55)}`)
  console.log("📊 最终统计")
  const msgs = await api(`/session/${SID}/message`)
  if (Array.isArray(msgs)) {
    const stats = {}
    for (const m of msgs) {
      const info = m.info || {}
      if (info.agent) stats[info.agent] = (stats[info.agent] || 0) + 1
    }
    for (const [k, v] of Object.entries(stats)) {
      console.log(`  ${k}: ${v} 消息`)
    }
  }
  console.log("🏁 完成!")
}

main().catch(e => { console.error(e); process.exit(1) })
