import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const base = process.env.BASE ?? "http://127.0.0.1:14126"
const pg = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-test"
assert.equal(new URL(pg).pathname, "/opencode-v2-test", "必须使用专用测试库")
const evidence = process.env.CONTEXT_EVIDENCE ?? join(tmpdir(), `context-insights-${Date.now()}`)
mkdirSync(evidence, { recursive: true })
const headers = {
  authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`,
  "content-type": "application/json",
}
const events = []
const requests = []
const results = []
const model = { providerID: "context-probe", id: "context-model" }
const provider = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.CONTEXT_MOCK_PORT ?? 18191),
  async fetch(request) {
    const body = await request.json()
    requests.push(body)
    const chunk = (delta, finish_reason = null, usage) =>
      `data: ${JSON.stringify({ id: "context-probe", object: "chat.completion.chunk", model: "context-model", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`
    return new Response(
      chunk({ role: "assistant", reasoning_content: "验证上下文快照采集链路。" }) +
        chunk({ content: "CONTEXT_INSIGHTS_OK" }) +
        chunk({}, "stop", {
          prompt_tokens: 120,
          completion_tokens: 12,
          total_tokens: 132,
          prompt_tokens_details: { cached_tokens: 32 },
        }) +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const api = async (method, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  })
  assert.ok(
    response.ok,
    `${method} ${path}: ${response.status} ${await (response.ok ? Promise.resolve("") : response.text())}`,
  )
  return response.status === 204 ? null : response.json()
}
const check = (name, fn) => {
  fn()
  results.push({ name, passed: true })
  console.log(`验收 ✓ ${name}`)
}
let sessionID
let otherID
const abort = new AbortController()
let watching
let streamError
let outcome = { passed: false, sandboxExecutionVerified: false }
try {
  sessionID =
    process.env.CONTEXT_SESSION_ID ??
    (await api("POST", "/api/session", { title: "Context insights deterministic API acceptance", model })).data.id
  otherID = (await api("POST", "/api/session", { title: "Context isolation", model })).data.id
  assert.match(sessionID, /^ses_[a-zA-Z0-9]+$/)
  const root = `/api/session/${sessionID}`
  const stream = await fetch(`${base}${root}/event`, { headers, signal: abort.signal })
  assert.equal(stream.status, 200)
  let connected
  const ready = new Promise((resolve) => {
    connected = resolve
  })
  watching = (async () => {
    const reader = stream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      buffer += decoder.decode(chunk.value, { stream: true })
      let end
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const line = frame.split("\n").find((line) => line.startsWith("data: "))
        if (!line) continue
        const event = JSON.parse(line.slice(6))
        events.push(event)
        if (event.type === "server.connected") connected()
        if (
          !event.type.endsWith(".delta") &&
          !["session.step.streamed", "session.usage.updated"].includes(event.type)
        ) {
          const text = event.data?.text ?? event.data?.name ?? event.data?.request?.kind ?? event.data?.reason ?? ""
          console.log(`SSE ${event.type} ${String(text).slice(0, 160)}`)
        }
        if (event.type === "form.created") {
          const form = event.data.form
          const answer = {}
          for (const field of form.fields) {
            if (field.type === "external") continue
            const active = (field.when ?? []).every((rule) => {
              const value = answer[rule.key]
              const equal = Array.isArray(value) ? value.includes(rule.value) : value === rule.value
              return value !== undefined && (rule.op === "eq" ? equal : !equal)
            })
            if (!active) continue
            answer[field.key] =
              field.default ??
              (field.type === "boolean"
                ? true
                : ["integer", "number"].includes(field.type)
                  ? (field.minimum ?? 0)
                  : field.type === "multiselect"
                    ? field.options.slice(0, field.minItems ?? 1).map((option) => option.value)
                    : (field.options?.[0]?.value ?? "继续执行"))
          }
          await api("POST", `${root}/form/${form.id}/reply`, { answer })
        }
      }
    }
  })().catch((error) => {
    if (!abort.signal.aborted) streamError = String(error)
  })
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("SSE 连接超时")), 10_000))])
  const observerDelay = Number(process.env.CONTEXT_OBSERVER_DELAY_MS ?? 0)
  assert.ok(Number.isSafeInteger(observerDelay) && observerDelay >= 0 && observerDelay <= 30_000)
  if (observerDelay) await new Promise((resolve) => setTimeout(resolve, observerDelay))
  await api("POST", `${root}/agents-md`, { content: "CONTEXT_PROBE_SYSTEM_V1" })
  for (const text of ["CONTEXT_PROBE_USER_V1", "CONTEXT_PROBE_USER_V2"]) {
    if (text.endsWith("V2")) await api("POST", `${root}/agents-md`, { content: "CONTEXT_PROBE_SYSTEM_V2" })
    const response = await fetch(`${base}${root}/prompt_stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, model, metadata: {} }),
      signal: AbortSignal.timeout(90_000),
    })
    assert.equal(response.status, 200)
    for await (const _chunk of response.body) {
      /* The independent session feed renders execution in real time. */
    }
    await api("POST", `/api/experimental/session/${sessionID}/wait`)
  }
  await api("POST", `${root}/compact`, {})
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  if (streamError) throw new Error(streamError)
  const summary = (await api("GET", `${root}/context-insights`)).data
  const page = await api("GET", `${root}/context-insights/requests?limit=100`)
  const primary = page.data.filter((row) => row.kind === "primary")
  check("压缩请求被单独采集，压缩不删除旧请求快照", () => {
    assert.equal(page.data.filter((row) => row.kind === "compaction").length, 2)
    assert.ok(primary.length >= 2)
  })
  check("实际模型调用与快照一一对应，不漏记压缩修正请求", () => assert.equal(page.data.length, requests.length))
  check("每次模型请求独立持久化，摘要不含正文", () => {
    assert.ok(primary.length >= 2)
    assert.equal(summary.capturedRequests, page.data.length)
    assert.ok(!JSON.stringify(page).includes("CONTEXT_PROBE_SYSTEM"))
    assert.ok(primary.every((row) => row.boundary === "model-call-semantic-request" && row.assistantMessageID))
  })
  const contents = []
  for (const request of page.data) {
    const detail = (await api("GET", `${root}/context-insights/requests/${request.id}`)).data
    for (const item of detail.items) {
      const body = (await api("GET", `${root}/context-insights/requests/${request.id}/items/${item.index}`)).data
      contents.push({ requestID: request.id, item, content: body.content })
    }
  }
  check("压缩快照包含最终追加的摘要指令与修正指令", () => {
    assert.ok(contents.some((item) => item.content?.includes("Summarize only what the user and the assistant said")))
    assert.ok(
      contents.some((item) =>
        item.content?.includes("The previous response did not fill in the required summary template"),
      ),
    )
  })
  check("请求保留各自的系统指令和用户输入，修改后不覆盖旧快照", () => {
    for (const marker of [
      "CONTEXT_PROBE_SYSTEM_V1",
      "CONTEXT_PROBE_SYSTEM_V2",
      "CONTEXT_PROBE_USER_V1",
      "CONTEXT_PROBE_USER_V2",
    ])
      assert.ok(
        contents.some((item) => item.content?.includes(marker)),
        marker,
      )
  })
  check("默认 Code Mode 的模型公开 schema 进入工具组成", () => {
    assert.ok(contents.some((row) => row.item.category === "tools" && row.item.name === "execute"))
    assert.ok(requests.some((row) => row.tools?.some((tool) => tool.function?.name === "execute")))
  })
  const denied = await fetch(`${base}/api/session/${otherID}/context-insights/requests/${primary[0].id}/items/0`, {
    headers,
  })
  check("不能跨会话读取正文", () => assert.equal(denied.status, 404))
  const analysis = (await api("GET", `${root}/context-insights/analysis`)).data
  check("分析接口把每次模型调用映射为一个请求点，实际用量来自结算事件", () => {
    assert.equal(analysis.points.length, page.data.length)
    assert.equal(analysis.scope, "request-page")
    const primaryPoints = analysis.points.filter((point) => point.request.kind === "primary")
    assert.ok(primaryPoints.every((point) => point.status === "completed"))
    assert.ok(primaryPoints.every((point) => point.actual && point.actual.tokens.input >= 0))
    assert.ok(analysis.points.some((point) => point.request.kind === "compaction" && (point.status === "completed" || point.status === "failed")))
    assert.ok(JSON.stringify(analysis).includes("CONTEXT_INSIGHTS_OK") === false)
    assert.ok(analysis.points.every((point) => typeof point.turn === "number"))
    assert.ok(analysis.points.every((point) => point.delta === null || typeof point.delta === "number"))
    assert.ok(analysis.points.every((point) => point.toolMs === null || point.toolMs >= 0))
    assert.ok(analysis.points.every((point) => point.elapsedMs === null || point.elapsedMs >= 0))
    assert.equal(analysis.points.filter((point) => point.actual !== null).length >= 2, true)
    assert.ok(analysis.points.every((point) => point.actual === null || typeof point.actual.cost === "number"))
  })
  check("压缩请求按自身结算归属：最后一次尝试拿到用量，早期尝试保持 unknown 而不伪造", () => {
    const primaryPoints = analysis.points.filter((point) => point.request.kind === "primary")
    assert.ok(primaryPoints.every((point) => point.status === "completed" && point.actual !== null))
    const compactionPoints = analysis.points.filter((point) => point.request.kind === "compaction")
    assert.ok(compactionPoints.length >= 2)
    // 一次压缩若含模板修正，只有最后一次尝试之后才有 compaction.ended/failed。
    const settled = compactionPoints.filter((point) => point.actual !== null)
    assert.ok(settled.length >= 1)
    assert.ok(settled.every((point) => ["completed", "failed"].includes(point.status)))
    assert.ok(compactionPoints.every((point) => ["completed", "failed", "unknown"].includes(point.status)))
    const unique = new Set(settled.map((point) => `${point.seq}:${point.actual.tokens.input}`))
    assert.equal(unique.size, settled.length)
  })
  check("模型声明的输出预留随请求落库，且不超过上下文窗口", () => {
    assert.ok(page.data.every((row) => Number.isInteger(row.outputReserve) && row.outputReserve > 0))
    assert.ok(page.data.every((row) => row.outputReserve <= row.contextWindow))
    assert.ok(page.data.every((row) => row.estimatedTokens + row.outputReserve <= row.contextWindow))
  })
  check("上下文事件与文件活动只暴露结构性元数据", () => {
    assert.ok(analysis.events.length >= 2)
    assert.ok(analysis.events.some((event) => event.type === "execution"))
    assert.ok(analysis.events.some((event) => event.type === "compaction"))
    const serialized = JSON.stringify(analysis)
    assert.ok(!serialized.includes("private system"))
    assert.ok(!serialized.includes("CONTEXT_PROBE_SYSTEM"))
    assert.ok(analysis.files.every((file) => typeof file.path === "string" && typeof file.calls === "number"))
    assert.equal(analysis.eventsTruncated, false)
    assert.equal(analysis.next, undefined)
  })
  const family = (await api("GET", `${root}/context-insights/family`)).data
  check("Agent 家族只沿父级链路聚合，fork 不并入", () => {
    assert.equal(family.rootID, sessionID)
    assert.equal(family.members.length, 1)
    assert.equal(family.members[0].sessionID, sessionID)
    assert.equal(family.complete, true)
    assert.ok(typeof family.members[0].usage.cost === "number")
  })
  const to = Date.now()
  const overview = (
    await api("POST", "/api/context-insights/overview", { sessionIDs: [sessionID, otherID], from: to - 3600_000, to })
  ).data
  check("跨会话总览只聚合显式授权会话，按 UTC 结算事件归因", () => {
    assert.equal(overview.sessions.length, 2)
    assert.equal(overview.attribution, "settlement-utc")
    assert.equal(overview.coverage, "available-durable-events")
    assert.ok(overview.days.length >= 1)
    const totalSettlements = overview.days.reduce((sum, day) => sum + day.settlements, 0)
    assert.ok(totalSettlements >= 2)
    assert.ok(overview.days.every((day) => day.tokens >= 0 && day.cost >= 0 && Array.isArray(day.sessionIDs)))
    assert.ok(overview.days.some((day) => day.sessionIDs.includes(sessionID)))
  })
  const invalidOverview = await fetch(`${base}/api/context-insights/overview`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionIDs: [], from: 100, to: 0 }),
  })
  check("总览拒绝非法时间范围", () => assert.equal(invalidOverview.status, 400))
  await Promise.resolve()
  if (process.env.SECOND_BASE) {
    const response = await fetch(
      `${process.env.SECOND_BASE}${root}/context-insights/requests/${primary[0].id}/items/0`,
      {
        headers,
        signal: AbortSignal.timeout(30_000),
      },
    )
    check("另一 SaaS 实例从 PG 读取同一快照正文", () => assert.equal(response.status, 200))
  }
  check("SSE 实时通知只带摘要，执行成功", () => {
    assert.ok(events.some((event) => event.type === "session.execution.succeeded"))
    const captured = events.filter((event) => event.type === "session.context.captured")
    assert.ok(captured.length >= 2)
    assert.ok(!JSON.stringify(captured).includes("CONTEXT_PROBE_SYSTEM"))
    assert.ok(!events.some((event) => event.type === "session.execution.failed"))
  })
  const query = (sql) =>
    JSON.parse(execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim())
  const rows = query(
    `SELECT json_build_object('requests', (SELECT count(*) FROM session_context_request WHERE session_id='${sessionID}'), 'contents', (SELECT count(*) FROM session_context_content WHERE session_id='${sessionID}'), 'events', (SELECT count(*) FROM event WHERE aggregate_id='${sessionID}' AND type='session.context.captured.1'), 'tokens', (SELECT tokens_input + tokens_output + tokens_cache_read FROM session_v2 WHERE id='${sessionID}'))`,
  )
  check("PG 请求记录、事件与 API 数量一致，实际用量仍由原链路结算", () => {
    assert.equal(Number(rows.requests), summary.capturedRequests)
    assert.equal(Number(rows.events), summary.capturedRequests)
    assert.ok(Number(rows.contents) > 0)
    assert.ok(Number(rows.tokens) > 0)
  })
  const unauthorized = await fetch(`${base}${root}/context-insights`)
  check("未认证访问被拒绝", () => assert.equal(unauthorized.status, 401))
  outcome = { passed: true, sandboxExecutionVerified: false, pg: rows }
} catch (error) {
  outcome = { passed: false, sandboxExecutionVerified: false, error: String(error) }
  console.error(error)
  process.exitCode = 1
} finally {
  abort.abort()
  await watching
  if (streamError) {
    outcome.passed = false
    outcome.streamError = streamError
    process.exitCode = 1
  }
  writeFileSync(join(evidence, "events.json"), JSON.stringify(events, null, 2))
  writeFileSync(join(evidence, "provider-requests.json"), JSON.stringify(requests, null, 2))
  for (const id of [sessionID, otherID].filter(Boolean)) {
    try {
      await api("DELETE", `/api/session/${id}`)
    } catch (error) {
      console.error(`测试会话清理失败：${String(error)}`)
      outcome.passed = false
      outcome.cleanupError = String(error)
      process.exitCode = 1
    }
  }
  provider.stop(true)
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ...outcome, sessionID, cases: results }, null, 2))
  console.log(`证据目录：${evidence}`)
}
