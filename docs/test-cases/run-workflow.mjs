#!/usr/bin/env node
/**
 * 多 Agent 协作工作流 - 端到端测试
 * 
 * 流程: requirement-agent → design-agent → task-planner-agent → code-agent → review-agent
 */

const BASE = "http://localhost:14096"
const SID = process.env.SESSION_ID

if (!SID) {
  console.error("请设置 SESSION_ID 环境变量")
  process.exit(1)
}

const AGENTS_ORDER = [
  { name: "requirement-agent", label: "需求确认" },
  { name: "design-agent", label: "技术方案" },
  { name: "task-planner-agent", label: "任务生成" },
  { name: "code-agent", label: "代码生成" },
  { name: "review-agent", label: "代码 Review" },
]

const PROMPTS = {
  "requirement-agent": "帮我做一个简易的待办事项(Todo) Web应用。\n\n核心功能：添加待办、标记完成、删除待办、按状态筛选(全部/进行中/已完成)。\n非功能需求：响应式设计、支持暗色模式、数据持久化到 localStorage。\n技术约束：纯前端，React + TypeScript。\n\n请整理成需求文档，使用 write 工具写入 /workspace/requirement.md。",

  "design-agent": "请读取 /workspace/requirement.md，根据需求设计技术方案，用 write 工具写入 /workspace/design.md。包含：技术栈选型、组件设计、数据模型、状态管理方案。直接生成，不需要讨论。",

  "task-planner-agent": "请读取 /workspace/requirement.md 和 /workspace/design.md，生成开发任务列表，用 write 工具写入 /workspace/task.md。每个任务包含：ID、名称、描述、优先级、依赖关系、验收标准。",

  "code-agent": "请读取 /workspace/task.md、/workspace/design.md 和 /workspace/requirement.md，按任务列表实现代码。将代码文件写入 /workspace/src/ 目录。先实现核心组件和类型，再实现页面和样式。",

  "review-agent": "请审查 /workspace/src/ 下的所有代码。先读取 /workspace/requirement.md 和 /workspace/design.md 了解背景。从功能正确性、代码质量、安全性、性能、最佳实践维度审查。将报告写入 /workspace/review-report.md。",
}

async function jsonFetch(path, method = "GET", body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } }
  if (body) opts.body = JSON.stringify(body)
  const resp = await fetch(`${BASE}${path}`, opts)
  const text = await resp.text()
  try { return JSON.parse(text) } catch { return { raw: text.slice(0, 200) } }
}

async function sendAndWait(agent, prompt, timeoutSec = 180) {
  console.log(`\n${"=".repeat(60)}`)
  console.log(`▶ ${agent} — 发送消息`)
  console.log(`${"=".repeat(60)}`)

  // 异步发送
  const sendResult = await jsonFetch(`/session/${SID}/prompt_async`, "POST", {
    agent,
    parts: [{ type: "text", text: prompt }],
  })
  console.log(`  发送结果: ${JSON.stringify(sendResult).slice(0, 100)}`)

  // 轮询等待
  const start = Date.now()
  let lastToolCalls = []
  
  while (Date.now() - start < timeoutSec * 1000) {
    await new Promise(r => setTimeout(r, 5000))
    
    const messages = await jsonFetch(`/session/${SID}/message`)
    if (!Array.isArray(messages)) {
      console.log(`  ⚠️ 消息格式异常: ${JSON.stringify(messages).slice(0, 100)}`)
      continue
    }

    // 找该 agent 的 assistant 消息
    const agentMsgs = messages.filter(m => m.role === "assistant" && m.agent === agent)
    
    if (agentMsgs.length > 0) {
      const last = agentMsgs[agentMsgs.length - 1]
      const parts = last.parts || []
      
      // 提取工具调用
      const tools = parts
        .filter(p => p.type === "tool-invocation")
        .map(p => `${p.toolInvocation?.toolName}(${JSON.stringify(p.toolInvocation?.args || {}).slice(0, 80)})`)
      
      // 提取文本
      const texts = parts
        .filter(p => p.type === "text" && p.text?.trim())
        .map(p => p.text.trim())

      // 打印进度
      if (tools.length > lastToolCalls.length) {
        const newTools = tools.slice(lastToolCalls.length)
        for (const t of newTools) {
          console.log(`  🔧 ${t}`)
        }
        lastToolCalls = tools
      }

      // 检查是否有实质文本回复（完成标志）
      if (texts.length > 0 && texts.some(t => t.length > 20)) {
        console.log(`  📝 回复: ${texts.join(" | ").slice(0, 300)}`)
        return { success: true, texts, tools }
      }
    }

    const elapsed = Math.round((Date.now() - start) / 1000)
    process.stdout.write(`  ⏳ ${elapsed}s...`)
    process.stdout.write('\r')
  }

  console.log(`  ⏰ 超时 (${timeoutSec}s)`)
  return { success: false, texts: [], tools: lastToolCalls }
}

async function main() {
  console.log("🚀 多 Agent 协作工作流测试")
  console.log(`   Session: ${SID}`)
  console.log(`   Server: ${BASE}`)

  // 验证 agents
  const agents = await jsonFetch(`/session/${SID}/agents`)
  const customNames = agents.filter(a => PROMPTS[a.name]).map(a => a.name)
  console.log(`   Agents: ${customNames.join(", ")}`)

  // 按顺序执行每个 agent
  const results = {}
  for (const { name, label } of AGENTS_ORDER) {
    const timeout = name === "code-agent" ? 300 : 180
    results[name] = await sendAndWait(name, PROMPTS[name], timeout)
  }

  // 汇总
  console.log(`\n${"=".repeat(60)}`)
  console.log("📊 测试结果汇总")
  console.log(`${"=".repeat(60)}`)

  for (const { name, label } of AGENTS_ORDER) {
    const r = results[name]
    const status = r.success ? "✅" : "❌"
    const toolCount = r.tools.length
    console.log(`  ${status} ${label} (${name}): ${toolCount} 工具调用`)
  }

  // 检查最终消息
  const allMsgs = await jsonFetch(`/session/${SID}/message`)
  const agentStats = {}
  for (const m of allMsgs) {
    if (m.agent && m.role === "assistant") {
      agentStats[m.agent] = (agentStats[m.agent] || 0) + 1
    }
  }
  console.log("\n  消息统计:")
  for (const [name, count] of Object.entries(agentStats)) {
    console.log(`    ${name}: ${count} 条`)
  }
}

main().catch(err => {
  console.error("❌ 错误:", err)
  process.exit(1)
})
