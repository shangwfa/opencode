// TCM2.4（Sandbox executor 形态）+ TCM2.S2 子集 + progress 断言：
// echo MCP fixture 安装进 Session Sandbox → 注册 Session MCP → 模型 execute 内调用 tools.echo.echo →
// 断言 Runner tool.call 经 SaaS Tool snapshot dispatch（metadata.toolCalls 审计）、结果回传、SSE progress、PG 持久化。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

const BASE = (process.env.BASE ?? "http://localhost:14106").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const parsedModel = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-GLM","id":"glm-5.3"}')
const model = { providerID: parsedModel.providerID, id: parsedModel.id ?? parsedModel.modelID }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nonce = randomUUID().replaceAll("-", "").slice(0, 8)
const sentinel = `cm-s2-${nonce}`

function check(ok, description) {
  assert(ok, `FAIL: ${description}`)
  console.log(`PASS: ${description}`)
}
function pg(sql) {
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`)
  return result.stdout.trim()
}
const quote = (value) => `'${value.replaceAll("'", "''")}'`

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(300_000),
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

async function runShell(sessionID, command, timeoutSeconds = 60) {
  await api(`/api/session/${sessionID}/shell`, "POST", { command, timeoutSeconds })
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const messages = (await api(`/api/session/${sessionID}/message?order=asc`)).data.data ?? []
    const item = messages.filter((m) => m.type === "shell" && m.command === command).at(-1)
    if (item && item.status !== "running") {
      assert.equal(item.status, "exited", JSON.stringify(item).slice(0, 400))
      assert.equal(item.exit, 0, item.output?.output ?? "")
      return item.output?.output ?? ""
    }
    await sleep(500)
  }
  throw new Error(`shell timed out: ${command.slice(0, 80)}`)
}

const sessionID = (await api("/api/session", "POST", { title: `cm-s2-${nonce}`, location: { directory: "/workspace" }, model })).data.data.id

// 强约束 harness agent：直接用 execute，禁止探索与提问（避免模型自由发挥卡住回合）
await api(`/api/session/${sessionID}/agents`, "POST", {
  id: "session/cm-harness",
  config: {
    mode: "primary",
    description: "S2 harness",
    system:
      "You execute scripting tasks exclusively through the execute tool. When asked to run code or call tools, call execute immediately with the requested code. Never use question, read, glob, grep, webfetch, or shell tools. Never ask for confirmation. After execute returns, report its result in one line.",
  },
})
await api(`/api/session/${sessionID}/agent`, "POST", { agent: "session/cm-harness" })

try {
  // ---------- 0) 沙箱前置：node + supergateway（MCP bridge 依赖，文档 2.4） ----------
  const pre = await runShell(sessionID, `node --version && command -v supergateway && echo PRE_OK`)
  check(pre.includes("PRE_OK"), `沙箱前置满足（node + supergateway：${pre.trim().split("\n").slice(0, 2).join(" / ")}）`)

  // ---------- 1) 安装 echo MCP fixture 进 Session Sandbox ----------
  const fixture = readFileSync(new URL("../code-mode/fixtures/echo-mcp.mjs", import.meta.url), "utf8")
  const encoded = Buffer.from(fixture).toString("base64")
  const installCmd =
    `mkdir -p /workspace/docs/test-cases/code-mode/fixtures && printf '%s' '${encoded}' | base64 -d > /workspace/docs/test-cases/code-mode/fixtures/echo-mcp.mjs && ` +
    `node --check /workspace/docs/test-cases/code-mode/fixtures/echo-mcp.mjs && echo FIXTURE_OK`
  const installed = await runShell(sessionID, installCmd)
  check(installed.includes("FIXTURE_OK"), "echo MCP fixture 安装进 Session Sandbox（语法检查通过）")

  // ---------- 2) 注册 Session MCP ----------
  const registered = await api(`/api/session/${sessionID}/mcps`, "POST", {
    name: "echo",
    config: { type: "local", command: ["node", "/workspace/docs/test-cases/code-mode/fixtures/echo-mcp.mjs"] },
  })
  check(registered.status === 200, "Session MCP echo 注册成功")

  // ---------- 3) 就绪门控 + prompt：execute 内调用 tools.echo.echo（S2 子工具 RPC dispatch） ----------
  let ready = false
  for (let i = 0; i < 24 && !ready; i++) {
    try {
      ready = ((await api(`/api/session/${sessionID}/context`)).text ?? "").includes("echo")
    } catch {}
    if (!ready) await sleep(5000)
  }
  check(ready, "就绪门控：Session 上下文工具目录包含 echo MCP（避免把未就绪误判为执行失败）")

  const before = Number(pg(`SELECT coalesce(max(seq),0) FROM session_message WHERE session_id=${quote(sessionID)}`))
  const promptResponse = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: `必须调用 execute 工具，执行这段代码：return await tools.echo.echo({message:"${sentinel}"})。不要读文件、不要运行 shell、不要探索，直接调用 execute，然后一句话报告返回值。`,
      metadata: {},
      delivery: "queue",
    }),
    // no signal: the stream is drained in the background; assertions poll PG for terminal state
  })
  assert.equal(promptResponse.status, 200, `prompt_stream HTTP ${promptResponse.status}`)
  const events = []
  const streamDone = (async () => {
    const reader = promptResponse.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ""
      for (const block of blocks) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")
        if (!data || data === "[DONE]") continue
        try {
          const event = JSON.parse(data)
          events.push(event)
          // 模型可能用 question 工具请求确认；不自动应答会卡住整轮（实测 form.cancelled + interrupted）
          if (event.type === "form.created") {
            const forms = ((await api(`/api/session/${sessionID}/form`)).data.data ?? []).filter((f) => f.status === "pending")
            for (const form of forms) {
              const answer = {}
              for (const field of form.fields ?? []) {
                if (field.type === "external") continue
                answer[field.key] = field.type === "boolean" ? (field.default ?? true) : field.options?.[0]?.value ?? field.default ?? "yes, proceed"
              }
              await api(`/api/session/${sessionID}/form/${form.id}/reply`, "POST", { answer }).catch(() => undefined)
              console.log("自动应答 form:", form.id)
            }
          }
        } catch {}
      }
    }
  })().catch((e) => console.log("DEBUG stream error:", String(e)))

  // ---------- 4) PG：execute Tool part 终态与子工具审计 ----------
  const deadline = Date.now() + 180_000
  let rows
  while (Date.now() < deadline) {
    rows = pg(
      `SELECT jsonb_build_object('seq', seq, 'content', (data::jsonb)->'content') FROM session_message ` +
        `WHERE session_id=${quote(sessionID)} AND type='assistant' AND seq > ${before} ` +
        `AND jsonb_path_exists(data::jsonb, '$.content[*] ? (@.type == "tool" && @.name == "execute")') ORDER BY seq`,
    )
    const parts = []
    for (const line of rows.split("\n").filter(Boolean)) {
      for (const part of JSON.parse(line).content ?? []) if (part.type === "tool" && part.name === "execute") parts.push(part)
    }
    if (parts.length && parts.every((p) => ["completed", "error"].includes(p.state?.status))) break
    await sleep(1000)
  }
  const parts = []
  for (const line of rows.split("\n").filter(Boolean)) {
    for (const part of JSON.parse(line).content ?? []) if (part.type === "tool" && part.name === "execute") parts.push(part)
  }
  if (parts.length === 0) {
    const msgs = pg(`SELECT type || ':' || seq || ':' || coalesce((data::jsonb)->>'status','') FROM session_message WHERE session_id=${quote(sessionID)} AND seq > ${before} ORDER BY seq`)
    console.log("DEBUG 水位后消息：", msgs.replaceAll("\n", " | "))
    console.log("DEBUG 已收事件：", events.map((e) => e.type).join(", "))
  }
  check(parts.length >= 1, `execute Tool part 出现（${parts.length} 个）`)
  const final = parts.at(-1)
  check(final.state.status === "completed", "S2 execute 终态 completed（Sandbox executor 经 Runner 执行）")
  check(String(final.state.input?.code ?? "").includes("echo.echo"), `execute input.code 调用 echo.echo（模型可改写格式：${String(final.state.input?.code ?? "").slice(0, 120)}）`)
  const outText = JSON.stringify(final.state.content ?? "")
  if (!outText.includes(`Echo: ${sentinel}`)) {
    console.log("DEBUG execute content:", outText.slice(0, 400))
    console.log("DEBUG metadata:", JSON.stringify(final.state.metadata ?? {}).slice(0, 400))
  }
  check(outText.includes(`Echo: ${sentinel}`), "S2 子工具结果经 Runner → SaaS dispatch 回传（Echo 哨兵命中）")
  const toolCalls = final.state.metadata?.toolCalls ?? []
  check(
    toolCalls.some((c) => c.tool === "echo.echo" && c.status === "completed" && c.input?.message === sentinel),
    `S2 metadata.toolCalls 审计子调用（echo.echo completed, input 哨兵一致）`,
  )
  check(toolCalls.every((c) => c.status !== "error"), "S2 子调用无 error")

  // ---------- 5) SSE：execute 执行链事件（progress 上报；使用已收集事件，stream 可能仍在收尾） ----------
  await Promise.race([streamDone, sleep(10_000)])
  const toolStarted = events.find((e) => e.type === "session.tool.input.started" && (e.data ?? e.properties ?? {}).name === "execute")
  check(Boolean(toolStarted), "SSE：execute input.started")
  const progressEvents = events.filter((e) => e.type === "session.tool.progress")
  check(progressEvents.length >= 1, `SSE：execute 过程 progress 上报（${progressEvents.length} 条）`)
  const progressText = JSON.stringify(progressEvents)
  check(
    progressText.includes("echo.echo") || progressText.includes(sentinel),
    "SSE：progress 内容包含子工具调用（echo.echo / 哨兵）",
  )
  check(events.some((e) => e.type === "session.tool.success"), "SSE：execute success")

  // ---------- 6) 清理：删除 MCP + Session ----------
  const removed = await api(`/api/session/${sessionID}/mcps/echo`, "DELETE")
  check(removed.status === 204, "Session MCP 删除成功（TCM2.12 关联）")
} finally {
  await api(`/api/session/${sessionID}/shell`, "POST", { command: "rm -rf /workspace/docs/test-cases/code-mode", timeoutSeconds: 30 }).catch(() => undefined)
  for (let attempt = 0; attempt < 60; attempt++) {
    await api(`/api/session/${sessionID}`, "DELETE").catch(() => undefined)
    if (pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(sessionID)}`) === "0") break
    await sleep(1000)
  }
  check(pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(sessionID)}`) === "0", "清理：测试 session 零残留")
}
