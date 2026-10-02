// V2 Agent 运行时契约（文档 Agents / Selection / Modes / Steps / Model）
//
// 覆盖：default_agent 生效与回退链、修改 default_agent 不影响既有 Session、
// mode: all 同时支持 primary 与 subagent、steps 上限收敛与新输入重置额度。
//
// 需要真实模型调用与可丢弃的 SaaS 测试容器（脚本会改写容器全局配置的 default_agent）。
// 模型不可用时记为环境阻塞，不得把 provider error 或超时记作通过。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://localhost:14096").replace(/\/$/, "")
const CONTAINER = process.env.CONTAINER ?? process.env.OPENCODE_TEST_CONTAINER
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const rawModel = process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'
const parsedModel = JSON.parse(rawModel)
const MODEL = { providerID: parsedModel.providerID, id: parsedModel.id ?? parsedModel.modelID }
const GLOBAL_DIR = "/home/opencode/.config/opencode"
const CONFIG = `${GLOBAL_DIR}/opencode.jsonc`
const timeout = Number(process.env.AGENT_RUNTIME_TIMEOUT_MS ?? 180_000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(ok, description) {
  assert(ok, `FAIL: ${description}`)
  console.log(`PASS: ${description}`)
}
/** 已知缺陷项：记录但不中断脚本，最终汇总为失败，避免后续用例被跳过。 */
const knownDefects = []
function recordDefect(ok, description, detail) {
  if (ok) {
    console.log(`PASS: ${description}`)
    return
  }
  knownDefects.push(`${description}${detail ? ` —— ${detail}` : ""}`)
  console.log(`FAIL: ${description}${detail ? ` —— ${detail}` : ""}`)
}

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
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

/**
 * 消费一次 prompt_stream 的 SSE，返回事件列表。
 * 收到终态事件后立即停止读取：连接保持 keep-alive，等底层关闭会一直挂到超时。
 */
async function prompt(sessionID, text) {
  const streamed = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(timeout),
  })
  if (streamed.status !== 200) throw new Error(`prompt_stream HTTP ${streamed.status}: ${(await streamed.text()).slice(0, 300)}`)
  const controller = new AbortController()
  const stop = () => controller.abort()
  const events = []
  const reader = streamed.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ""
      for (const block of blocks) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
        if (!data || data === "[DONE]") continue
        try {
          events.push(JSON.parse(data))
        } catch {}
      }
      if (
        events.some(
          (event) =>
            event.type === "session.execution.succeeded" || event.type === "session.execution.failed",
        )
      )
        break
    }
  } finally {
    stop()
  }
  const types = events.map((event) => event.type)
  assert(types.includes("session.execution.succeeded"), `执行未成功；收到事件: ${types.join(", ")}`)
  assert(!types.includes("session.execution.failed"), "prompt 执行失败")
  return events
}

/**
 * 期望一次 prompt_stream 以 session.execution.failed 终结。
 * 与 `prompt` 一样在终态事件后停止读取，连接本身保持 keep-alive 不会关闭。
 */
async function promptFailure(sessionID, text) {
  const streamed = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(timeout),
  })
  if (streamed.status !== 200) throw new Error(`prompt_stream HTTP ${streamed.status}: ${(await streamed.text()).slice(0, 300)}`)
  const controller = new AbortController()
  const events = []
  const reader = streamed.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ""
      for (const block of blocks) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
        if (!data || data === "[DONE]") continue
        try {
          events.push(JSON.parse(data))
        } catch {}
      }
      if (events.some((event) => event.type === "session.execution.succeeded" || event.type === "session.execution.failed"))
        break
    }
  } finally {
    controller.abort()
  }
  const failure = events.find((event) => event.type === "session.execution.failed")
  return {
    failed: failure !== undefined,
    succeeded: events.some((event) => event.type === "session.execution.succeeded"),
    error: (failure?.properties ?? failure?.data ?? {}).error,
    types: events.map((event) => event.type),
  }
}

async function assistantTurns(sessionID) {
  const messages = await api(`/api/session/${sessionID}/message?order=asc`)
  return (messages.data.data ?? []).filter((message) => message.type === "assistant")
}
const turnText = (turn) =>
  (turn.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")

async function newSession(title, extra = {}) {
  const created = await api("/api/session", "POST", { title, location: { directory: "/workspace" }, model: MODEL, ...extra })
  assert.equal(created.status, 200, `create session ${title}: ${created.text}`)
  return created.data.data.id
}

if (!CONTAINER) {
  console.log("SKIP: Agent 运行时契约（CONTAINER 未设置，无法安全改写测试容器 default_agent）")
  process.exit(0)
}

function writeConfig(config) {
  execFileSync("docker", ["exec", "-i", CONTAINER, "sh", "-c", `cat > ${CONFIG}`], { encoding: "utf8", input: JSON.stringify(config, null, 2) })
}
const readConfig = () => JSON.parse(execFileSync("docker", ["exec", CONTAINER, "cat", CONFIG], { encoding: "utf8" }))

/** 改写全局配置并等待配置 watcher 完成重建。 */
async function applyConfig(mutate, expectID) {
  const config = readConfig()
  mutate(config)
  writeConfig(config)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const probe = await api("/api/session", "POST", { title: "agent-runtime-probe", model: MODEL })
    if (probe.status === 200) {
      const agents = await api(`/api/session/${probe.data.data.id}/agents`)
      const hit = (agents.data?.data ?? []).some((item) => item.agent.id === expectID)
      await api(`/api/session/${probe.data.data.id}`, "DELETE")
      if (hit) return
    }
    await sleep(500)
  }
  throw new Error(`配置未在超时内生效: ${expectID}`)
}

const originalConfig = execFileSync("docker", ["exec", CONTAINER, "cat", CONFIG], { encoding: "utf8" })
const sessions = []
const track = (id) => (sessions.push(id), id)

try {
  // T63.1 default_agent 决定未选择 Agent 的新会话
  await applyConfig(
    (config) => {
      config.default_agent = "runtime-default"
      config.agents = {
        ...(config.agents ?? {}),
        "runtime-default": { description: "T63.1 default agent", mode: "primary", system: "Always answer with RUNTIME_DEFAULT_MARKER." },
      }
    },
    "runtime-default",
  )
  const first = track(await newSession("T63.1 default agent"))
  check((await api(`/api/session/${first}`)).data.data.agent === undefined, "T63.1.1 新建会话未显式选择 Agent")
  await prompt(first, "State the marker only.")
  const firstTurn = (await assistantTurns(first)).at(-1)
  check(firstTurn?.agent === "runtime-default", "T63.1.2 未选择 Agent 的会话使用 default_agent")
  check(/RUNTIME_DEFAULT_MARKER/.test(turnText(firstTurn)), "T63.1.3 default_agent 的 system prompt 生效")

  // T63.2 default_agent 指向 subagent 模式时必须失败，而不是静默换一个 Agent
  await applyConfig(
    (config) => {
      config.agents = { ...config.agents, "runtime-subagent-only": { description: "T63.2 subagent only", mode: "subagent" } }
      config.default_agent = "runtime-subagent-only"
    },
    "runtime-subagent-only",
  )
  const fallback = track(await newSession("T63.2 subagent default"))
  const subagentFailure = await promptFailure(fallback, "Reply with the single word ok.")
  check(subagentFailure.failed, "T63.2.1 default_agent 指向 subagent 模式 Agent 时执行失败")
  check(
    subagentFailure.error?.message?.includes('default_agent "runtime-subagent-only"'),
    "T63.2.2 失败原因指明 default_agent 不可用作会话默认",
  )
  const subagentList = await api(`/api/session/${fallback}/agents`)
  check(subagentList.status === 200, "T63.2.3 配置错误不影响 Agent 列表接口")

  // T63.3 default_agent 指向 hidden Agent 时同样失败
  await applyConfig(
    (config) => {
      config.agents = { ...config.agents, "runtime-hidden": { description: "T63.3 hidden", mode: "primary", hidden: true } }
      config.default_agent = "runtime-hidden"
    },
    "runtime-hidden",
  )
  const hiddenFallback = track(await newSession("T63.3 hidden default"))
  const hiddenFailure = await promptFailure(hiddenFallback, "Reply with the single word ok.")
  check(hiddenFailure.failed, "T63.3.1 default_agent 指向 hidden Agent 时执行失败")
  check(
    hiddenFailure.error?.message?.includes('default_agent "runtime-hidden"'),
    "T63.3.2 失败原因指明 default_agent 被隐藏",
  )
  check((await api(`/api/session/${hiddenFallback}/agents`)).status === 200, "T63.3.3 配置错误不影响 Agent 列表接口")

  // T63.4 修改 default_agent 的影响范围：只有显式选择过 Agent 的会话才保持不变。
  // 文档原文 "Changing this setting does not replace the agent stored on an existing session"
  // 只对显式保存了 agent 的 Session 成立；未显式选择的 Session 每次执行都重新解析默认值。
  const pinned = track(await newSession("T63.4 pinned agent"))
  await api(`/api/session/${pinned}/agent`, "POST", { agent: "runtime-default" })
  await applyConfig(
    (config) => {
      config.agents = { ...config.agents, "runtime-second": { description: "T63.4 second default", mode: "primary", system: "Answer with RUNTIME_SECOND_MARKER." } }
      config.default_agent = "runtime-second"
    },
    "runtime-second",
  )
  check((await api(`/api/session/${pinned}`)).data.data.agent === "runtime-default", "T63.4.1 显式选择过的会话仍保存原 Agent ID")
  await prompt(pinned, "State the marker only.")
  const pinnedTurn = (await assistantTurns(pinned)).at(-1)
  check(pinnedTurn?.agent === "runtime-default", "T63.4.2 default_agent 变更后显式选择过的会话仍使用原 Agent")
  check(!/RUNTIME_SECOND_MARKER/.test(turnText(pinnedTurn)), "T63.4.3 该会话未被新 default_agent 的 system prompt 影响")

  // 未显式选择的会话不保存 Agent ID，改用新建会话观测，避免复用跨多轮配置的旧会话。
  const unpinned = track(await newSession("T63.4 unpinned"))
  await prompt(unpinned, "State the marker only.")
  const unpinnedTurn = (await assistantTurns(unpinned)).at(-1)
  check(
    unpinnedTurn?.agent === "runtime-second",
    "T63.4.4 未显式选择 Agent 的会话使用当前 default_agent（文档未说明该场景）",
  )
  check(/RUNTIME_SECOND_MARKER/.test(turnText(unpinnedTurn)), "T63.4.5 新的 default_agent 的 system prompt 对未选 Agent 的会话生效")

  // T63.5 mode: all 既可作为 primary 执行
  const allSession = track(await newSession("T63.5 mode all"))
  await api(`/api/session/${allSession}/agents`, "POST", {
    id: "runtime-all",
    config: {
      description: "T63.5 all-mode agent",
      mode: "all",
      system: "You are the RUNTIME_ALL_AGENT. When asked to delegate, call the subagent tool with agent \"runtime-all-child\". Otherwise answer with RUNTIME_ALL_PRIMARY_OK.",
    },
  })
  await api(`/api/session/${allSession}/agent`, "POST", { agent: "runtime-all" })
  await prompt(allSession, "Reply with RUNTIME_ALL_PRIMARY_OK.")
  const allTurn = (await assistantTurns(allSession)).at(-1)
  check(allTurn?.agent === "runtime-all", "T63.5.1 mode: all Agent 可被选为会话 primary 并执行")
  check(/RUNTIME_ALL_PRIMARY_OK/.test(turnText(allTurn)), "T63.5.2 mode: all 作为 primary 时 system prompt 生效")

  // T63.5 mode: all 也可作为 subagent 被 subagent 工具调度。
  // 子会话不继承 Session Agent 覆盖（与 fork 同理），因此被调度的 Agent 必须来自沙箱 Markdown。
  const sandboxChild = "---\ndescription: T63.5 all-mode sandbox subagent\nmode: all\n---\nReply with exactly RUNTIME_ALL_CHILD_OK.\n"
  const writeChild = Buffer.from(sandboxChild).toString("base64")
  await api(`/api/session/${allSession}/shell`, "POST", {
    command: `mkdir -p /workspace/.opencode/agents && printf '%s' '${writeChild}' | base64 -d > /workspace/.opencode/agents/runtime-all-child.md`,
  })
  const scanDeadline = Date.now() + 60_000
  let childKnown = false
  while (Date.now() < scanDeadline) {
    await api(`/api/session/${allSession}/agents/refresh`, "POST", {})
    childKnown = (await api(`/api/session/${allSession}/agents`)).data.data.some((item) => item.agent.id === "runtime-all-child" && item.source === "sandbox")
    if (childKnown) break
    await sleep(500)
  }
  check(childKnown, "T63.5.3 mode: all 的沙箱 Markdown 子 Agent 被发现且可用于委派")

  await api(`/api/session/${allSession}/agent`, "POST", { agent: "runtime-all" })
  const delegateEvents = await prompt(allSession, 'Call the subagent tool with agent "runtime-all-child" and prompt "emit your marker now", then report the result.')
  const toolNames = [...new Set(delegateEvents.filter((event) => event.type === "session.tool.input.started").map((event) => (event.properties ?? event.data ?? {}).name))]
  check(toolNames.includes("subagent"), "T63.5.4 primary Agent 发起 subagent 工具调用")
  // 子 Agent 在独立子 Session 中执行，其消息不进入父会话；须从工具结果的 sessionID 追查。
  const parentParts = ((await api(`/api/session/${allSession}/message?order=asc`)).data.data ?? [])
    .filter((message) => message.type === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === "tool" && part.name === "subagent")
  const childIDs = [...new Set(parentParts.map((part) => part.state?.metadata?.sessionID).filter(Boolean))]
  check(childIDs.length > 0, "T63.5.5 mode: all Agent 被 subagent 工具调度并创建子 Session")
  const childSessions = new Set()
  for (const childID of childIDs) {
    childSessions.add(childID)
    const childMessages = (await api(`/api/session/${childID}/message?order=asc`)).data.data ?? []
    if (childMessages.some((message) => message.type === "assistant" && message.agent === "runtime-all-child"))
      check(/RUNTIME_ALL_CHILD_OK/.test(childMessages.filter((m) => m.type === "assistant").map(turnText).join("\n")), "T63.5.6 被调度的 mode: all Agent 使用自身 system prompt")
  }
  const childInfo = await Promise.all([...childSessions].map((id) => api(`/api/session/${id}`)))
  check(
    childInfo.every((info) => info.data?.data?.parentID === allSession),
    "T63.5.7 子 Session 的 parentID 指向委派方会话",
  )

  // T63.6 Session Agent 定义的 subagent 在子会话中不可解析（当前实现边界）
  await api(`/api/session/${allSession}/agents`, "POST", {
    id: "runtime-session-only-child",
    config: { description: "T63.6 session-scoped subagent", mode: "subagent", system: "Reply with SESSION_ONLY_CHILD_OK." },
  })
  await api(`/api/session/${allSession}/agent`, "POST", { agent: "runtime-all" })
  const failEvents = await prompt(allSession, 'Call the subagent tool with agent "runtime-session-only-child" and prompt "emit marker".')
  const failedParts = ((await api(`/api/session/${allSession}/message?order=asc`)).data.data ?? [])
    .filter((message) => message.type === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === "tool" && part.name === "subagent" && part.state?.input?.agent === "runtime-session-only-child")
  check(
    failEvents.some((event) => event.type === "session.tool.failed") &&
      failedParts.length > 0 &&
      failedParts.every((part) => part.state.status === "error"),
    "T63.6.1 Session Agent 定义的 subagent 在子会话中无法解析（子会话不继承 Session 覆盖）",
  )

  // T63.7 steps 上限收敛，并在新用户输入后重置额度
  const stepsSession = track(await newSession("T63.7 steps"))
  await api(`/api/session/${stepsSession}/agents`, "POST", {
    id: "runtime-steps",
    config: { description: "T63.7 steps agent", mode: "primary", steps: 2, system: "Use the bash tool as often as you can." },
  })
  await api(`/api/session/${stepsSession}/agent`, "POST", { agent: "runtime-steps" })
  const runSteps = async () => {
    const response = await fetch(`${BASE}/api/session/${stepsSession}/prompt_stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "Run `echo step-probe-1`, then `echo step-probe-2`, then `echo step-probe-3`, then `echo step-probe-4` using the bash tool. Run every command.",
        metadata: {},
        delivery: "queue",
      }),
      signal: AbortSignal.timeout(timeout),
    })
    if (response.status !== 200) throw new Error(`prompt_stream HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const body = await response.text()
    const failure = body.split(/\r?\n\r?\n/)
      .map((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join(""))
      .filter((data) => data.startsWith("{"))
      .map((data) => JSON.parse(data))
      .find((event) => event.type === "session.step.failed")
    return {
      body,
      steps: (body.match(/"type":"session\.step\.started"/g) ?? []).length,
      toolSuccess: (body.match(/"type":"session\.tool\.success"/g) ?? []).length,
      succeeded: body.includes("session.execution.succeeded"),
      error: failure ? (failure.properties ?? failure.data ?? {}).error : undefined,
    }
  }
  // steps 上限本身可验证：执行步数被截断在配置值，不因提示词要求更多工具而继续。
  const firstRound = await runSteps()
  check(
    firstRound.steps === 2,
    `T63.7.1 steps=2 时执行恰好 2 步（实测 ${firstRound.steps}），不因提示词要求继续调用工具而扩展`,
  )
  recordDefect(
    firstRound.succeeded && turnText((await assistantTurns(stepsSession)).at(-1)).trim().length > 0,
    "T63.7.2 达到 steps 上限后按文档收敛为文本总结",
    firstRound.succeeded ? "执行成功但末轮无文本总结" : `执行以 ${firstRound.error?.type} 结束：${firstRound.error?.message}`,
  )

  const secondRound = await runSteps()
  check(
    secondRound.steps === 2,
    `T63.7.3 新用户输入重置 steps 额度，第二轮重新获得 2 步（实测 ${secondRound.steps}）`,
  )
  console.log(
    `      （steps 观测：首轮 steps=${firstRound.steps} tools=${firstRound.toolSuccess} ok=${firstRound.succeeded}；` +
      `第二轮 steps=${secondRound.steps} tools=${secondRound.toolSuccess} ok=${secondRound.succeeded}）`,
  )
} finally {
  for (const id of sessions) await api(`/api/session/${id}`, "DELETE")
  execFileSync("docker", ["exec", "-i", CONTAINER, "sh", "-c", `cat > ${CONFIG}`], { encoding: "utf8", input: originalConfig })
  const restored = readConfig()
  check(restored.default_agent === undefined, "清理：default_agent 已还原")
  check(!Object.keys(restored.agents ?? {}).some((id) => id.startsWith("runtime-")), "清理：测试用全局 agents 定义已移除")
  if (knownDefects.length > 0) {
    console.log(`\n发现 ${knownDefects.length} 项与文档不符的缺陷（详见 builtin-agents.md 与 AGENT-DOC-COVERAGE-GAP.md）：`)
    for (const item of knownDefects) console.log(`  - ${item}`)
    process.exitCode = 1
  }
}
