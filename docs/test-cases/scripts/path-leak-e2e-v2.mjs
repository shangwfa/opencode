// 路径泄露防护 E2E（V2 SaaS）— docs/test-cases/session/path-leak-test.md 第三章
//
// 前提：
//   - SaaS 容器运行中（默认 http://127.0.0.1:14101，Basic Auth 口令经 OPENCODE_PASSWORD 注入）
//   - 容器经 host.docker.internal 连接沙箱 API；本脚本只访问 SaaS HTTP API
// 运行：
//   OPENCODE_PASSWORD=... node docs/test-cases/scripts/path-leak-e2e-v2.mjs
import assert from "node:assert/strict"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14101").replace(/\/$/, "")
const MODEL = { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }
const AUTH = process.env.OPENCODE_PASSWORD
  ? `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`
  : undefined

const LEAK_PATTERNS = [
  { re: /\/Users\/ruomu/gi, name: "macOS用户路径 /Users/ruomu" },
  { re: /\/private\/var\/folders/gi, name: "macOS tmp symlink /private/var/folders" },
  { re: /host\.docker\.internal/gi, name: "Docker host.docker.internal" },
  { re: /172\.18\.\d+\.\d+/g, name: "内网IP 172.18.x.x" },
]

async function api(path, method = "GET", body) {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(AUTH ? { authorization: AUTH } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await resp.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  assert(resp.ok, `${resp.status} ${path}: ${String(JSON.stringify(data)).slice(0, 300)}`)
  return data
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function scanLeaks(text, source) {
  if (!text || typeof text !== "string") return []
  const results = []
  for (const { re, name } of LEAK_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const idx = match.index
      results.push({
        pattern: name,
        match: match[0],
        source,
        context: text.slice(Math.max(0, idx - 30), idx + match[0].length + 30).replace(/\n/g, "\\n"),
      })
    }
  }
  return results
}

async function messages(sessionID) {
  const body = await api(`/api/session/${sessionID}/message?order=asc`)
  return body.data ?? body
}

function collectLeaks(messages) {
  const all = []
  messages.forEach((message, i) => {
    all.push(...scanLeaks(message.text, `msg[${i}](${message.type})/text`))
    if (message.type === "shell") {
      all.push(...scanLeaks(message.command, `msg[${i}](shell)/command`))
      all.push(...scanLeaks(message.output?.output, `msg[${i}](shell)/output`))
    }
    for (const part of message.content ?? []) {
      if (part.type === "text") all.push(...scanLeaks(part.text, `msg[${i}]/text-part`))
      if (part.type === "tool") {
        all.push(...scanLeaks(JSON.stringify(part.state.input ?? {}), `msg[${i}]/tool-input/${part.name}`))
        for (const content of part.state.content ?? []) {
          if (content.type === "text") all.push(...scanLeaks(content.text, `msg[${i}]/tool-output/${part.name}`))
        }
        all.push(...scanLeaks(part.state.error?.message, `msg[${i}]/tool-error/${part.name}`))
      }
    }
  })
  return all
}

function printLeaks(leaks) {
  for (const leak of leaks) {
    console.log(`  ❌ [${leak.source}] ${leak.pattern}: "${leak.match}"`)
    console.log(`     上下文: ...${leak.context}...`)
  }
}

let step = 0
const next = (label) => console.log(`\n━━ Step ${++step}: ${label} ━━`)

// 等待一条 shell 命令的消息生命周期闭环（不再处于 running）
async function runShell(sessionID, command, label) {
  await api(`/api/session/${sessionID}/shell`, "POST", { command })
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const list = await messages(sessionID)
    const shells = list.filter((m) => m.type === "shell" && m.command === command)
    const last = shells[shells.length - 1]
    if (last && last.status !== "running") {
      assert.notEqual(last.status, "running", `${label}: shell 未完成 (${last.status})`)
      return last
    }
    await sleep(500)
  }
  throw new Error(`shell 超时: ${label}`)
}

async function sendPrompt(sessionID, text, label) {
  console.log(`  📤 ${label}`)
  await api(`/api/session/${sessionID}/prompt`, "POST", { text, resume: true })
  await api(`/api/experimental/session/${sessionID}/wait`, "POST")
}

const toolCalls = []
async function usedTools(sessionID, since) {
  const list = (await messages(sessionID)).slice(since)
  const used = []
  for (const message of list) {
    for (const part of message.content ?? []) {
      if (part.type === "tool") {
        used.push(part.name)
        toolCalls.push(part.name)
      }
    }
  }
  return used
}

console.log("═".repeat(60))
console.log("  路径泄露端到端测试 (V2 SaaS 沙箱)")
console.log("═".repeat(60))

// Step 1: 创建会话（权限 allow + 模型）
next("创建会话")
const created = await api("/api/session", "POST", {
  location: { directory: "/workspace" },
  model: MODEL,
  permissions: ["bash", "edit", "write", "glob", "grep", "list", "read", "webfetch"].map((action) => ({
    action,
    resource: "*",
    effect: "allow",
  })),
})
const sid = created.data.id
console.log(`  ✅ Session: ${sid}`)

// Step 2: shell 初始化沙箱项目（git init + 示例文件）
next("exec 初始化沙箱项目")
const initShell = await runShell(
  sid,
  "mkdir -p /workspace/test-project && cd /workspace/test-project && git init -q && echo 'console.log(\"hello\")' > index.js && echo '# Test Project' > README.md && mkdir -p src && echo 'export const foo = 1' > src/mod.ts && echo INIT_OK",
  "初始化",
)
console.log(`  ✅ shell status=${initShell.status} exit=${initShell.exit}`)
const initLeaks = scanLeaks(initShell.output?.output ?? "", "shell-init/output")
printLeaks(initLeaks)
assert.equal(initLeaks.length, 0, "初始化 shell 输出泄露宿主机路径")

// Step 3-9: PL-1..PL-7 + PL-9
next("PL-1 read 工具")
let since = (await messages(sid)).length
await sendPrompt(sid, "请用 read 工具读取 /workspace/test-project/README.md 的完整内容，并告诉我文件内容。", "read README.md")
assert.ok((await usedTools(sid, since)).includes("read"), "AI 未使用 read 工具")

next("PL-2 glob 工具")
since = (await messages(sid)).length
await sendPrompt(sid, "请用 glob 工具在 /workspace/test-project 中搜索 **/*.ts 模式的文件。", "glob **/*.ts")
assert.ok((await usedTools(sid, since)).includes("glob"), "AI 未使用 glob 工具")

next("PL-3 grep 工具")
since = (await messages(sid)).length
await sendPrompt(
  sid,
  "请用 grep 工具在 /workspace/test-project 中搜索关键词 console。",
  "grep console",
)
assert.ok((await usedTools(sid, since)).includes("grep"), "AI 未使用 grep 工具")

next("PL-4 目录列举（V2 无 list 工具，用 glob * 覆盖）")
since = (await messages(sid)).length
await sendPrompt(sid, "请用 glob 工具在 /workspace/test-project 中用 * 模式列出根级文件和目录。", "glob * 列目录")
assert.ok((await usedTools(sid, since)).includes("glob"), "AI 未使用 glob 工具列目录")

next("PL-5 write 工具")
since = (await messages(sid)).length
await sendPrompt(
  sid,
  "请用 write 工具在 /workspace/test-project/src/utils.ts 写入: export function add(a: number, b: number) { return a + b }",
  "write utils.ts",
)
assert.ok((await usedTools(sid, since)).includes("write"), "AI 未使用 write 工具")

next("PL-6 edit 工具")
since = (await messages(sid)).length
await sendPrompt(
  sid,
  "请用 edit 工具把 /workspace/test-project/README.md 中的 'Test Project' 替换为 'My Project'。",
  "edit README.md",
)
assert.ok((await usedTools(sid, since)).includes("edit"), "AI 未使用 edit 工具")

next("PL-7 shell 工具（V1 bash 的 V2 名称）")
since = (await messages(sid)).length
await sendPrompt(
  sid,
  "请用 shell 工具执行: cd /workspace/test-project && ls -la && pwd && git status",
  "shell ls/pwd/git status",
)
assert.ok((await usedTools(sid, since)).includes("shell"), "AI 未使用 shell 工具")

next("PL-9 AI 报告 <env> 块")
since = (await messages(sid)).length
await sendPrompt(
  sid,
  "请告诉我你当前的 Working directory 和 Workspace root 的完整路径。看一下你的系统提示中 <env> 块的内容，把 Working directory 和 Workspace root 的值一字不差地告诉我。",
  "报告环境信息",
)

// Step 10: 汇总检查
next("汇总检查路径泄露")
const list = await messages(sid)
console.log(`  📊 共 ${list.length} 条消息`)
console.log(`  🔧 工具调用: ${toolCalls.length} 次 — ${[...new Set(toolCalls)].join(", ")}`)

const envReport = [...list]
  .reverse()
  .flatMap((m) => (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text))
  .find((text) => text && text.includes("Working directory"))
if (envReport) console.log(`\n  📋 AI 报告的环境信息:\n${envReport.slice(0, 400)}`)

const leaks = collectLeaks(list)
if (leaks.length > 0) {
  console.log(`\n  ❌ 发现 ${leaks.length} 处路径泄露:\n`)
  printLeaks(leaks)
} else {
  console.log("  ✅ 未发现宿主机路径泄露")
}

console.log("\n" + "═".repeat(60))
if (leaks.length === 0) {
  console.log(`  ✅ 测试通过 (session ${sid})`)
} else {
  console.log(`  ❌ 测试失败：${leaks.length} 处泄露`)
  process.exitCode = 1
}
console.log("═".repeat(60))
