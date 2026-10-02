// V2 Agent 配置发现与合并契约（文档 Agents / Locations / Formats / Merging / Modes）
//
// 覆盖：全局 agents 目录 Markdown、JSONC agents 块、嵌套目录 Agent ID、
// Markdown body→system、model+variant 合并、request 逐键合并、全局 permissions、
// 三级来源字段级覆盖、沙箱优先于 Session、mode 省略默认 primary、mode: all、steps 校验。
//
// 前置：CONTAINER 指向以当前源码构建的可丢弃 SaaS 测试容器。脚本会改写该容器的
// ~/.config/opencode/opencode.jsonc 与 agents 目录，结束时必须原样还原；未设置
// CONTAINER 时输出 SKIP，不得记为通过。
import { execFileSync } from "node:child_process"
import assert from "node:assert/strict"

const BASE = (process.env.BASE ?? "http://localhost:14096").replace(/\/$/, "")
const CONTAINER = process.env.CONTAINER ?? process.env.OPENCODE_TEST_CONTAINER
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const GLOBAL_DIR = "/home/opencode/.config/opencode"
const CONFIG = `${GLOBAL_DIR}/opencode.jsonc`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(ok, description) {
  assert(ok, `FAIL: ${description}`)
  console.log(`PASS: ${description}`)
}
function skip(description, reason) {
  console.log(`SKIP: ${description} (${reason})`)
}

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = response.status === 204 ? "" : await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  return { status: response.status, data, text }
}

if (!CONTAINER) {
  skip("V2 Agent 配置发现与合并", "CONTAINER 未设置，无法安全改写测试容器配置")
  process.exit(0)
}

function inContainer(args, input) {
  return execFileSync("docker", ["exec", ...(input === undefined ? [] : ["-i"]), CONTAINER, ...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  })
}
const writeFile = (rel, content) =>
  inContainer(["sh", "-c", `mkdir -p "$(dirname '${GLOBAL_DIR}/${rel}')" && cat > '${GLOBAL_DIR}/${rel}'`], content)
const readFile = (rel) => inContainer(["cat", `${GLOBAL_DIR}/${rel}`])
const rmFile = (rel) => inContainer(["sh", "-c", `rm -rf '${GLOBAL_DIR}/${rel}'`])

const originalConfig = readFile("opencode.jsonc")
let sessionID

try {
  const created = await api("/api/session", "POST", { title: "config-agents-v2" })
  assert.equal(created.status, 200, `create session: ${created.status} ${created.text}`)
  sessionID = created.data.data.id
  const list = async () => {
    const result = await api(`/api/session/${sessionID}/agents`)
    assert.equal(result.status, 200, `list agents: ${result.text}`)
    return result.data.data
  }
  const find = (items, id) => items.find((item) => item.agent.id === id)
  // 配置目录写入经由 debounce 后的 watcher 重建 Agent 注册表；轮询避免依赖固定等待。
  const waitFor = async (id, timeout = 20_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const hit = find(await list(), id)
      if (hit) return hit
      await sleep(300)
    }
    return undefined
  }

  // T61.1 全局 ~/.config/opencode/agents/<name>.md
  writeFile(
    "agents/global-plain.md",
    "---\ndescription: T61.1 global agents directory\nmode: subagent\ncolor: \"#0a0b0c\"\n---\nGLOBAL_PLAIN_BODY\n",
  )
  const plain = await waitFor("global-plain")
  check(plain !== undefined, "T61.1.1 全局 ~/.config/opencode/agents/<name>.md 被发现")
  check(plain?.source === "global", "T61.1.2 全局 Agent 的 source 为 global")
  check(plain?.agent.system === "GLOBAL_PLAIN_BODY", "T61.1.3 Markdown body 成为 system prompt")
  check(plain?.agent.color === "#0a0b0c", "T61.1.4 Markdown frontmatter 标量字段生效")

  // T61.2 嵌套路径成为 Agent ID 的一部分
  writeFile("agents/team/nested-rev.md", "---\ndescription: T61.2 nested path\nmode: subagent\n---\nNESTED_BODY\n")
  const nested = await waitFor("team/nested-rev")
  check(nested !== undefined, "T61.2.1 .opencode/agents 之外的嵌套全局路径也生成嵌套 Agent ID")
  check(nested?.agent.id === "team/nested-rev" && nested.agent.system === "NESTED_BODY", "T61.2.2 嵌套 Agent ID 为 team/nested-rev")

  // T61.3 Markdown body 覆盖 frontmatter system
  writeFile(
    "agents/body-wins.md",
    "---\ndescription: T61.3 body wins\nmode: subagent\nsystem: FRONTMATTER_SYSTEM\n---\nBODY_WINS_SYSTEM\n",
  )
  check((await waitFor("body-wins"))?.agent.system === "BODY_WINS_SYSTEM", "T61.3.1 Markdown body 覆盖 frontmatter system")

  // T61.4 model 与 variant 分离键合并为 model#variant
  writeFile(
    "agents/model-variant.md",
    "---\ndescription: T61.4 model+variant\nmode: subagent\nmodel: Yd-DeepSeek/deepseek-v4-flash\nvariant: default\n---\nMV_BODY\n",
  )
  const mv = await waitFor("model-variant")
  check(
    mv?.agent.model?.providerID === "Yd-DeepSeek" && mv.agent.model?.id === "deepseek-v4-flash" && mv.agent.model?.variant === "default",
    "T61.4.1 分离的 model 与 variant 前置键合并为单条模型选择",
  )

  // T61.5 Markdown frontmatter 支持 request 嵌套对象
  writeFile(
    "agents/nested-object.md",
    '---\ndescription: T61.5 nested frontmatter object\nmode: subagent\nrequest:\n  headers:\n    x-from-md: "1"\n  body:\n    temperature: 0.1\n---\nNESTED_OBJECT_BODY\n',
  )
  const nestedObject = await waitFor("nested-object")
  check(
    nestedObject?.agent.request?.headers?.["x-from-md"] === "1" && nestedObject.agent.request?.body?.temperature === 0.1,
    "T61.5.1 Markdown frontmatter 的 request headers/body 嵌套对象被解码",
  )

  // T61.6 JSONC agents 块
  const parsed = JSON.parse(originalConfig)
  parsed.agents = {
    "jsonc-probe": { description: "T61.6 jsonc agents block", mode: "subagent", system: "JSONC_BLOCK_SYSTEM" },
  }
  writeFile("opencode.jsonc", JSON.stringify(parsed, null, 2))
  const jsonc = await waitFor("jsonc-probe")
  check(jsonc?.source === "global" && jsonc.agent.system === "JSONC_BLOCK_SYSTEM", "T61.6.1 opencode.jsonc 的 agents 块生效")

  // T61.7 request map 逐键合并（Markdown 与 JSONC 定义同一 Agent）
  parsed.agents["jsonc-probe"].request = { headers: { "x-shared": "jsonc", "x-jsonc-only": "1" } }
  writeFile("opencode.jsonc", JSON.stringify(parsed, null, 2))
  writeFile(
    "agents/jsonc-probe.md",
    '---\ndescription: T61.7 request merge\nmode: subagent\nrequest:\n  headers:\n    x-shared: md\n    x-md-only: "1"\n---\nREQUEST_MERGE_BODY\n',
  )
  // jsonc-probe 已由 JSONC 定义，此处必须等 Markdown 扫描完成后再断言合并结果。
  const deadline7 = Date.now() + 20_000
  let headers7 = {}
  while (Date.now() < deadline7) {
    headers7 = find(await list(), "jsonc-probe")?.agent.request?.headers ?? {}
    if (headers7["x-md-only"] !== undefined) break
    await sleep(300)
  }
  check(
    headers7["x-jsonc-only"] === "1" && headers7["x-md-only"] === "1",
    "T61.7.1 Markdown 与 JSONC 的 request headers 逐键合并而非互相替换",
  )
  check(headers7["x-shared"] === "md", "T61.7.2 request 同一键冲突时后加载的 Markdown 定义胜出")

  // T61.8 全局 permissions 先于 Agent 规则追加
  parsed.permissions = [{ action: "shell", resource: "*", effect: "ask" }]
  parsed.agents.build = { permissions: [{ action: "shell", resource: "git status", effect: "allow" }] }
  writeFile("opencode.jsonc", JSON.stringify(parsed, null, 2))
  const deadline8 = Date.now() + 20_000
  let buildAgent
  while (Date.now() < deadline8) {
    buildAgent = find(await list(), "build")
    if (buildAgent?.agent.permissions?.some((rule) => rule.resource === "git status")) break
    await sleep(300)
  }
  const shellRules = (buildAgent?.agent.permissions ?? []).filter((rule) => rule.action === "shell")
  const shellStar = shellRules.findIndex((rule) => rule.resource === "*")
  const shellGit = shellRules.findIndex((rule) => rule.resource === "git status")
  check(shellStar !== -1 && shellGit !== -1, "T61.8.1 全局 shell 规则与 Agent 级 shell 规则同时存在")
  check(shellStar < shellGit, "T61.8.2 全局 permissions 排在 Agent 规则之前，后写入的 Agent 规则可细化")

  // T61.9 Session Agent 省略 mode 时默认 primary
  await api(`/api/session/${sessionID}/agents`, "POST", { id: "mode-omitted", config: { description: "T61.9 omitted mode" } })
  check(find(await list(), "mode-omitted")?.agent.mode === "primary", "T61.9.1 新建自定义 Agent 省略 mode 时默认 primary")

  // T61.10 mode: all 被接受并保留
  await api(`/api/session/${sessionID}/agents`, "POST", { id: "mode-all", config: { description: "T61.10 all mode", mode: "all" } })
  check(find(await list(), "mode-all")?.agent.mode === "all", "T61.10.1 mode: all 通过 API 校验并保留")

  // T61.11 非法 mode 仍返回 400
  check(
    (await api(`/api/session/${sessionID}/agents`, "POST", { id: "mode-bad", config: { mode: "invalid" } })).status === 400,
    "T61.11.1 非法 mode 返回 400",
  )

  // T61.12 steps 必须是正整数
  for (const [value, label] of [
    [0, "0"],
    [-1, "负数"],
    [1.5, "小数"],
  ]) {
    const result = await api(`/api/session/${sessionID}/agents`, "POST", { id: `steps-${label}`, config: { steps: value } })
    check(result.status === 400, `T61.12.1 steps=${label} 返回 400`)
  }
  check(
    (await api(`/api/session/${sessionID}/agents`, "POST", { id: "steps-string", config: { steps: "3" } })).status === 400,
    "T61.12.2 steps 传字符串返回 400",
  )

  // T61.13 沙箱 Markdown 覆盖同 ID 的 Session Agent，字段级生效
  await api(`/api/session/${sessionID}/agents`, "POST", {
    id: "clash-probe",
    config: { description: "from session", mode: "subagent", system: "SESSION_SYSTEM", color: "#111111" },
  })
  const markdown = "---\ndescription: from sandbox\nmode: subagent\n---\nSANDBOX_SYSTEM\n"
  const encoded = Buffer.from(markdown).toString("base64")
  await api(`/api/session/${sessionID}/shell`, "POST", {
    command: `mkdir -p /workspace/.opencode/agents && printf '%s' '${encoded}' | base64 -d > /workspace/.opencode/agents/clash-probe.md`,
  })
  let clash
  const deadline13 = Date.now() + 60_000
  while (Date.now() < deadline13) {
    await api(`/api/session/${sessionID}/agents/refresh`, "POST", {})
    clash = find(await list(), "clash-probe")
    if (clash?.source === "sandbox") break
    await sleep(500)
  }
  check(clash?.source === "sandbox", "T61.13.1 沙箱 Agent 定义在同 ID 冲突时优先于 Session Agent")
  check(clash?.agent.system === "SANDBOX_SYSTEM", "T61.13.2 沙箱定义覆盖 Session 的 system")
  check(clash?.agent.color === "#111111", "T61.13.3 沙箱未声明的字段保留 Session Agent 的取值（字段级合并）")
} finally {
  execFileSync("docker", ["exec", "-i", CONTAINER, "sh", "-c", `cat > ${CONFIG}`], { encoding: "utf8", input: originalConfig })
  inContainer(["sh", "-c", `rm -rf '${GLOBAL_DIR}/agents'`])
  if (sessionID) await api(`/api/session/${sessionID}`, "DELETE")
  const restored = JSON.parse(readFile("opencode.jsonc"))
  check(!restored.agents && !restored.permissions && !restored.default_agent, "清理：测试容器全局配置已还原")
  const leftovers = inContainer(["sh", "-c", `ls -A '${GLOBAL_DIR}/agents' 2>/dev/null | wc -l`]).trim()
  check(leftovers === "0", "清理：测试容器全局 agents 目录已删除")
}
