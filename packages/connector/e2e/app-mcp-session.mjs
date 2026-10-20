// Real SaaS model turn. Run in background; observe GET /api/session/:id/event separately.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { Pool } from "pg"

const base = process.env.MCP_VERIFY_URL ?? "http://localhost:14100"
const password = process.env.MCP_VERIFY_PASSWORD
const sid = process.env.MCP_VERIFY_SESSION_ID
const owner = process.env.MCP_VERIFY_OWNER_ID
const deployment = process.env.MCP_VERIFY_DEPLOYMENT_ID
const output = process.env.MCP_VERIFY_SESSION_OUTPUT
const pgUrl = process.env.MCP_VERIFY_PG_URL
if (!password || !sid || !owner || !deployment || !output || !pgUrl || !new URL(pgUrl).pathname.endsWith("-test"))
  throw new Error("Require isolated MCP_VERIFY_* session, owner, deployment, output and *-test database")
await mkdir(output, { recursive: true, mode: 0o700 })
const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" }
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 600_000)
const events = []
const promptEvents = []
const cases = []
const attempts = new Map()
const db = new Pool({ connectionString: pgUrl, max: 2 })
const persist = () => writeFile(`${output}/result.json`, JSON.stringify({ sid, owner, deployment, cases, eventCount: events.length }, null, 2), { mode: 0o600 })
async function check(name, work) {
  try { await work(); cases.push({ name, passed: true }); console.log(`通过 ${name}`) }
  catch (error) { cases.push({ name, passed: false, message: error instanceof Error ? error.message : String(error) }); console.log(`失败 ${name}`) }
  await persist()
}
async function* sse(response) {
  if (!response.ok) throw new Error(`SSE HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  assert(response.body)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith("data:")) continue
        try { yield JSON.parse(line.slice(5)) } catch {}
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
async function answer(form) {
  if (!form?.id || (attempts.get(form.id) ?? 0) >= 2) return
  attempts.set(form.id, (attempts.get(form.id) ?? 0) + 1)
  const answer = {}
  for (const field of form.fields ?? []) {
    if (field.type === "external") continue
    if (field.when?.some((condition) => {
      const value = answer[condition.key]
      const matches = Array.isArray(value) ? value.includes(condition.value) : value === condition.value
      return condition.op === "eq" ? !matches : matches
    })) continue
    answer[field.key] = field.default ?? (field.type === "boolean" ? true : ["integer", "number"].includes(field.type)
      ? field.minimum ?? 1 : field.type === "multiselect" ? (field.options ?? []).slice(0, Math.max(1, field.minItems ?? 1)).map((item) => item.value)
      : field.options?.[0]?.value ?? "继续执行隔离只读验收")
  }
  const response = await fetch(`${base}/api/session/${sid}/form/${form.id}/reply`, { method: "POST", headers, body: JSON.stringify({ answer }) })
  console.log(`form · 自动回答 HTTP ${response.status}`)
}
let subscription
let poll
try {
  const before = Number((await db.query("select count(*) from connector.runs where action_id='hackernews.get_item' and caller='mcp' and ok=1")).rows[0]?.count)
  const response = await fetch(`${base}/api/session/${sid}/event`, { headers, signal: controller.signal })
  assert.equal(response.status, 200)
  subscription = (async () => {
    for await (const event of sse(response)) {
      events.push(event)
      if (event.type === "form.created") await answer(event.data?.form ?? event.data)
    }
  })().catch((error) => { if (!controller.signal.aborted) console.log(`会话订阅异常：${String(error).slice(0, 150)}`) })
  poll = setInterval(() => {
    void fetch(`${base}/api/session/${sid}/form`, { headers, signal: controller.signal }).then(async (r) => {
      if (!r.ok) return
      const body = await r.json()
      for (const form of (Array.isArray(body) ? body : body.data ?? body.forms ?? [])) await answer(form)
    }).catch(() => {})
  }, 2000)
  const model = { providerID: "Yd-GLM", id: "glm-5.3" }
  const prompt = await fetch(`${base}/api/session/${sid}/prompt_stream`, {
    method: "POST", headers, signal: controller.signal,
    body: JSON.stringify({ model, text: "这是隔离的应用 MCP 验收，请执行一次只读查询。会话已注册 app_mcp_verification（Hacker News 应用 MCP），只开放 get_item。你必须通过 Code Mode 的 execute 工具，发现并调用该 MCP 的 get_item 工具，参数 id=8863。禁止使用 fetch、curl、shell、网页搜索或其他绕行方式获取数据；不要修改文件，不执行第三方写操作。必须依据实际 MCP 输出回复，成功时最终回复包含 APP_MCP_SESSION_OK、id=8863 和该条目的真实标题。工具不可用则如实说明失败，禁止伪造成功标记。无需提问，如需确认应继续只读测试。" }),
  })
  for await (const event of sse(prompt)) {
    promptEvents.push(event)
    if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)) break
  }
  const combined = [...events, ...promptEvents]
  await check("模型轮次执行成功", async () => assert(combined.some((event) => event.type === "session.execution.succeeded")))
  await check("Code Mode 实际生效", async () => {
    const names = combined.filter((event) => event.type === "session.tool.input.started").map((event) => String(event.data?.name ?? ""))
    assert(names.some((name) => /execute|code.?mode/i.test(name)), `Tool names: ${names.join(",")}`)
  })
  await check("回复包含实际查询结果与成功标记", async () => {
    const text = combined.filter((event) => event.type === "session.text.ended").map((event) => event.data?.text ?? "").join("\n")
    assert(text.includes("APP_MCP_SESSION_OK")); assert(text.includes("8863")); assert(/My YC app|Dropbox/i.test(text))
  })
  await check("SSE 工具轨迹包含应用 MCP 调用且成功", async () => {
    const tools = combined.filter((event) => event.type.startsWith("session.tool."))
    assert(tools.some((event) => /hackernews__get_item|app_mcp_verification/.test(JSON.stringify(event.data))))
    assert(tools.some((event) => event.type === "session.tool.success" && /8863/.test(JSON.stringify(event.data))))
  })
  await check("PG 确认真实 MCP action 执行并保持固定权限", async () => {
    const after = Number((await db.query("select count(*) from connector.runs where action_id='hackernews.get_item' and caller='mcp' and ok=1")).rows[0]?.count)
    assert(after > before)
    const row = (await db.query("select session_id,service,tools_json,token_hash from connector_mcp_deployment where id=$1", [deployment])).rows[0]
    assert(row); assert.equal(row.session_id, owner); assert.equal(row.service, "hackernews")
    assert.deepEqual(JSON.parse(row.tools_json).map((tool) => tool.actionId), ["hackernews.get_item"])
    assert(/^[a-f0-9]{64}$/.test(row.token_hash))
    const mcp = await fetch(`${base}/api/session/${sid}/mcps`, { headers })
    assert(mcp.ok)
    assert(JSON.stringify(await mcp.json()).includes("app_mcp_verification"))
  })
} catch (error) {
  cases.push({ name: "运行环境", passed: false, message: error instanceof Error ? error.message : String(error) })
} finally {
  if (poll) clearInterval(poll)
  clearTimeout(timer); controller.abort(); await subscription
  await writeFile(`${output}/session-events.json`, JSON.stringify(events, null, 2), { mode: 0o600 })
  await writeFile(`${output}/prompt-events.json`, JSON.stringify(promptEvents, null, 2), { mode: 0o600 })
  await persist(); await db.end()
  console.log(JSON.stringify({ sid, passed: cases.filter((item) => item.passed).length, total: cases.length, failures: cases.filter((item) => !item.passed) }))
  if (cases.some((item) => !item.passed)) process.exitCode = 1
}
