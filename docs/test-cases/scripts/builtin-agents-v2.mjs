// V2 内置 Agent 契约（文档 Agents / Builtins / Hidden / Disabled）
//
// 覆盖：内置 Agent 矩阵、hidden 与 subagent-mode 的可辨识性、general/explore 默认权限、
// 覆盖内置 Agent 为追加语义、disabled 移除内置、以及"隐藏 Agent 是否可被显式选择"的实际行为。
//
// 本脚本只做 API 与权限决策层断言，不调用模型；subagent 目录（工具描述）中隐藏 Agent
// 的过滤没有对应 HTTP 接口，由 packages/core 单测覆盖，见 builtin-agents.md。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://localhost:14096").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}

function check(ok, description) {
  assert(ok, `FAIL: ${description}`)
  console.log(`PASS: ${description}`)
}
function pg(sql) {
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`psql verification failed: ${result.stderr}`)
  return result.stdout.trim()
}
const quote = (value) => `'${value.replaceAll("'", "''")}'`

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

const created = await api("/api/session", "POST", { title: "builtin-agents-v2" })
assert.equal(created.status, 200, `create session: ${created.status} ${created.text}`)
const sessionID = created.data.data.id
const second = await api("/api/session", "POST", { title: "builtin-agents-v2-selection" })
const secondID = second.data.data.id

try {
  const listAll = async () => (await api(`/api/session/${sessionID}/agents`)).data.data
  const find = (items, id) => items.find((item) => item.agent.id === id)
  const evaluate = async (agent, action, resources) => {
    const result = await api(`/api/session/${sessionID}/permission`, "POST", { action, resources, agent })
    assert.equal(result.status, 200, `evaluate ${agent} ${action}: ${result.text}`)
    return result.data.data.effect
  }

  let agents = await listAll()

  // T62.1 内置 Agent 矩阵
  const expected = {
    build: { mode: "primary", hidden: false },
    plan: { mode: "primary", hidden: false },
    general: { mode: "subagent", hidden: false },
    explore: { mode: "subagent", hidden: false },
    compaction: { mode: "primary", hidden: true },
    summary: { mode: "primary", hidden: true },
    title: { mode: "primary", hidden: true },
  }
  for (const [id, spec] of Object.entries(expected)) {
    const agent = find(agents, id)
    check(agent !== undefined, `T62.1.1 内置 ${id} 存在`)
    check(agent?.agent.mode === spec.mode, `T62.1.2 内置 ${id} 的 mode 为 ${spec.mode}`)
    check(agent?.agent.hidden === spec.hidden, `T62.1.3 内置 ${id} 的 hidden 为 ${spec.hidden}`)
  }

  // T62.2 V2 没有内置 scout
  check(!find(agents, "scout"), "T62.2.1 V2 不提供内置 scout Agent")
  const builtinIDs = agents.filter((item) => item.source === "global").map((item) => item.agent.id)
  check(
    builtinIDs.every((id) => id in expected),
    `T62.2.2 内置 Agent 集合恰为 ${Object.keys(expected).join(", ")}`,
  )

  // T62.3 general 不能继续派生子 Agent
  check((await evaluate("general", "subagent", ["general"])) === "deny", "T62.3.1 general 的 subagent 规则为 deny")
  check((await evaluate("build", "subagent", ["general"])) !== "deny", "T62.3.2 build 不继承 general 的 subagent deny")

  // T62.4 explore 只读约束
  check((await evaluate("explore", "edit", ["/workspace/a.txt"])) === "deny", "T62.4.1 explore 拒绝 edit")
  check((await evaluate("explore", "shell", ["rm -rf /"])) === "deny", "T62.4.2 explore 拒绝 shell")
  check((await evaluate("explore", "read", ["/workspace/src/index.ts"])) === "allow", "T62.4.3 explore 允许 read")
  check((await evaluate("explore", "grep", ["TODO"])) === "allow", "T62.4.4 explore 允许 grep")
  check((await evaluate("explore", "read", ["/workspace/.env"])) === "ask", "T62.4.5 explore 对 .env 读取为 ask")

  // T62.5 build 的敏感环境文件读取需要审批
  check((await evaluate("build", "read", ["/workspace/.env"])) === "ask", "T62.5.1 build 读取 .env 为 ask")
  check((await evaluate("build", "read", ["/workspace/src/main.ts"])) === "allow", "T62.5.2 build 常规项目文件读取为 allow")

  // T62.6 覆盖内置 Agent 是追加而非替换其默认权限
  const before = (await listAll()).find((item) => item.agent.id === "build").agent.permissions.length
  await api(`/api/session/${sessionID}/agents`, "POST", {
    id: "build",
    config: { permissions: [{ action: "shell", resource: "git push *", effect: "ask" }] },
  })
  agents = await listAll()
  const build = find(agents, "build")
  check(
    build.agent.permissions.length === before + 1 && build.agent.permissions.some((rule) => rule.resource === "git push *"),
    "T62.6.1 Session 覆盖内置 build 追加规则而不替换整个权限数组",
  )
  check((await evaluate("build", "shell", ["git status"])) !== "deny", "T62.6.2 追加后 build 仍可执行常规 shell")
  if (PG_URL) {
    const stored = JSON.parse(
      pg(`SELECT config::jsonb FROM session_agents WHERE session_id=${quote(sessionID)} AND agent_id='build'`),
    )
    check(stored.permissions?.[0]?.resource === "git push *", "T62.6.3 内置 Agent 的 Session 覆盖持久化到 PostgreSQL")
  }

  // T62.7 disabled 移除内置 Agent
  check((await api(`/api/session/${sessionID}/agents`, "POST", { id: "plan", config: { disabled: true } })).status === 200, "T62.7.1 disabled 内置 plan 返回 200")
  check(!find(await listAll(), "plan"), "T62.7.2 disabled 之后 plan 不再出现在有效 Agent 列表")
  check((await api(`/api/session/${sessionID}/agents`, "DELETE")).status === 204, "T62.7.3 清空 Session 覆盖后 plan 恢复")
  check(find(await listAll(), "plan") !== undefined, "T62.7.4 清空覆盖后内置 plan 回到列表")

  // T62.8 隐藏 Agent 的列表与选择行为（当前实现的实际契约）
  check(find(await listAll(), "compaction") !== undefined, "T62.8.1 hidden 内置 Agent 仍出现在 API 有效列表")
  for (const id of ["title", "compaction", "summary"]) {
    const selected = await api(`/api/session/${secondID}/agent`, "POST", { agent: id })
    const session = await api(`/api/session/${secondID}`)
    check(selected.status === 204 && session.data.data.agent === id, `T62.8.2 POST /agent 接受隐藏 Agent ${id}（当前实现不做保留名校验）`)
  }

  // T62.9 选择 Agent 不改变会话已存模型
  const beforeModel = (await api(`/api/session/${secondID}`)).data.data.model
  await api(`/api/session/${secondID}/agent`, "POST", { agent: "plan" })
  const afterModel = (await api(`/api/session/${secondID}`)).data.data.model
  check(
    beforeModel?.providerID === afterModel?.providerID && beforeModel?.id === afterModel?.id,
    "T62.9.1 选择 primary Agent 不改变 Session 已保存的模型",
  )

  // T62.10 hidden 自定义 Agent 仍在列表中，由 subagent 目录过滤而非列表隐藏
  await api(`/api/session/${sessionID}/agents`, "POST", {
    id: "hidden-custom",
    config: { description: "hidden custom", mode: "subagent", hidden: true },
  })
  const hiddenCustom = find(await listAll(), "hidden-custom")
  check(hiddenCustom?.agent.hidden === true, "T62.10.1 hidden 自定义 Agent 保留在有效列表且 hidden 为 true")
} finally {
  await api(`/api/session/${secondID}`, "DELETE")
  await api(`/api/session/${sessionID}`, "DELETE")
  if (PG_URL) check(pg(`SELECT COUNT(*) FROM session_agents WHERE session_id=${quote(sessionID)}`) === "0", "清理：Session 删除级联 Agent 行")
}
