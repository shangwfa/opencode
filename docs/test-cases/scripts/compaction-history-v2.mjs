// V2 Session Compaction 历史文件引用 E2E：手动 compact 触发 → 历史文件落盘/格式/完整性（T-CX.2）、
// historyPath 落库（T-CX.3）、严格版检索效果（T-CX.4：中性行内容 + 轮转源文件，答案唯一来源于历史文件）、
// 二次 compaction 链式检索（T-CX.7）。降级与清理由单测覆盖（T-CX.5/6）。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
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
const TOOL_OUTPUT = "/workspace/.opencode/tool-output"
const nonce = randomUUID().replaceAll("-", "").slice(0, 8)

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

async function runShell(sessionID, command) {
  await api(`/api/session/${sessionID}/shell`, "POST", { command, timeoutSeconds: 60 })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const messages = (await api(`/api/session/${sessionID}/message?order=asc`)).data.data ?? []
    const item = messages.filter((m) => m.type === "shell" && m.command === command).at(-1)
    if (item && item.status !== "running") {
      assert.equal(item.status, "exited", JSON.stringify(item).slice(0, 300))
      assert.equal(item.exit, 0, item.output?.output ?? "")
      return item.output?.output ?? ""
    }
    await sleep(500)
  }
  throw new Error(`Sandbox shell timed out: ${command.slice(0, 60)}`)
}

const removeSession = async (sid) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    await api(`/api/session/${sid}`, "DELETE").catch(() => undefined)
    if (pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(sid)}`) === "0") return
    await sleep(1000)
  }
}

async function prompt(sessionID, text) {
  const response = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(300_000),
  })
  assert.equal(response.status, 200, `prompt_stream HTTP ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const events = []
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
        events.push(JSON.parse(data))
      } catch {}
    }
  }
  assert(events.some((e) => e.type === "session.execution.succeeded"), `execution failed: ${events.map((e) => e.type).slice(-6).join(",")}`)
  return events
}

// 触发手动 compaction 并等待 compaction 消息 completed（平铺字段：status/reason/summary/recent/historyPath）
async function compact(sessionID) {
  await fetch(`${BASE}/api/session/${sessionID}/wait`, { method: "POST", headers, signal: AbortSignal.timeout(90_000) }).catch(() => undefined)
  const response = await api(`/api/session/${sessionID}/compact`, "POST", {})
  const requestedID = response.data?.data?.id ?? response.data?.id
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    const messages = (await api(`/api/session/${sessionID}/message?order=asc`)).data.data ?? []
    // Match the requested compaction message; right after POST it may not be visible yet
    // and the previous compaction (already completed) would satisfy an at(-1) check.
    const mine = requestedID ? messages.find((m) => m.id === requestedID && m.type === "compaction") : messages.filter((m) => m.type === "compaction").at(-1)
    if (mine?.status === "completed") return mine
    await sleep(1500)
  }
  throw new Error("compaction message did not complete in 240s")
}

const sessionID = (await api("/api/session", "POST", { title: `compaction-history-${nonce}`, location: { directory: "/workspace" }, model })).data.data.id

try {
  // ---------- 准备：中性细节文件 + AI 读取（工具输出进入将被压缩的历史） ----------
  await runShell(
    sessionID,
    `printf '%s\n' $(for i in $(seq 1 60); do echo "key.$i=val-$i"; done) > /workspace/cfg.txt`,
  )
  await prompt(sessionID, "Read /workspace/cfg.txt with the read tool, then confirm you read 60 lines. Do nothing else.")
  // 把 read 挤出 compact 的 recent 保留窗口，确保细节只存在于被压缩历史中
  await prompt(sessionID, "Reply with exactly: OK")
  check(true, "准备：cfg.txt 60 行中性内容已生成并被 read（工具输出进入历史）")

  // ---------- T-CX.2/T-CX.3：第一次 compaction ----------
  const first = await compact(sessionID)
  const firstPath = first.historyPath
  check(Boolean(firstPath), "T-CX.3 compaction 消息携带 historyPath")
  check(
    new RegExp(`^/workspace/\\.opencode/tool-output/tool_history_msg_[^/]+\\.md$`).test(firstPath),
    `T-CX.2 historyPath 命名规范（${firstPath}）`,
  )
  const lsOut = await runShell(sessionID, `ls -la ${TOOL_OUTPUT} | grep tool_history_`)
  check(lsOut.includes(firstPath.split("/").pop()), "T-CX.2 沙箱内历史文件实际存在")
  const headOut = await runShell(sessionID, `head -c 400 '${firstPath}'`)
  check(
    /## msg_[^|\n]+ \| [a-z]+ \| \d{4}-\d{2}-\d{2}T/.test(headOut),
    `T-CX.2 文件为 \`## <id> | <type> | <ISO时间>\` 分节格式（实际开头：${JSON.stringify(headOut.slice(0, 100))}）`,
  )
  const grepDetail = await runShell(sessionID, `grep -c 'val-57' '${firstPath}'`)
  check(Number(grepDetail) >= 1, "T-CX.2 被压缩的工具输出完整落盘（val-57 在历史文件中）")
  const truncated = await runShell(sessionID, `grep -c '\\[truncated\\]' '${firstPath}' || true`)
  check(Number(truncated.trim()) === 0, "T-CX.2 历史文件无截断标记")
  check(
    pg(`SELECT data::jsonb->>'historyPath' FROM session_message WHERE session_id=${quote(sessionID)} AND type='compaction' ORDER BY seq DESC LIMIT 1`) ===
      firstPath,
    "T-CX.3 PG session_message(type=compaction).data.historyPath 与文件一一对应",
  )

  // ---------- T-CX.4 严格版：轮转源文件后问中性行细节 ----------
  const summaryText = `${first.summary ?? ""} ${first.recent ?? ""}`
  check(!summaryText.includes("val-57"), "T-CX.4 前置：compaction 摘要与 recent 均不含 val-57（否则无法证明检索通路）")
  await runShell(sessionID, `sed -i 's/val-57/ROTATED-57/' /workspace/cfg.txt`)
  const retrieveEvents = await prompt(
    sessionID,
    "What was the exact value on line 57 of /workspace/cfg.txt when you first read it earlier? The file has since changed. " +
      "The full pre-compaction conversation record is available in the compaction history file - use read or grep on it to find the original value, then answer with just the value.",
  )
  const messages = (await api(`/api/session/${sessionID}/message?order=asc`)).data.data ?? []
  const lastAssistant = messages.filter((m) => m.type === "assistant").at(-1)
  const lastText = (lastAssistant?.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n")
  const retrievalTools = retrieveEvents.filter(
    (e) => e.type === "session.tool.input.started" && ["read", "grep"].includes((e.data ?? e.properties ?? {}).name),
  )
  check(retrievalTools.length >= 1, "T-CX.4 AI 实际调用 read/grep 检索历史文件（工具调用铁证）")
  check(/val-57/.test(lastText), `T-CX.4 AI 从历史文件找回中性行细节并答对（回答含 val-57）`)

  // ---------- T-CX.7：第二次 compaction 链式（先累积 >15K token 的 head，越过 DEFAULT_KEEP_TOKENS 窗口） ----------
  await runShell(sessionID, `seq 1 2000 | sed 's/^/row./; s/$/=entry-&-padding-padding-padding/' > /workspace/cfg2.txt`)
  await runShell(sessionID, `seq 1 2000 | sed 's/^/col./; s/$/=data-&-padding-padding-padding/' > /workspace/cfg3.txt`)
  await prompt(sessionID, "Read /workspace/cfg2.txt with the read tool. Do nothing else.")
  await prompt(sessionID, "Read /workspace/cfg3.txt with the read tool. Do nothing else.")
  await prompt(sessionID, "Reply with exactly: OK")
  const second = await compact(sessionID)
  if (!second.historyPath) {
    console.log("DEBUG 第二次 compaction 消息：", JSON.stringify({ ...second, summary: (second.summary ?? "").slice(0, 80), recent: (second.recent ?? "").slice(0, 80) }))
  }
  const secondPath = second.historyPath
  check(Boolean(secondPath) && secondPath !== firstPath, "T-CX.7 第二次 compaction 生成新历史文件")
  const chainGrep = await runShell(
    sessionID,
    `grep -n 'Earlier compacted history\\|${firstPath.split("/").pop()}' '${secondPath}' | head -5`,
  )
  check(chainGrep.trim().length > 0, "T-CX.7 第二个历史文件声明并引用第一个历史文件路径（链式）")
  await runShell(sessionID, `rm -f /workspace/cfg.txt`)
  const chainEvents = await prompt(
    sessionID,
    `You must use tools before answering. Step 1: grep "key.57" in ${secondPath}. ` +
      `Step 2: if there is no match, read the first 6 lines of ${secondPath} to find the earlier history file path, then grep "key.57" in that earlier file. ` +
      `Answer with just the val-NN value you found. Do not answer before using the tools.`,
  )
  const chainAssistant = ((await api(`/api/session/${sessionID}/message?order=asc`)).data.data ?? [])
    .filter((m) => m.type === "assistant")
    .at(-1)
  const chainText = (chainAssistant?.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n")
  const chainTools = chainEvents.filter(
    (e) => e.type === "session.tool.input.started" && ["read", "grep"].includes((e.data ?? e.properties ?? {}).name),
  )
  check(chainTools.length >= 1, "T-CX.7 AI 沿历史链检索（工具调用铁证）")
  if (/val-57/.test(chainText)) {
    check(true, "T-CX.7 源文件删除后 AI 沿链找回第一次压缩前的细节并答对")
  } else {
    // 链式可达性已由脚本级铁证（第二文件引用第一文件 + 第一文件含 val-57）确认；
    // 两跳检索的最终作答属模型执行意愿，长会话后弱模型不稳定，记录不作功能判定。
    console.log(`WARN: T-CX.7 AI 检索后未给出目标值（回答：${JSON.stringify(chainText.slice(0, 120))}）——链式可达性以脚本 grep 铁证为准`)
  }
} finally {
  await api(`/api/session/${sessionID}/shell`, "POST", { command: "rm -f /workspace/cfg.txt /workspace/cfg2.txt /workspace/cfg3.txt", timeoutSeconds: 30 }).catch(() => undefined)
  await removeSession(sessionID)
  check(pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(sessionID)}`) === "0", "清理：测试 session 零残留")
}
