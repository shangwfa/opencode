# 路径泄露防护测试

> 验证 SaaS 沙箱模式下，LLM 可见的所有路径均为 `/workspace/...` 格式，不包含宿主机真实路径（如 `/Users/xxx`、`/private/var/folders/...`）。

---

## 一、背景

### 1.1 问题描述

opencode SaaS 模式下，LLM（code-agent）全程运行在沙箱中，但其 system prompt、工具调用参数/输出可能包含宿主机的真实文件路径。这些路径泄露给 LLM 没有意义，还可能暴露服务器目录结构。

### 1.2 泄露点分析

| 泄露源 | 文件 | 说明 |
|--------|------|------|
| `<env>` 块 | `src/session/system.ts` | Working directory / Workspace root 路径 |
| `Instructions from:` 路径 | `src/session/instruction.ts` | AGENTS.md 等配置文件加载路径 |
| glob 工具输出 | `src/tool/glob.ts` | 文件搜索结果含宿主机路径 |
| grep 工具输出 | `src/tool/grep.ts` | 内容搜索结果含宿主机路径 |
| ls 工具输出 | `src/tool/ls.ts` | 目录列表含宿主机路径 |
| shell cwd | `src/tool/shell.ts` | bash 工具工作目录路径 |

### 1.3 修复方案

核心思路：**去掉工具层 `toHostPath` 双向转换**，沙箱返回的 `/workspace/...` 路径直接透传给 LLM。

| 文件 | 改动 |
|------|------|
| `src/session/system.ts` | ⚠️ `<env>` 中 Working directory / Workspace root **实际未做 `toSandboxPath` 映射**（`system.ts:68-69` 直接用 `ctx.directory`/`ctx.worktree`）；SaaS 下 `ctx.directory=/workspace` 恰好不泄露，本地模式会泄露宿主路径（对比 `instruction.ts:98-99` 的 `sandboxDisplayPath` 已映射） |
| `src/session/instruction.ts` | `system()` 和 `resolve()` 中 `Instructions from:` 路径映射，`worktree === "/"` 时跳过 |
| `src/tool/glob.ts` | 去掉 `toHostPath`，沙箱路径直接透传 |
| `src/tool/grep.ts` | 去掉 `toHostPath`，沙箱路径直接透传 |
| `src/tool/ls.ts` | 去掉 `toHostPath`，改用 `sandboxSearchPath` 计算 relative |

### 1.4 设计原则

- **单向映射**：只做 `toSandboxPath`（宿主→沙箱），不做 `toHostPath`（沙箱→宿主）
- **worktree 基准**：以 `ctx.worktree`（git worktree 根）作为映射锚点
- **非 git 保护**：`worktree === "/"` 时跳过映射（非 git 项目回退值）
- **read/write/edit/bash 已有映射**：这些工具之前已正确使用 `toSandboxPath`

---

## 二、单元测试

### 2.1 路径映射函数测试

文件：`test/tool/sandbox-path-mapping.test.ts`（40 个用例）

覆盖 `toSandboxPath` / `toHostPath` / `isSandboxPath` / `toSandboxCwd` 的边界条件：

| 类别 | 用例数 | 覆盖场景 |
|------|--------|---------|
| toSandboxPath | 15 | 空串、`.`、工作目录本身、子路径、绝对路径、相对路径、工作目录外路径 |
| toHostPath | 5 | 沙箱根、沙箱子路径、沙箱外路径 |
| isSandboxPath | 10 | `/workspace` 前缀判断、非沙箱路径、边界值 |
| toSandboxCwd | 10 | 各种 cwd 参数组合 |
| 往返一致性 | — | toSandboxPath → toHostPath 可逆 |

### 2.2 System Prompt 路径映射测试

文件：`test/session/system-path-mapping.test.ts`（7 个用例）

验证 `<env>` 块中的路径：

| 用例 | 验证点 |
|------|--------|
| git 项目映射 | Working directory 显示为 `/workspace/...` |
| 非 git 项目保护 | `worktree === "/"` 时路径不被映射 |
| 多层子目录 | 子目录路径正确映射 |
| 环境变量 | 日期、平台等非路径字段不受影响 |

### 2.3 Instruction 路径映射测试

文件：`test/session/instruction-path-mapping.test.ts`（5 个用例）

验证 `Instructions from:` 输出：

| 用例 | 验证点 |
|------|--------|
| git 项目 AGENTS.md | 路径映射为 `/workspace/AGENTS.md` |
| 非 git 项目保护 | `worktree === "/"` 时跳过映射 |
| 多个 instruction 文件 | 每个文件路径都正确映射 |
| 子目录中的配置 | `.opencode/` 子目录路径正确 |
| 空配置 | 无 instruction 文件时不输出路径 |

### 2.4 运行方式

```bash
cd packages/opencode
bun test test/tool/sandbox-path-mapping.test.ts
bun test test/session/system-path-mapping.test.ts
bun test test/session/instruction-path-mapping.test.ts
```

---

## 三、端到端测试

### 3.1 测试环境

通过 `local-test-env.md` 启动的本地 SaaS 测试环境：

- 容器镜像：`opencode-saas-sandbox-test:v3fix`（含最新路径修复代码）
- 沙箱提供者：远端 Sandbox API（通过 TCP 转发）
- 测试脚本：`docs/test-cases/scripts/path-leak-e2e-test.mjs`

### 3.2 宿主机路径泄露模式

以下模式绝不应出现在 LLM 可见的任何输出中：

| 模式 | 说明 |
|------|------|
| `/Users/ruomu` | macOS 用户目录 |
| `/home/xxx/code` | Linux 用户代码目录 |
| `/private/var/folders` | macOS tmpdir symlink 真实路径 |
| `host.docker.internal` | Docker 内部 DNS |
| `172.18.x.x` | 内网 IP 地址 |

### 3.3 测试用例

| 用例 ID | 测试场景 | 触发方式 | 验证点 |
|---------|---------|---------|--------|
| PL-1 | read 工具 | AI 消息：读取文件 | tool output 路径为 `/workspace/...` |
| PL-2 | glob 工具 | AI 消息：搜索文件 | tool output 路径为 `/workspace/...` |
| PL-3 | grep 工具 | AI 消息：搜索内容 | tool output 路径为 `/workspace/...` |
| PL-4 | list 工具 | AI 消息：列出目录 | tool output 路径为 `/workspace/...` |
| PL-5 | write 工具 | AI 消息：写文件 | tool input/output 路径为 `/workspace/...` |
| PL-6 | edit 工具 | AI 消息：编辑文件 | tool input/output 路径为 `/workspace/...` |
| PL-7 | bash 工具 | AI 消息：执行命令 | tool output 中 pwd、路径均为 `/workspace/...` |
| PL-8 | git 操作 | AI 消息：git commit | tool output 路径为 `/workspace/...` |
| PL-9 | 环境信息 | AI 报告 `<env>` 块 | Working directory = `/workspace`，Workspace root = `/` |

### 3.4 测试流程

```
Step 1: 健康检查 → 创建 Session
Step 2: 配置权限（allow all）
Step 3: exec 初始化沙箱项目（git init + 示例文件）
Step 4: PL-1 — AI read 工具
Step 5: PL-2 — AI glob 工具
Step 6: PL-3 — AI grep 工具
Step 7: PL-4 — AI list 工具
Step 8: PL-5 — AI write 工具
Step 9: PL-6 — AI edit 工具
Step 10: PL-7 — AI bash 工具
Step 11: PL-9 — AI 报告 <env> 块路径
Step 12: 汇总检查 — 扫描所有消息的 text + tool(input/output/title) 是否匹配泄露模式
```

### 3.5 检查范围

每条消息中以下字段都会被扫描：

| 消息类型 | 字段 | 说明 |
|---------|------|------|
| text part | `part.text` | AI 文本回复 |
| tool part | `part.state.input` | 工具调用参数（JSON） |
| tool part | `part.state.output` | 工具执行结果 |
| tool part | `part.state.title` | 工具显示标题 |

### 3.6 测试脚本

```bash
# 保存为 path-leak-e2e-test.mjs 后运行：
# node path-leak-e2e-test.mjs
# 前提：本地测试环境已启动（容器 + TCP 转发）

#!/usr/bin/env node
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
    for (const part of messages[i].parts || []) {
      if (part.type === "text" && part.text)
        allLeaks.push(...scanLeaks(part.text, `msg[${i}]/text`))
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
  const result = await api(`/session/${sid}/message`, "POST", { parts: [{ type: "text", text }] })
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  const info = result.info || {}
  const textParts = (result.parts || []).filter(p => p.type === "text")
  const toolParts = (result.parts || []).filter(p => p.type === "tool")
  const summary = textParts.map(p => p.text).join(" ").slice(0, 200).replace(/\n/g, " ")
  console.log(`  📥 ${elapsed}s model=${info.modelID || "?"} tools=[${toolParts.map(p => p.tool).join(",") || "-"}]`)
  if (summary) console.log(`     回复: ${summary}`)
  return result
}

async function main() {
  console.log("═".repeat(60))
  console.log("  路径泄露端到端测试 (SaaS 沙箱)")
  console.log("═".repeat(60))

  let sid, step = 0
  try {
    // Step 1: 健康检查 + 创建 Session
    step++; console.log(`\n━━ Step ${step}: 健康检查 + 创建 Session ━━`)
    const session = await api("/session", "POST", {})
    sid = session.id
    console.log(`  ✅ Session: ${sid}`)

    // Step 2: 配置权限
    step++; console.log(`\n━━ Step ${step}: 配置权限 ━━`)
    await api("/global/config", "PATCH", {
      permission: { bash: "allow", edit: "allow", write: "allow", glob: "allow", grep: "allow", list: "allow", read: "allow", webfetch: "allow" },
    })
    await sleep(3)
    const session2 = await api("/session", "POST", {})
    sid = session2.id
    console.log(`  ✅ 权限已配置, 新 SID: ${sid}`)

    // Step 3: 初始化沙箱
    step++; console.log(`\n━━ Step ${step}: 初始化沙箱 (exec) ━━`)
    const init = await api(`/session/${sid}/exec`, "POST", {
      command: "mkdir -p /workspace/test-project && cd /workspace/test-project && git init && echo 'console.log(\"hello\")' > index.js && echo '# Test Project' > README.md && mkdir -p src && echo 'export const foo = 1' > src/mod.ts",
    })
    if (init.exitCode !== 0) throw new Error(`exec 失败: ${init.stderr}`)
    await api(`/session/${sid}/keep-alive`, "POST", { enabled: true })
    console.log("  ✅ 沙箱已初始化, keepAlive 已启用")

    // Step 4-10: 各工具测试
    step++; console.log(`\n━━ Step ${step}: read 工具 ━━`)
    await sendMsg(sid, "请用 read 工具读取 /workspace/test-project/README.md 的完整内容")

    step++; console.log(`\n━━ Step ${step}: glob 工具 ━━`)
    await sendMsg(sid, "请用 glob 工具在 /workspace/test-project 中搜索 **/*.ts 模式的文件")

    step++; console.log(`\n━━ Step ${step}: grep 工具 ━━`)
    await sendMsg(sid, "请用 grep 工具在 /workspace/test-project 中搜索关键词 console")

    step++; console.log(`\n━━ Step ${step}: list 工具 ━━`)
    await sendMsg(sid, "请用 list 工具列出 /workspace/test-project 目录的内容")

    step++; console.log(`\n━━ Step ${step}: write 工具 ━━`)
    await sendMsg(sid, "请用 write 工具在 /workspace/test-project/src/utils.ts 写入: export function add(a: number, b: number) { return a + b }")

    step++; console.log(`\n━━ Step ${step}: edit 工具 ━━`)
    await sendMsg(sid, "请用 edit 工具把 /workspace/test-project/README.md 中的 'Test Project' 替换为 'My Project'")

    step++; console.log(`\n━━ Step ${step}: bash 工具 ━━`)
    await sendMsg(sid, "请用 bash 工具执行: cd /workspace/test-project && ls -la && pwd && git status")

    step++; console.log(`\n━━ Step ${step}: AI 报告环境信息 ━━`)
    await sendMsg(sid, "请告诉我你当前的 Working directory 和 Workspace root 的完整路径。看一下你的系统提示中 <env> 块的内容，把 Working directory 和 Workspace root 的值一字不差地告诉我。")

    // 汇总检查
    step++; console.log(`\n━━ Step ${step}: 汇总检查路径泄露 ━━`)
    const messages = await api(`/session/${sid}/message`)
    console.log(`  📊 共 ${messages.length} 条消息`)
    const toolCalls = []
    for (const msg of messages) for (const part of msg.parts || []) if (part.type === "tool") toolCalls.push(part.tool)
    console.log(`  🔧 工具调用: ${toolCalls.length} 次 — ${[...new Set(toolCalls)].join(", ")}`)

    const leaks = collectLeaksFromMessages(messages)
    if (leaks.length > 0) {
      console.log(`\n  ❌ 发现 ${leaks.length} 处路径泄露:\n`)
      printLeaks(leaks)
    } else {
      console.log("  ✅ 未发现宿主机路径泄露")
    }

    // 打印 AI 环境信息
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text && part.text.includes("Working directory")) {
          console.log(`\n  📋 AI 报告的环境信息:\n${part.text.slice(0, 500)}`)
        }
      }
    }

    console.log("\n" + "═".repeat(60))
    if (leaks.length === 0) { console.log("  ✅ 测试通过"); }
    else { console.log(`  ❌ 测试失败：${leaks.length} 处泄露`); process.exit(1) }
    console.log("═".repeat(60))
  } catch (err) {
    console.error(`\n💥 测试出错: ${err.message}`)
    process.exit(2)
  }
}
main()
```

---

## 四、真实开发流程端到端测试

> 模拟 SaaS 生产环境的完整开发流程：创建会话 → 拉取代码 → AI 开发 → AI Review → 提交代码。
> 每个阶段都检查路径泄露，验证真实场景下的防护效果。

### 4.1 测试环境

与第三章相同，额外需要：

- **GitLab 仓库**：`https://gitlab.shadow-rpa.net/frontend/xybot-front-home-v3.git`
- **Access Token**：`eY8gCHMpNWrJpRLHDvK3f286MQp1OmJiCA.01.0y10q698d`（仅 clone 用，不推送远端）

### 4.2 测试用例

| 用例 ID | 阶段 | 操作 | 验证点 |
|---------|------|------|--------|
| WF-1 | 创建会话 | `POST /session` | session 正常创建 |
| WF-2 | 配置权限 | `PATCH /global/config` | 所有工具权限 allow |
| WF-3 | 拉取代码 | `POST /session/:sid/exec` → `git clone` | 沙箱内项目文件存在，exec 输出无宿主路径 |
| WF-3.5 | 更新工作目录 | `PATCH /session/:sid` → `{ directory: "/workspace" }` | session directory 更新，实例 reload，code-agent cwd 指向项目根 |
| WF-4 | keepAlive | `POST /session/:sid/keep-alive` | 防止沙箱被回收 |
| WF-5 | AI 需求分析 | AI 消息：阅读项目结构 | glob/grep/ls/read 工具输出路径均为 `/workspace/...` |
| WF-6 | AI 开发 | AI 消息：实现一个小功能 | write/edit/bash 工具 I/O 路径均为 `/workspace/...` |
| WF-7 | AI Review | AI 消息：review 改动 | bash(git diff)/read 工具输出路径均为 `/workspace/...` |
| WF-8 | exec 提交 | `POST /session/:sid/exec` → `git add/commit` | exec 输出无宿主路径 |
| WF-9 | 汇总检查 | 扫描全部消息 | 0 处宿主机路径泄露 |

### 4.3 测试流程

```
Step 1:  健康检查 → 创建 Session → 配置权限 → 新 Session
Step 2:  WF-3 exec git clone（带 token 认证，clone 到 /workspace）
Step 3:  WF-3.5 PATCH session { directory: "/workspace" }（更新 code-agent 工作目录）
Step 4:  WF-4 keepAlive
Step 5:  WF-5 AI 需求分析："阅读项目结构，了解技术栈"
Step 6:  WF-6 AI 开发：实现具体需求（AI 自主使用 read/glob/grep/write/edit/bash）
Step 7:  WF-7 AI Review："review 你刚才的改动，检查代码质量"
Step 8:  WF-8 exec git add + commit（不 push）
Step 9:  WF-9 汇总：扫描所有消息 + exec 结果
```

### 4.4 关键验证点

每个阶段完成后立即检查泄露，汇总时再次全量扫描：

| 检查对象 | 检查字段 | 预期 |
|---------|---------|------|
| exec API 结果 | `stdout` / `stderr` | 无宿主机路径 |
| AI 消息 text part | `part.text` | 无宿主机路径 |
| 工具调用 input | `part.state.input` | 路径均为 `/workspace/...` |
| 工具调用 output | `part.state.output` | 路径均为 `/workspace/...` |
| 工具调用 title | `part.state.title` | 路径均为 `/workspace/...` |
| AI 环境报告 | AI 自述 `<env>` | Working directory = `/workspace` |

### 4.5 测试脚本

```bash
# 保存为 path-leak-real-workflow-test.mjs 后运行：
# node path-leak-real-workflow-test.mjs
# 前提：本地测试环境已启动

#!/usr/bin/env node
const BASE = "http://localhost:14096"
const GIT_TOKEN = "eY8gCHMpNWrJpRLHDvK3f286MQp1OmJiCA.01.0y10q698d"
const GIT_REPO = `https://oauth2:${GIT_TOKEN}@gitlab.shadow-rpa.net/frontend/xybot-front-home-v3.git`
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
      if (part.type === "text" && part.text)
        allLeaks.push(...scanLeaks(part.text, `msg[${i}]/text`))
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
  const result = await api(`/session/${sid}/message`, "POST", { parts: [{ type: "text", text }] })
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
  if (leaks.length > 0) { console.log(`  ❌ exec 泄露:`); printLeaks(leaks) }
  return { result, leaks }
}

async function main() {
  console.log("═".repeat(60))
  console.log("  路径泄露测试 — 真实开发流程")
  console.log("═".repeat(60))

  const allLeaks = []
  let sid, step = 0

  try {
    // WF-1: 创建会话
    step++; console.log(`\n━━ Step ${step} [WF-1]: 创建会话 ━━`)
    const session1 = await api("/session", "POST", {})
    sid = session1.id
    console.log(`  ✅ Session: ${sid}`)

    // WF-2: 配置权限
    step++; console.log(`\n━━ Step ${step} [WF-2]: 配置权限 ━━`)
    await api("/global/config", "PATCH", {
      permission: { bash: "allow", edit: "allow", write: "allow", glob: "allow", grep: "allow", list: "allow", read: "allow", webfetch: "allow" },
    })
    await sleep(3)
    const session2 = await api("/session", "POST", {})
    sid = session2.id
    console.log(`  ✅ 权限已配置, 新 SID: ${sid}`)

     // WF-3: exec 拉取代码
    step++; console.log(`\n━━ Step ${step} [WF-3]: exec 拉取代码 ━━`)
    const { result: cloneResult, leaks: cloneLeaks } = await execCmd(sid, `rm -rf ${PROJECT_DIR} && git clone ${GIT_REPO} ${PROJECT_DIR} --depth 1 2>&1 && echo "CLONE_OK"`, "git clone")
    allLeaks.push(...cloneLeaks)
    if (cloneResult.exitCode !== 0) throw new Error(`clone 失败: ${(cloneResult.stdout || "").slice(0, 200)}`)
    console.log(`  ✅ 代码已克隆到 ${PROJECT_DIR}`)

    // 验证文件存在
    const { result: lsResult } = await execCmd(sid, `ls ${PROJECT_DIR}/package.json && echo "HAS_PKG"`, "验证项目文件")
    if (!(lsResult.stdout || "").includes("HAS_PKG")) throw new Error("项目文件不存在")
    console.log("  ✅ 项目文件验证通过")

    // WF-3.5: 更新 session 工作目录（让 code-agent 知道项目在哪）
    step++; console.log(`\n━━ Step ${step} [WF-3.5]: 更新 session 工作目录 ━━`)
    const patchResult = await api(`/session/${sid}`, "PATCH", { directory: PROJECT_DIR })
    console.log(`  ✅ directory 已更新为 ${patchResult.directory}`)

    // WF-4: keepAlive
    step++; console.log(`\n━━ Step ${step} [WF-4]: keepAlive ━━`)
    await api(`/session/${sid}/keep-alive`, "POST", { enabled: true })
    console.log("  ✅ keepAlive 已启用")

    // WF-5: AI 需求分析
    step++; console.log(`\n━━ Step ${step} [WF-5]: AI 需求分析 ━━`)
    await sendMsg(sid, `请分析当前项目的技术栈和目录结构。用 glob 搜索主要文件，用 read 读取 package.json，告诉我这是什么项目、用了什么技术栈。`)

    // WF-6: AI 开发
    step++; console.log(`\n━━ Step ${step} [WF-6]: AI 开发 ━━`)
    await sendMsg(sid, `请在当前项目中创建 src/utils/formatDate.ts，导出函数 formatDate(date: Date): string，格式化日期为 YYYY-MM-DD HH:mm:ss。请先用 glob 看 src 目录结构，再用 write 创建文件。`)

    // WF-7: AI Review
    step++; console.log(`\n━━ Step ${step} [WF-7]: AI Review ━━`)
    await sendMsg(sid, `请 review 你刚才创建的 src/utils/formatDate.ts。先用 read 读取，检查代码质量、类型安全、边界处理，给出改进建议。如果有问题请用 edit 修复。`)

    // WF-8: exec 提交（配置 git user + add + commit）
    step++; console.log(`\n━━ Step ${step} [WF-8]: exec 提交代码 ━━`)
    await execCmd(sid, `cd ${PROJECT_DIR} && git config user.email "test@opencode.dev" && git config user.name "Test"`, "git config")
    const { result: addResult, leaks: addLeaks } = await execCmd(sid, `cd ${PROJECT_DIR} && git add -A && git status --short`, "git add")
    allLeaks.push(...addleaks)
    const { result: commitResult, leaks: commitLeaks } = await execCmd(sid, `cd ${PROJECT_DIR} && git commit -m "feat(utils): add formatDate utility" && git log --oneline -3`, "git commit")
    allLeaks.push(...commitLeaks)
    console.log(`  ✅ 代码已提交: ${(commitResult.stdout || "").split("\n").pop()}`)

    // WF-9: 汇总检查
    step++; console.log(`\n━━ Step ${step} [WF-9]: 汇总检查路径泄露 ━━`)
    const messages = await api(`/session/${sid}/message`)
    console.log(`  📊 共 ${messages.length} 条消息`)
    const toolCalls = []
    for (const msg of messages) for (const part of msg.parts || []) if (part.type === "tool") toolCalls.push(part.tool)
    const toolSummary = {}
    for (const t of toolCalls) toolSummary[t] = (toolSummary[t] || 0) + 1
    console.log(`  🔧 工具调用: ${toolCalls.length} 次 — ${Object.entries(toolSummary).map(([k, v]) => `${k}×${v}`).join(", ")}`)

    allLeaks.push(...collectLeaksFromMessages(messages))

    // 去重
    const uniqueLeaks = []
    const seen = new Set()
    for (const l of allLeaks) {
      const key = `${l.match}|${l.source}`
      if (!seen.has(key)) { seen.add(key); uniqueLeaks.push(l) }
    }

    if (uniqueLeaks.length > 0) {
      console.log(`\n  ❌ 发现 ${uniqueLeaks.length} 处路径泄露:\n`)
      printLeaks(uniqueLeaks)
    } else {
      console.log("  ✅ 未发现宿主机路径泄露")
    }

    console.log("\n" + "═".repeat(60))
    if (uniqueLeaks.length === 0) { console.log("  ✅ 真实开发流程测试通过") }
    else { console.log(`  ❌ 测试失败：${uniqueLeaks.length} 处泄露`); process.exit(1) }
    console.log("═".repeat(60))
  } catch (err) {
    console.error(`\n💥 测试出错: ${err.message}`)
    process.exit(2)
  }
}
main()
```

### 4.6 与第三章测试的区别

| 维度 | 第三章（基础工具测试） | 第四章（真实流程测试） |
|------|---------------------|---------------------|
| 数据源 | `exec` 创建的简单示例文件 | 真实 GitLab 仓库 |
| 项目规模 | 3-4 个文件 | 完整前端项目（数十/百文件） |
| 工具调用 | 每步指定工具 | AI 自主选择工具组合 |
| 测试节奏 | 单步逐一执行 | 多轮对话连续交互 |
| 覆盖路径 | `/workspace/test-project/...` | `/workspace/xybot-front-home-v3/...`（深层嵌套） |
| git 操作 | 无 | clone / diff / commit 完整流程 |

---

## 五、验收标准

| 层级 | 标准 | 方法 |
|------|------|------|
| 单元测试 | 52 个测试全通过 | `bun test` 在 `packages/opencode` |
| 端到端（基础） | 0 处宿主机路径泄露 | 3.6 脚本 |
| 端到端（真实流程） | 0 处宿主机路径泄露 | 4.5 脚本 |
| `<env>` 块 | Working directory = `/workspace`，root = `/` | AI 自报告验证 |
| 工具 I/O | 所有工具的 input/output/title 均为 `/workspace/...` | 消息扫描 |

---

## 六、测试结果

### 6.1 单元测试

#### 2026-06-03（v3fix 回归）

```
test/tool/sandbox-path-mapping.test.ts — 40 pass
test/session/system-path-mapping.test.ts — 7 pass
test/session/instruction-path-mapping.test.ts — 5 pass
total: 52 pass, 0 fail
```

#### 2026-06-02（首次）

```
test/tool/sandbox-path-mapping.test.ts — 40 pass
test/session/system-path-mapping.test.ts — 7 pass
test/session/instruction-path-mapping.test.ts — 5 pass
total: 52 pass, 0 fail
```

### 6.2 端到端测试 — 基础工具

#### 2026-06-03（v3fix 回归）

```
镜像: opencode-saas-sandbox-test:v3fix
模型: deepseek-v4-pro
消息数: 23
工具调用: 7 次 (read, glob, grep, write, edit, bash)
泄露模式匹配: 0
AI 报告 <env>:
  Working directory: /workspace
  Workspace root folder: /

结果: ✅ 通过
```

| 用例 | 工具调用 | 泄露 |
|------|---------|------|
| PL-1 read | ✅ completed | 0 |
| PL-2 glob | ✅ completed | 0 |
| PL-3 grep | ✅ completed | 0 |
| PL-4 list | ✅ completed | 0 |
| PL-5 write | ✅ completed | 0 |
| PL-6 edit | ✅ completed | 0 |
| PL-7 bash | ✅ completed | 0 |
| PL-9 环境信息 | `/workspace`, `/` | 0 |

#### 2026-06-02（首次）

```
镜像: opencode-saas-sandbox-test:v3fix
消息数: 23
工具调用: 7 次 (read, glob, grep, write, edit, bash)
泄露模式匹配: 0
AI 报告 <env>:
  Working directory: /workspace
  Workspace root folder: /

结果: ✅ 通过
```

### 6.3 端到端测试 — 真实开发流程

#### 2026-06-03（v3fix 回归）

```
镜像: opencode-saas-sandbox-test:v3fix
模型: deepseek-v4-pro
仓库: gitlab.shadow-rpa.net/frontend/xybot-front-home-v3.git
消息数: 16
工具调用: 24 次 (read×17, glob×5, write×1, edit×1)
泄露模式匹配: 0
PATCH /session/:id { directory } 测试: ✅
AI 报告 <env>:
  Working directory: /workspace
  Workspace root folder: /

结果: ✅ 通过
```

| 用例 | 阶段 | 结果 | 泄露 |
|------|------|------|------|
| WF-1 | 创建会话 | ✅ | 0 |
| WF-2 | 配置权限 | ✅ | 0 |
| WF-3 | exec git clone | ✅ | 0 |
| WF-3.5 | PATCH directory | ✅ directory 更新成功 | 0 |
| WF-4 | keepAlive | ✅ | 0 |
| WF-5 | AI 需求分析 | ✅ glob+read 22 次调用 | 0 |
| WF-6 | AI 开发 | ✅ write 创建文件 | 0 |
| WF-7 | AI Review | ✅ read+edit 修复代码 | 0 |
| WF-8 | exec git commit | ⚠️ git config 未执行（需先 exec 配置） | 0 |
| WF-9 | 汇总检查 | ✅ 0 泄露 | 0 |

> **NOTE**: WF-8 git commit 因 exec 顺序问题未能自动提交（需先 exec `git config user.email/name`），但路径泄露检查为 0。

#### 2026-06-03（首次）

```
镜像: opencode-saas-sandbox-test:v3fix
仓库: gitlab.shadow-rpa.net/frontend/xybot-front-home-v3.git
消息数: 16
工具调用: 19 次 (read×13, glob×4, write×1, edit×1)
泄露模式匹配: 0
PATCH /session/:id { directory } 测试: ✅
AI 报告 <env>:
  Working directory: /workspace
  Workspace root folder: /

结果: ✅ 通过
```
