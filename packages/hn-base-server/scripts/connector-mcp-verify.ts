/**
 * Connector MCP 验证：配置生成 → 注册临时会话 → JSON-RPC tools/list + tools/call → 清理。
 * 需要 HARNESS_VERIFY_AUTH_FILE（基础服务 Bearer token）和 opencode_shell_test 的 SaaS 访问。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises"
import assert from "node:assert/strict"
import { saasFetch } from "../src/lib/saas.js"
import { pool } from "../src/db/index.js"

const output = process.env.CONNECTOR_VERIFY_OUTPUT
const authFile = process.env.HARNESS_VERIFY_AUTH_FILE
if (!output || !authFile) throw new Error("需要 CONNECTOR_VERIFY_OUTPUT 与 HARNESS_VERIFY_AUTH_FILE")
await mkdir(output, { recursive: true })
const token = (await readFile(authFile, "utf8")).trim()
const base = process.env.CONNECTOR_VERIFY_BASE ?? "http://localhost:3201"
const cases: Array<{ name: string; passed: boolean; detail?: string }> = []
let sessionID: string | undefined
let config: { name: string; config: { url: string; headers: { authorization: string } } } | undefined
const persist = () => writeFile(`${output}/connector-mcp-result.json`, JSON.stringify({ sessionID, configURL: config?.config.url, cases }, null, 2))
const api = async (path: string, init?: RequestInit) =>
  fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) } })
const mcp = async (body: unknown) => {
  const response = await fetch(config!.config.url, {
    method: "POST",
    headers: { authorization: config!.config.headers.authorization, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch {}
  return { status: response.status, parsed, text }
}
const call = async (name: string, args: unknown) => {
  const response = await mcp({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } })
  assert.equal(response.status, 200)
  const result = response.parsed?.body?.result
  assert(result, `tools/call ${name} 缺少 result: ${response.text.slice(0, 200)}`)
  return result
}
const run = async (name: string, work: () => Promise<void>) => {
  try { await work(); cases.push({ name, passed: true }); console.log(`通过 ${name}`) }
  catch (error) { const detail = error instanceof Error ? error.message : String(error); cases.push({ name, passed: false, detail }); console.log(`失败 ${name}: ${detail.slice(0, 220)}`) }
  await persist()
}
try {
  await run("创建临时会话", async () => {
    const response = await api("/api/sessions", { method: "POST", body: JSON.stringify({ title: "连接器 MCP 验证", directory: "/workspace" }) })
    assert.equal(response.status, 201)
    const body = (await response.json()) as { session?: { id?: string } }
    sessionID = body.session?.id
    assert(sessionID)
  })
  await run("生成基础服务 MCP 配置", async () => {
    const response = await api("/api/connectors/mcp", { method: "POST" })
    assert.equal(response.status, 201)
    config = (await response.json()) as NonNullable<typeof config>
    assert.equal(config?.name, "connector")
    assert.equal(config?.config.url, `${base}/api/connector/mcp`) // base 默认 no slash
    assert(config?.config.headers.authorization.startsWith("Bearer "))
  })
  await run("注册 MCP 到临时会话", async () => {
    const response = await api(`/api/sessions/${encodeURIComponent(sessionID!)}/mcp`, { method: "POST", body: JSON.stringify(config) })
    assert.equal(response.status, 201)
    const body = (await response.json()) as { id?: string }
    assert(body.id?.startsWith("smcp_"))
  })
  await run("MCP initialize", async () => {
    const response = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "connector-verify", version: "1" } } })
    assert.equal(response.status, 200)
    assert(response.parsed?.body?.result?.serverInfo?.name)
  })
  await run("MCP tools/list 暴露五个工具", async () => {
    const response = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    assert.equal(response.status, 200)
    const tools = response.parsed?.body?.result?.tools ?? []
    for (const name of ["list_apps", "list_connections", "search_actions", "get_action_guide", "execute_action"]) assert(tools.some((tool: any) => tool.name === name), `缺少 ${name}`)
  })
  await run("tools/call list_connections", async () => {
    const result = await call("list_connections", {})
    const text = JSON.stringify(result)
    assert(text.includes("github") || text.includes("connection"), "未返回连接")
  })
  await run("tools/call search_actions", async () => {
    const result = await call("search_actions", { service: "github", query: "repository", limit: 5 })
    assert(JSON.stringify(result).includes("github."), "未返回 GitHub action")
  })
  await run("tools/call get_action_guide", async () => {
    const result = await call("get_action_guide", { actionId: "github.get_current_user" })
    assert(JSON.stringify(result).length > 50, "动作指南为空")
  })
  await run("tools/call execute_action 只读验证", async () => {
    const listed = await call("list_connections", {})
    const connections = JSON.parse(listed.content?.[0]?.text ?? "{}").data ?? []
    const github = connections.find((item: { service?: string }) => item.service === "github")
    assert(github, "没有 GitHub 连接")
    const result = await call("execute_action", {
      actionId: "github.get_current_user",
      connectionName: github.connectionName,
      input: {},
    })
    const text = result.content?.[0]?.text ?? "{}"
    const action = JSON.parse(text) as { ok?: boolean; error?: unknown; data?: Record<string, unknown> }
    assert.equal(action.ok, true, text.slice(0, 300))
    assert(Object.keys(action.data ?? {}).length > 0, "动作结果为空")
    // 只落盘结构，不保存 GitHub 个人资料。
    await writeFile(`${output}/connector-mcp-action.json`, JSON.stringify({ ok: action.ok, dataKeys: Object.keys(action.data ?? {}) }, null, 2))
  })
} finally {
  if (sessionID) {
    await run("清理临时会话", async () => {
      let response = await saasFetch(`/api/session/${encodeURIComponent(sessionID!)}`, { method: "DELETE" })
      for (let attempt = 0; attempt < 12 && response.status === 409; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        response = await saasFetch(`/api/session/${encodeURIComponent(sessionID!)}`, { method: "DELETE" })
      }
      assert(response.ok || response.status === 404, `清理会话 HTTP ${response.status}`)
    })
  }
  await persist()
  await pool.end()
  if (cases.some((item) => !item.passed)) process.exitCode = 1
}
