#!/usr/bin/env node
/**
 * 多 Agent 协作工作流端到端测试
 * 
 * 流程: requirement-agent → design-agent → task-planner-agent → code-agent → review-agent
 * 产物: requirement.md → design.md → task.md → src/** → review-report.md
 */

const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

// ============================================================
// 工具函数
// ============================================================

async function json(path, method = "GET", body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } }
  if (body) opts.body = JSON.stringify(body)
  const resp = await fetch(`${BASE}${path}`, opts)
  const text = await resp.text()
  try { return JSON.parse(text) } catch { return text }
}

async function sendAndWait(sessionID, agent, content, timeoutMs = 180_000) {
  // 1. 发送消息
  const msg = await json(`/session/${sessionID}/message`, "POST", {
    agent,
    parts: [{ type: "text", text: content }],
  })
  console.log(`  📤 发送到 ${agent}, messageID: ${msg.id}`)

  // 2. 轮询等待 assistant 消息出现（每 3 秒检查一次）
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await sleep(3000)
    const messages = await json(`/session/${sessionID}/message`)
    // 找最后一个 assistant 消息
    const assistantMsgs = messages.filter(m => m.role === "assistant" && m.agent === agent)
    if (assistantMsgs.length > 0) {
      const last = assistantMsgs[assistantMsgs.length - 1]
      // 检查是否有文本回复（可能还在处理中，文本为空）
      const textParts = last.parts?.filter(p => p.type === "text") || []
      const toolParts = last.parts?.filter(p => p.type === "tool-invocation") || []
      
      // 如果有文本内容，或者有工具调用结果，说明处理完成
      if (textParts.some(p => p.text && p.text.length > 10) || toolParts.length > 0) {
        const summary = textParts.map(p => p.text).join("\n").slice(0, 300)
        console.log(`  📥 ${agent} 回复: ${summary.slice(0, 200)}...`)
        return last
      }
    }
  }
  throw new Error(`${agent} 超时 (${timeoutMs / 1000}s)`)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function checkFileExists(sessionID, path) {
  try {
    const resp = await fetch(`${BASE}/session/${sessionID}/file?path=${encodeURIComponent(path)}`)
    return resp.ok
  } catch {
    return false
  }
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log("🚀 多 Agent 协作工作流测试\n")
  console.log("=" .repeat(60))

  // Step 0: 创建 session
  console.log("\n📋 Step 0: 创建工作流 session")
  const session = await json("/session", "POST", { title: "multi-agent-workflow-demo" })
  const SID = session.id
  console.log(`  Session: ${SID}`)

  // Step 1: 创建 5 个 agents
  console.log("\n📋 Step 1: 创建 5 个协作 agents")
  
  const agents = [
    {
      name: "requirement-agent",
      description: "引导用户梳理需求，产出 requirement.md",
      mode: "primary",
      prompt: `你是一位资深的需求工程师。你的职责是引导用户梳理和明确软件需求。

工作流程：
1. 询问用户想要构建什么功能/产品
2. 通过提问帮助用户明确：目标用户、核心功能、非功能需求、约束条件
3. 确认需求后，使用 write 工具将需求文档写入 /workspace/requirement.md
4. requirement.md 格式应包含：背景、目标用户、功能需求列表、非功能需求、约束条件、验收标准

注意：
- 每次只问 1-2 个问题，不要一次问太多
- 确认所有关键信息后再写文件
- 写完文件后告知用户需求文档已生成`,
      permission: [
        { permission: "write", pattern: "/workspace/requirement.md", action: "allow" },
        { permission: "read", pattern: "/workspace/*", action: "allow" },
        { permission: "edit", pattern: "/workspace/*", action: "deny" },
        { permission: "shell", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
      ]
    },
    {
      name: "design-agent",
      description: "根据 requirement.md 设计技术方案，产出 design.md",
      mode: "primary",
      prompt: `你是一位资深的技术架构师。你的职责是根据需求文档设计技术方案。

工作流程：
1. 首先使用 read 工具读取 /workspace/requirement.md
2. 分析需求，提出技术方案，包含：技术栈、架构、关键模块、数据流
3. 与用户讨论，回答技术问题
4. 确认方案后，使用 write 工具将技术方案写入 /workspace/design.md
5. design.md 格式应包含：方案概述、技术栈选型、系统架构、模块设计、接口定义、数据模型

注意：
- 方案要具体可执行
- 考虑性能、安全、可维护性
- 写完文件后告知用户技术方案已生成`,
      permission: [
        { permission: "write", pattern: "/workspace/design.md", action: "allow" },
        { permission: "read", pattern: "/workspace/*", action: "allow" },
        { permission: "edit", pattern: "/workspace/*", action: "deny" },
        { permission: "shell", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
      ]
    },
    {
      name: "task-planner-agent",
      description: "根据 design.md 生成执行任务列表，产出 task.md",
      mode: "primary",
      prompt: `你是一位资深的项目经理。你的职责是根据技术方案生成可执行的任务列表。

工作流程：
1. 首先使用 read 工具读取 /workspace/requirement.md 和 /workspace/design.md
2. 根据技术方案拆分为具体的开发任务
3. 每个任务包含：任务ID、任务名称、描述、优先级(P0/P1/P2)、依赖关系、验收标准
4. 使用 write 工具将任务列表写入 /workspace/task.md
5. task.md 格式应包含：项目概述、任务列表（按优先级排序）、里程碑

注意：
- 任务粒度适中，每个任务应在 2-8 小时内完成
- 明确任务间的依赖关系
- 写完文件后告知用户任务列表已生成`,
      permission: [
        { permission: "write", pattern: "/workspace/task.md", action: "allow" },
        { permission: "read", pattern: "/workspace/*", action: "allow" },
        { permission: "edit", pattern: "/workspace/*", action: "deny" },
        { permission: "shell", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
      ]
    },
    {
      name: "code-agent",
      description: "根据 task.md 生成代码实现",
      mode: "primary",
      prompt: `你是一位资深的全栈开发工程师。你的职责是根据任务列表生成高质量代码。

工作流程：
1. 首先使用 read 工具读取 /workspace/task.md、/workspace/design.md 和 /workspace/requirement.md
2. 按任务优先级逐个实现
3. 使用 write 工具创建代码文件
4. 每完成一个任务，简要说明实现内容
5. 代码应遵循最佳实践：类型安全、错误处理、清晰的命名

注意：
- 代码要完整可运行，不要省略
- 遵循技术方案中的架构设计
- 写完每个文件后简要说明`,
      permission: [
        { permission: "write", pattern: "/workspace/src/**", action: "allow" },
        { permission: "write", pattern: "/workspace/package.json", action: "allow" },
        { permission: "write", pattern: "/workspace/tsconfig.json", action: "allow" },
        { permission: "write", pattern: "/workspace/*.config.*", action: "allow" },
        { permission: "edit", pattern: "/workspace/**", action: "allow" },
        { permission: "read", pattern: "/workspace/**", action: "allow" },
        { permission: "shell", pattern: "*", action: "allow" },
        { permission: "task", pattern: "*", action: "deny" },
      ]
    },
    {
      name: "review-agent",
      description: "Review 代码，生成 review 报告",
      mode: "primary",
      prompt: `你是一位严谨的代码审查专家。你的职责是审查代码质量并生成 review 报告。

工作流程：
1. 首先使用 read 工具读取 /workspace/requirement.md 和 /workspace/design.md 了解项目背景
2. 使用 glob 和 read 工具查看 /workspace/src/ 下的所有代码文件
3. 从以下维度进行审查：
   - 功能正确性：代码是否实现了需求
   - 代码质量：命名、结构、可读性
   - 安全性：是否有安全漏洞
   - 性能：是否有性能问题
   - 最佳实践：是否遵循语言/框架最佳实践
4. 使用 write 工具将 review 报告写入 /workspace/review-report.md
5. 报告格式：每个问题标注严重级别(Critical/Major/Minor/Suggestion)

注意：
- 审查要具体，给出代码位置和修改建议
- 区分严重问题和建议性改进
- 写完报告后给用户一个总结`,
      permission: [
        { permission: "write", pattern: "/workspace/review-report.md", action: "allow" },
        { permission: "read", pattern: "/workspace/**", action: "allow" },
        { permission: "glob", pattern: "/workspace/**", action: "allow" },
        { permission: "grep", pattern: "/workspace/**", action: "allow" },
        { permission: "edit", pattern: "/workspace/*", action: "deny" },
        { permission: "shell", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
      ]
    },
  ]

  for (const agent of agents) {
    const result = await json(`/session/${SID}/agents/create`, "POST", agent)
    console.log(`  ✅ ${result.name} (${result.mode}, ${result.permission?.length || 0} perms)`)
  }

  // Verify agents
  const allAgents = await json(`/session/${SID}/agents`)
  const customAgents = allAgents.filter(a => ["requirement-agent", "design-agent", "task-planner-agent", "code-agent", "review-agent"].includes(a.name))
  console.log(`\n  验证: ${customAgents.length}/5 agents 已创建`)

  // ============================================================
  // Step 2: requirement-agent
  // ============================================================
  console.log("\n" + "=".repeat(60))
  console.log("📋 Step 2: requirement-agent 生成需求文档")
  console.log("-".repeat(60))
  
  await sendAndWait(SID, "requirement-agent",
    "我想做一个简易的待办事项(Todo) Web应用。\n\n" +
    "核心功能：\n- 添加待办事项\n- 标记完成/未完成\n- 删除待办事项\n- 按状态筛选(全部/进行中/已完成)\n\n" +
    "非功能需求：\n- 响应式设计，支持手机和桌面\n- 支持暗色模式\n- 数据持久化到 localStorage\n\n" +
    "技术约束：\n- 纯前端实现，不需要后端\n- 使用 React + TypeScript\n\n" +
    "请直接整理成需求文档，写入 /workspace/requirement.md"
  )

  // ============================================================
  // Step 3: design-agent
  // ============================================================
  console.log("\n" + "=".repeat(60))
  console.log("📋 Step 3: design-agent 生成技术方案")
  console.log("-".repeat(60))
  
  await sendAndWait(SID, "design-agent",
    "请读取 /workspace/requirement.md，根据需求设计技术方案，直接写入 /workspace/design.md。" +
    "方案要包含：技术栈、组件设计、数据模型、状态管理方案。不需要讨论，直接生成。"
  )

  // ============================================================
  // Step 4: task-planner-agent
  // ============================================================
  console.log("\n" + "=".repeat(60))
  console.log("📋 Step 4: task-planner-agent 生成任务列表")
  console.log("-".repeat(60))
  
  await sendAndWait(SID, "task-planner-agent",
    "请读取 /workspace/requirement.md 和 /workspace/design.md，根据需求和设计生成开发任务列表，" +
    "直接写入 /workspace/task.md。每个任务要具体可执行。"
  )

  // ============================================================
  // Step 5: code-agent
  // ============================================================
  console.log("\n" + "=".repeat(60))
  console.log("📋 Step 5: code-agent 生成代码")
  console.log("-".repeat(60))
  
  await sendAndWait(SID, "code-agent",
    "请读取 /workspace/task.md、/workspace/design.md 和 /workspace/requirement.md，" +
    "按任务列表实现代码。将所有代码文件写入 /workspace/src/ 目录。" +
    "先实现核心数据模型和组件，然后实现页面和样式。"
  , 300_000)  // 代码生成给更多时间

  // ============================================================
  // Step 6: review-agent
  // ============================================================
  console.log("\n" + "=".repeat(60))
  console.log("📋 Step 6: review-agent 审查代码")
  console.log("-".repeat(60))
  
  await sendAndWait(SID, "review-agent",
    "请审查 /workspace/src/ 下的所有代码，参考 /workspace/requirement.md 和 /workspace/design.md。" +
    "从功能正确性、代码质量、安全性、性能、最佳实践等维度进行审查。" +
    "将 review 报告写入 /workspace/review-report.md。"
  )

  // ============================================================
  // Step 7: 验证所有产物
  // ============================================================
  console.log("\n" + "=".repeat(60))
  console.log("📋 Step 7: 验证所有产物")
  console.log("-".repeat(60))

  // 获取所有消息
  const allMessages = await json(`/session/${SID}/message`)
  const agentMessages = {}
  for (const m of allMessages) {
    if (m.agent && m.role === "assistant") {
      if (!agentMessages[m.agent]) agentMessages[m.agent] = 0
      agentMessages[m.agent]++
    }
  }
  
  console.log("\n  Agent 消息统计:")
  for (const [name, count] of Object.entries(agentMessages)) {
    console.log(`    ${name}: ${count} 条 assistant 消息`)
  }

  console.log("\n  产物验证:")
  const artifacts = [
    "/workspace/requirement.md",
    "/workspace/design.md", 
    "/workspace/task.md",
    "/workspace/review-report.md",
  ]
  
  for (const artifact of artifacts) {
    // Check if any write tool call was made for this file
    const writeMsg = allMessages.find(m => 
      m.parts?.some(p => 
        p.type === "tool-invocation" && 
        p.toolInvocation?.toolName === "write" &&
        JSON.stringify(p.toolInvocation?.args)?.includes(artifact.split("/").pop())
      )
    )
    const status = writeMsg ? "✅" : "❓"
    console.log(`    ${status} ${artifact}`)
  }

  console.log("\n" + "=".repeat(60))
  console.log("🏁 工作流测试完成!")
  console.log(`   Session: ${SID}`)
  console.log("=".repeat(60))
}

main().catch(err => {
  console.error("❌ 错误:", err.message)
  process.exit(1)
})
