// 路径泄露防护 E2E — 真实开发流程（V2 SaaS）— docs/test-cases/session/path-leak-test.md 第四章
//
// 模拟生产流程：创建会话 → 拉取真实仓库 → AI 分析/开发/Review → exec 提交。
// 前提：SaaS 容器运行中；如需认证，完整 clone URL 经 GIT_REPO 环境变量注入。
// 运行：
//   OPENCODE_PASSWORD=... node docs/test-cases/scripts/path-leak-real-workflow-v2.mjs
import assert from "node:assert/strict"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14101").replace(/\/$/, "")
const MODEL = { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }
const GIT_REPO = process.env.GIT_REPO ?? "https://gitlab.shadow-rpa.net/frontend/xybot-front-home-v3.git"
const PROJECT_DIR = process.env.PROJECT_DIR ?? "/workspace/xybot-front-home-v3"
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

async function runShell(sessionID, command, label) {
  await api(`/api/session/${sessionID}/shell`, "POST", { command })
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    const list = await messages(sessionID)
    const shells = list.filter((m) => m.type === "shell" && m.command === command)
    const last = shells[shells.length - 1]
    if (last && last.status !== "running") {
      assert.notEqual(last.status, "running", `${label}: shell 未完成 (${last.status})`)
      return last
    }
    await sleep(1_000)
  }
  throw new Error(`shell 超时: ${label}`)
}

async function sendPrompt(sessionID, text, label) {
  console.log(`  📤 ${label}`)
  await api(`/api/session/${sessionID}/prompt`, "POST", { text, resume: true })
  await api(`/api/experimental/session/${sessionID}/wait`, "POST")
}

const allLeaks = []
const toolCalls = []

console.log("═".repeat(60))
console.log("  路径泄露测试 — 真实开发流程 (V2 SaaS)")
console.log("═".repeat(60))

next("WF-1/2 创建会话（权限 allow）")
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

next("WF-3 exec 拉取代码")
const cloneShell = await runShell(
  sid,
  `rm -rf ${PROJECT_DIR} && GIT_TERMINAL_PROMPT=0 timeout 180s git clone ${GIT_REPO} ${PROJECT_DIR} --depth 1 2>&1 && echo CLONE_OK`,
  "git clone",
)
const cloneOut = cloneShell.output?.output ?? ""
allLeaks.push(...scanLeaks(cloneShell.command, "exec/clone/command"), ...scanLeaks(cloneOut, "exec/clone/output"))
assert(cloneOut.includes("CLONE_OK"), `clone 失败: ${cloneOut.slice(0, 300)}`)
console.log(`  ✅ 代码已克隆到 ${PROJECT_DIR} (exit=${cloneShell.exit})`)

const lsShell = await runShell(sid, `ls ${PROJECT_DIR}/package.json && echo HAS_PKG`, "验证项目文件")
assert((lsShell.output?.output ?? "").includes("HAS_PKG"), "项目文件不存在")
console.log("  ✅ 项目文件验证通过")

next("WF-3.5 验证 SaaS session 根目录")
// SaaS sessions intentionally stay rooted at /workspace; sandbox paths are
// not host directories and must not be passed to session.move.
const sessionInfo = await api(`/api/session/${sid}`)
assert.equal(sessionInfo.data.location.directory, "/workspace")
console.log("  ✅ session 根目录仍为 /workspace；远端仓库通过其沙箱绝对路径访问")

next("WF-5 AI 需求分析")
await sendPrompt(
  sid,
  `请分析位于 ${PROJECT_DIR} 的项目技术栈和目录结构。用 glob 搜索 ${PROJECT_DIR}/src 下主要文件，用 read 读取 ${PROJECT_DIR}/package.json，告诉我这是什么项目、用了什么技术栈。`,
  "需求分析",
)
for (const m of await messages(sid)) for (const p of m.content ?? []) if (p.type === "tool") toolCalls.push(p.name)

next("WF-6 AI 开发")
await sendPrompt(
  sid,
  `请在 ${PROJECT_DIR} 中创建 ${PROJECT_DIR}/src/utils/formatDate.ts，导出函数 formatDate(date: Date): string，格式化日期为 YYYY-MM-DD HH:mm:ss。请先用 glob 查看 ${PROJECT_DIR}/src 目录，再用 write 创建文件。`,
  "开发 formatDate",
)
for (const m of await messages(sid)) for (const p of m.content ?? []) if (p.type === "tool") toolCalls.push(p.name)

next("WF-7 AI Review")
await sendPrompt(
  sid,
  `请 review 你刚才创建的 ${PROJECT_DIR}/src/utils/formatDate.ts。先用 read 读取，检查代码质量、类型安全、边界处理，给出改进建议。如果有问题请用 edit 修复。`,
  "Review 改动",
)
for (const m of await messages(sid)) for (const p of m.content ?? []) if (p.type === "tool") toolCalls.push(p.name)

next("WF-8 exec 提交代码")
await runShell(sid, `cd ${PROJECT_DIR} && git config user.email "test@opencode.dev" && git config user.name "Test"`, "git config")
const addShell = await runShell(sid, `cd ${PROJECT_DIR} && git add -A && git status --short`, "git add")
allLeaks.push(...scanLeaks(addShell.output?.output ?? "", "exec/git-add/output"))
const commitShell = await runShell(
  sid,
  `cd ${PROJECT_DIR} && git commit -m "feat(utils): add formatDate utility" && git log --oneline -3`,
  "git commit",
)
allLeaks.push(...scanLeaks(commitShell.output?.output ?? "", "exec/git-commit/output"))
assert(commitShell.exit === 0, `git commit 失败: ${(commitShell.output?.output ?? "").slice(0, 300)}`)
console.log(`  ✅ 代码已提交 (exit=${commitShell.exit})`)

next("WF-9 汇总检查路径泄露")
const list = await messages(sid)
console.log(`  📊 共 ${list.length} 条消息`)
console.log(`  🔧 工具调用: ${toolCalls.length} 次 — ${[...new Set(toolCalls)].join(", ")}`)
allLeaks.push(...collectLeaks(list))

const unique = []
const seen = new Set()
for (const leak of allLeaks) {
  const key = `${leak.match}|${leak.source}`
  if (!seen.has(key)) {
    seen.add(key)
    unique.push(leak)
  }
}
if (unique.length > 0) {
  console.log(`\n  ❌ 发现 ${unique.length} 处路径泄露:\n`)
  printLeaks(unique)
} else {
  console.log("  ✅ 未发现宿主机路径泄露")
}

console.log("\n" + "═".repeat(60))
if (unique.length === 0) {
  console.log(`  ✅ 真实开发流程测试通过 (session ${sid})`)
} else {
  console.log(`  ❌ 测试失败：${unique.length} 处泄露`)
  process.exitCode = 1
}
console.log("═".repeat(60))
