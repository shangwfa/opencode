// Agent 链路补测：Code Mode 模型链路（sandbox runner 经端口网关）、Tool Host 自定义工具、
// Session 本地 MCP 桥接（supergateway 经端口网关）。通过 sandbox-vercel-t19.mjs 包装器运行。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"

const base = process.env.BASE.replace(/\/$/, "")
const headers = {
  "content-type": "application/json",
  authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`,
}
const model = { providerID: "deepseek", id: "deepseek-flash" }
const report = { scenarios: [] }
const sql = (statement) => execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", statement], { encoding: "utf8" }).trim()

const createSession = async (title) => {
  const response = await fetch(`${base}/api/session`, { method: "POST", headers, body: JSON.stringify({ title }), signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200)
  return (await response.json()).data
}
const prompt = async (sessionID, text) => {
  const response = await fetch(`${base}/api/session/${sessionID}/prompt_stream`, {
    method: "POST", headers, body: JSON.stringify({ text, model }), signal: AbortSignal.timeout(300_000),
  })
  assert.equal(response.status, 200, `prompt HTTP ${response.status}`)
  let stream = ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    stream += decoder.decode(value, { stream: true })
  }
  const events = stream.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
  const failed = events.find((event) => /failed/.test(event.type ?? ""))
  const answer = events.filter((event) => event.type === "session.text.ended").map((event) => event.data?.text ?? "").join(" ")
  return { events, text: answer, failed }
}
const toolCalled = (events, name) => events.some((event) => event.type === "session.tool.input.started" && event.data?.name === name)
const toolSucceeded = (events) => events.some((event) => event.type === "session.tool.success")

// ── 场景 1：Code Mode 模型链路（execute 工具 → sandbox runner WS → 端口网关）──
if (!process.env.PROBE_CHAIN_SCENARIO || process.env.PROBE_CHAIN_SCENARIO === "codemode") {
  const session = await createSession("agent-chain-codemode")
  const result = await prompt(session.id, '请调用 execute 工具执行代码 `return 2 ** 10`，然后把工具返回的数字作为最终回复的唯一内容。')
  assert.equal(result.failed, undefined, `Code Mode 执行失败: ${JSON.stringify(result.failed ?? null).slice(0, 300)}`)
  assert.ok(toolCalled(result.events, "execute"), "模型未调用 execute 工具")
  assert.ok(toolSucceeded(result.events), "execute 工具未成功")
  assert.match(result.text, /1024/)
  report.scenarios.push({ scenario: "codemode-model-chain", status: "passed", tool: "execute", text: result.text.trim().slice(0, 60) })
  console.log("✅ Code Mode 模型链路：execute 工具经 sandbox runner + 端口网关返回 1024")
}

// ── 场景 2：Tool Host 自定义工具（session-tool-host 经端口网关）──
if (!process.env.PROBE_CHAIN_SCENARIO || process.env.PROBE_CHAIN_SCENARIO === "toolhost") {
  const session = await createSession("agent-chain-toolhost")
  const created = await fetch(`${base}/api/session/${session.id}/tools`, {
    method: "POST", headers,
    body: JSON.stringify({ name: "chain_probe", description: "returns a marker", code: "export default {description:'chain probe',args:{},execute(){return 'TOOL-HOST-OK'}}" }),
    signal: AbortSignal.timeout(30_000),
  })
  assert.ok([200, 204].includes(created.status), `tool create HTTP ${created.status}`)
  const result = await prompt(session.id, "请调用 chain_probe 工具，并把工具返回的字符串原样作为最终回复。")
  assert.equal(result.failed, undefined, `Tool Host 执行失败: ${JSON.stringify(result.failed ?? null).slice(0, 300)}`)
  assert.ok(toolCalled(result.events, "chain_probe"), "模型未调用 chain_probe")
  assert.ok(toolSucceeded(result.events), "chain_probe 未成功")
  assert.match(result.text, /TOOL-HOST-OK/)
  report.scenarios.push({ scenario: "tool-host", status: "passed", tool: "chain_probe", text: result.text.trim().slice(0, 60) })
  console.log("✅ Tool Host 自定义工具：session-tool-host 经端口网关执行并返回 TOOL-HOST-OK")
}

// ── 场景 3：Session 本地 MCP（supergateway 桥接经端口网关）──
if (!process.env.PROBE_CHAIN_SCENARIO || process.env.PROBE_CHAIN_SCENARIO === "mcp") {
  const session = await createSession("agent-chain-mcp")
  // The SaaS materializes its own HTTP bridge into the workspace; no sandbox install needed.
  const defined = await fetch(`${base}/api/session/${session.id}/mcps`, {
    method: "POST", headers,
    body: JSON.stringify({ name: "everything", config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"] } }),
    signal: AbortSignal.timeout(30_000),
  })
  assert.ok([200, 204].includes(defined.status), `mcp create HTTP ${defined.status}: ${defined.status === 200 ? "" : await defined.text()}`)
  const list = await fetch(`${base}/api/session/${session.id}/mcps`, { headers, signal: AbortSignal.timeout(30_000) })
  assert.equal(list.status, 200)
  assert.ok((await list.json()).data.some((info) => info.name === "everything"), "MCP 定义未持久化")
  // 连接按需 reconcile：模型轮次构建上下文拉起桥接，随后实际调用 MCP 工具完成验证。
  const warmed = await prompt(session.id, "只回复 ok")
  assert.equal(warmed.failed, undefined, `MCP 会话模型轮次失败: ${JSON.stringify(warmed.failed ?? null).slice(0, 300)}`)
  const result = await prompt(session.id, "工具列表中应有一个来自 everything 服务器的 echo 工具（名称可能形如 everything_echo 或 everything.echo）。请调用它，参数 message 的值为字符串 'MCP-CHAIN-OK'，然后把工具返回内容原样作为最终回复。")
  assert.equal(result.failed, undefined, `MCP 工具调用失败: ${JSON.stringify(result.failed ?? null).slice(0, 300)}`)
  // Code Mode 下 MCP 调用发生在 execute 内部，顶层工具事件只有 execute；
  // 因此同时接受顶层工具名和 progress metadata 中的嵌套调用名。
  const used = new Set()
  for (const event of result.events) {
    if (event.type === "session.tool.input.started" && event.data?.name) used.add(event.data.name)
    for (const call of event.data?.metadata?.toolCalls ?? []) if (call?.tool) used.add(call.tool)
  }
  const echoCalls = [...used].filter((name) => /echo/i.test(name))
  assert.ok(echoCalls.length > 0, `模型未调用 echo MCP 工具，实际工具: ${JSON.stringify([...used])}`)
  const nested = result.events.flatMap((event) => event.data?.metadata?.toolCalls ?? [])
  assert.ok(nested.some((call) => /echo/i.test(call.tool) && call.status === "completed" && call.input?.message === "MCP-CHAIN-OK"), "缺少真实完成的 echo MCP 调用")
  assert.ok(!nested.some((call) => call.status === "error"), "MCP 调用曾失败；不能以模型重试掩盖过程错误")
  assert.match(result.text, /MCP-CHAIN-OK/)
  report.scenarios.push({ scenario: "session-mcp-local", status: "passed", tools: echoCalls })
  console.log(`✅ Session 本地 MCP：自研 HTTP 桥接经端口网关连接并调用 ${echoCalls.join(", ")}`)
  for (let round = 2; round <= Number(process.env.PROBE_MCP_ROUNDS ?? 1); round++) {
    const marker = `MCP-CHAIN-OK-${round}`
    const replay = await prompt(session.id, `再次调用 everything 的 echo 工具，message 为 '${marker}'，返回工具结果。`)
    assert.equal(replay.failed, undefined)
    const calls = replay.events.flatMap((event) => event.data?.metadata?.toolCalls ?? [])
    assert.ok(calls.some((call) => /echo/i.test(call.tool) && call.status === "completed" && call.input?.message === marker))
    assert.ok(!calls.some((call) => call.status === "error"), `MCP 第 ${round} 轮存在工具错误`)
    report.scenarios.push({ scenario: `session-mcp-round-${round}`, status: "passed", calls })
    console.log(`✅ Session MCP 第 ${round} 轮：真实调用完成，无工具错误`)
  }
}

await mkdir(process.env.STRESS_OUT, { recursive: true })
await writeFile(`${process.env.STRESS_OUT}/agent-chain-report.json`, JSON.stringify(report, null, 2))
console.log("AGENT-CHAIN", JSON.stringify(report))
