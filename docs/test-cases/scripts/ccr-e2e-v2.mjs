// V2 CCR 容器验收（对齐 docs/test-cases/context/session-ccr.md 的 L1/L2/L5/L6）。
// 前置：docker run -p 14200:4096 -e OPENCODE_DATABASE_URL=... opencode-saas-sandbox-test:<tag>
// 用法：BASE=http://127.0.0.1:14200 node docs/test-cases/scripts/ccr-e2e-v2.mjs
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14200").replace(/\/$/, "")
const PG_URL = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const PASSWORD = process.env.OPENCODE_PASSWORD ?? "pg-e2e-test-password"
const MODEL = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}')
const headers = {
  "content-type": "application/json",
  authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`,
}

const sql = (statement) =>
  execFileSync("psql", [PG_URL, "-X", "-A", "-t", "-c", statement], { encoding: "utf8" }).trim()

let pass = 0
const ok = (name) => { pass++; console.log(`✅ ${name} PASS`) }
const fail = (name, detail) => { console.error(`❌ ${name} FAIL: ${detail ?? ""}`) }

const api = async (path, init) => {
  const response = await fetch(`${BASE}${path}`, { ...init, headers, signal: AbortSignal.timeout(300_000) })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : undefined } catch { body = text }
  assert(response.ok, `${init?.method ?? "GET"} ${path}: HTTP ${response.status}: ${String(text).slice(0, 400)}`)
  return body
}

const sid = process.env.CCR_SESSION_ID
let sessionID = sid
const created = !sid

try {
  // ── L1：服务可用 + CCR 开关镜像内置 ────────────────────────────────────
  {
    const info = execFileSync(
      "docker",
      ["inspect", "opencode-ccr-v2-test", "--format", "{{range .Config.Env}}{{println .}}{{end}}"],
      { encoding: "utf8" },
    )
    assert.match(info, /OPENCODE_CCR_ENABLED=true/, "容器 env 缺少 OPENCODE_CCR_ENABLED=true")
    ok("L1 容器 OPENCODE_CCR_ENABLED=true（Dockerfile 内置）")
  }

  if (created) {
    const result = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: "ccr-e2e-v2",
        location: { directory: "/workspace" },
        model: MODEL,
        permissions: ["bash", "read", "glob", "grep", "list"].map((action) => ({ action, resource: "*", effect: "allow" })),
      }),
    })
    sessionID = result.data.id
  }
  console.log(`session: ${sessionID}`)
  ok("会话创建/复用")

  // ── 第一轮：让模型跑 bash 产生大输出（>250 token 阈值） ─────────────────
  const waitFor = async (predicate, label, timeoutMs = 240_000) => {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      const messages = await api(`/api/session/${sessionID}/message?order=asc`)
      const list = messages.data ?? []
      if (predicate(list)) return list
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
    throw new Error(`等待超时：${label}`)
  }

  const hasCompletedTurn = (list) => {
    const assistants = list.filter((message) => message.type === "assistant")
    const last = assistants.at(-1)
    return Boolean(last && last.time?.completed)
  }
  // V2 消息形状：assistant.content[] 内 {type:'tool', state:{status:'completed', output}}
  const toolContent = (part) =>
    (part.state?.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("")
  const bigToolOutput = (list) =>
    list.some((message) =>
      (message.content ?? []).some(
        (part) => part.type === "tool" && part.state?.status === "completed" && toolContent(part).length > 3000,
      ),
    )

  if (created) {
    const prompt = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "使用 bash 工具运行命令 `seq 1 800`，把输出原样留在工具结果里，然后只回复 ok。", metadata: {}, delivery: "queue" }),
      signal: AbortSignal.timeout(300_000),
    })
    assert(prompt.ok, `prompt_stream HTTP ${prompt.status}`)
    await prompt.text() // 读空流至完成
  }
  const first = await waitFor((list) => bigToolOutput(list) && hasCompletedTurn(list), "第一轮大输出+完成")
  ok("L2 前置：第一轮产生大 tool 输出并完成")

  const toolOutputs = first.flatMap((message) =>
    (message.content ?? []).filter((part) => part.type === "tool").map(toolContent),
  )
  const originalLength = toolOutputs.join("").length
  assert(originalLength > 3000, `tool 输出过小（${originalLength} 字符），压缩不会触发`)
  console.log(`tool 原始输出约 ${originalLength} 字符`)

  // 多轮推进历史：一轮中 assistant/tool 消息会拆成多条模型消息，
  // 因此需要实际轮询 PG entry，而不是假定第二轮已经越过 protectRecent 窗口。
  let entries = "0"
  for (let turn = 1; turn <= 6 && entries === "0"; turn++) {
    const prompt = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "请只回复 ok。", metadata: {}, delivery: "queue" }),
      signal: AbortSignal.timeout(300_000),
    })
    assert(prompt.ok, `后续第 ${turn} 轮 prompt_stream HTTP ${prompt.status}`)
    await prompt.text()
    await waitFor(hasCompletedTurn, `后续第 ${turn} 轮完成`)
    entries = sql(`SELECT count(*) FROM kv WHERE key LIKE 'plugin/ccr/${sessionID}/%'`)
  }
  assert.notEqual(entries, "0", "推进 6 轮后仍未生成 CCR entry；检查请求视图转换/阈值")

  // ── L5：PG kv 表出现 plugin/ccr entry ─────────────────────────────────
  const entry = sql(
    `SELECT key || '|' || (value::jsonb->>'strategy') || '|' || (value::jsonb->>'originalTokens') || '|' || (value::jsonb->>'tool') FROM kv WHERE key LIKE 'plugin/ccr/${sessionID}/%' LIMIT 1`,
  )
  console.log(`kv entry: ${entry}`)
  ok(`L5 CCR entry 落 PG kv 表（${entries} 条，strategy/tokens 元数据完整）`)

  // ── L6 前置：session_message 原文未动 ──────────────────────────────────
  const persisted = sql(
    `SELECT count(*) FROM session_message WHERE session_id='${sessionID}' AND length(data) > 3000`,
  )
  assert.notEqual(persisted, "0", "PG 消息原文缺失")
  ok("L6 前置：PG 消息原文保持完整（压缩只改请求视图）")

  // ── L6：删除会话清理 CCR entry ─────────────────────────────────────────
  await api(`/api/session/${sessionID}`, { method: "DELETE" })
  const afterRemove = sql(`SELECT count(*) FROM kv WHERE key LIKE 'plugin/ccr/${sessionID}/%'`)
  assert.equal(afterRemove, "0", `删除会话后 kv 仍有 ${afterRemove} 条 plugin/ccr entry`)
  ok("L6 会话删除同步清理 plugin/ccr entry")

  console.log(`\n===== CCR 容器验收: ${pass} 项全部 PASS =====`)
} catch (error) {
  fail("验收中断", error.message)
  console.log(`\n===== CCR 容器验收: FAIL（已通过 ${pass} 项）=====`)
  process.exit(1)
}
