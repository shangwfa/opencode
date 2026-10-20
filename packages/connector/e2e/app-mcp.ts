/** Isolated Docker API + real SDK + PG verification. No model turn is submitted. */
import assert from "node:assert/strict"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { Schema } from "effect"
import { ConnectorMcp } from "@opencode/schema/connector-mcp"
import { Pool } from "pg"

const base = process.env.MCP_VERIFY_URL ?? "http://localhost:14100"
const password = process.env.MCP_VERIFY_PASSWORD
const pgUrl = process.env.MCP_VERIFY_PG_URL
if (!password || !pgUrl || !new URL(pgUrl).pathname.endsWith("-test")) throw new Error("Require MCP_VERIFY_PASSWORD and dedicated MCP_VERIFY_PG_URL (*-test)")
const db = new Pool({ connectionString: pgUrl, max: 2 })
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const sessions: string[] = []
const deployments: Array<{ owner: string; id: string }> = []
const clients: Client[] = []
const results: Array<{ name: string; passed: boolean; message?: string }> = []
const request = (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, {
  method, headers: { authorization: auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  signal: AbortSignal.timeout(60_000),
})
async function run(name: string, work: () => Promise<void>) {
  try { await work(); results.push({ name, passed: true }); console.log(`通过 ${name}`) }
  catch (error) { results.push({ name, passed: false, message: error instanceof Error ? error.message : String(error) }); console.log(`失败 ${name}`) }
}
const root = (owner: string) => `/api/session/${owner}/connector/mcp-deployments`
async function connect(id: string, token: string) {
  const client = new Client({ name: "app-mcp-docker-verify", version: "1" })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/connector/mcp/${id}`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }))
  return client
}
async function create(owner: string) {
  const response = await request(root(owner), "POST", { name: "应用 MCP API 验证", service: "hackernews", actionIds: ["hackernews.get_item", "hackernews.get_user"] })
  assert.equal(response.status, 200, `Create HTTP ${response.status}: ${(await response.clone().text()).slice(0, 300)}`)
  const issued = Schema.decodeUnknownSync(ConnectorMcp.Issued)(await response.json())
  deployments.push({ owner, id: issued.deployment.id })
  return issued
}
try {
  for (const title of ["MCP 隔离验证 A", "MCP 隔离验证 B"]) {
    const response = await request("/api/session", "POST", { title, location: { directory: "/workspace" } })
    assert.equal(response.status, 200)
    const body = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }))(await response.json())
    sessions.push(body.data.id)
  }
  const owner = sessions[0]; const other = sessions[1]
  assert(owner && other)
  const issued = await create(owner)
  const id = issued.deployment.id
  const tokensBefore = Number((await db.query("select count(*) from connector.runtime_tokens")).rows[0]?.count)
  const runsBefore = Number((await db.query("select count(*) from connector.runs where action_id=$1 and caller='mcp' and ok=1", ["hackernews.get_item"])).rows[0]?.count)
  await run("PG 保存 hash，不保存原始 token", async () => {
    const row = await db.query("select * from connector_mcp_deployment where id=$1", [id])
    assert.equal(row.rows.length, 1)
    assert(!JSON.stringify(row.rows).includes(issued.token))
    assert.equal(row.rows[0].session_id, owner)
    assert.equal(row.rows[0].connection_id, null)
  })
  const client = await connect(id, issued.token)
  const listed = await client.listTools()
  const getItem = listed.tools.find((tool) => tool.name.startsWith("hackernews__get_item_"))
  const getUser = listed.tools.find((tool) => tool.name.startsWith("hackernews__get_user_"))
  assert(getItem && getUser)
  await run("官方客户端握手并直接发现所选业务工具", async () => {
    assert.equal(listed.tools.length, 2)
    assert(!listed.tools.some((tool) => tool.name === "execute_action"))
  })
  await run("真实只读第三方 action 执行", async () => {
    const result = await client.callTool({ name: getItem.name, arguments: { id: 8863 } })
    assert.equal(result.isError, false, "Hacker News read-only action failed")
    assert(JSON.stringify(result).includes("8863"))
  })
  await run("执行记录持久化且不新增内部 runtime token", async () => {
    const runs = Number((await db.query("select count(*) from connector.runs where action_id=$1 and caller='mcp' and ok=1", ["hackernews.get_item"])).rows[0]?.count)
    assert(runs > runsBefore)
    const tokensAfter = Number((await db.query("select count(*) from connector.runtime_tokens")).rows[0]?.count)
    assert.equal(tokensAfter, tokensBefore)
  })
  await run("无效业务参数被拒绝", async () => {
    const result = await client.callTool({ name: getItem.name, arguments: { id: "not-an-integer" } })
    assert.equal(result.isError, true)
  })
  await run("跨 owner 管理与路径凭据隔离", async () => {
    const response = await request(`${root(other)}/${id}/rotate-token`, "POST", { revision: 1 })
    assert.equal(response.status, 404)
    const wrong = await fetch(`${base}/api/connector/mcp/cmcp_${"b".repeat(32)}`, { method: "POST", headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" }, body: "{}" })
    assert.equal(wrong.status, 401)
  })
  await run("白名单修改后缓存的旧工具也不可调用", async () => {
    const updated = await request(`${root(owner)}/${id}`, "PATCH", { revision: 1, actionIds: ["hackernews.get_item"] })
    assert.equal(updated.status, 200)
    const current = await client.listTools()
    assert.deepEqual(current.tools.map((tool) => tool.name), [getItem.name])
    let rejected = false
    try { const result = await client.callTool({ name: getUser.name, arguments: { id: "pg" } }); rejected = result.isError === true }
    catch { rejected = true }
    assert(rejected)
  })
  let rotated: typeof ConnectorMcp.Issued.Type | undefined
  await run("原子轮换拒绝旧凭据与过期 revision", async () => {
    const stale = await request(`${root(owner)}/${id}/rotate-token`, "POST", { revision: 1 })
    assert.equal(stale.status, 409)
    const response = await request(`${root(owner)}/${id}/rotate-token`, "POST", { revision: 2 })
    assert.equal(response.status, 200)
    rotated = Schema.decodeUnknownSync(ConnectorMcp.Issued)(await response.json())
    await assert.rejects(() => client.listTools())
    const next = await connect(id, rotated.token)
    assert.equal((await next.listTools()).tools.length, 1)
  })
  await run("停用立即禁止新调用", async () => {
    assert(rotated)
    const response = await request(`${root(owner)}/${id}`, "PATCH", { revision: 3, status: "disabled" })
    assert.equal(response.status, 200)
    const rejected = await fetch(`${base}/api/connector/mcp/${id}`, { method: "POST", headers: { authorization: `Bearer ${rotated.token}`, "content-type": "application/json" }, body: "{}" })
    assert.equal(rejected.status, 401)
  })
} finally {
  for (const client of clients) await client.close().catch(() => {})
  for (const item of deployments) await run("删除测试 MCP", async () => {
    const response = await request(`${root(item.owner)}/${item.id}`, "DELETE")
    assert.equal(response.status, 204)
    const rows = await db.query("select status,token_hash from connector_mcp_deployment where id=$1", [item.id])
    assert.equal(rows.rows[0]?.status, "deleted")
    assert.equal(rows.rows[0]?.token_hash, "")
  })
  for (const id of sessions) await run("删除测试会话", async () => {
    const response = await request(`/api/session/${id}`, "DELETE")
    assert([204, 404].includes(response.status), `Session cleanup HTTP ${response.status}`)
  })
  await db.end()
  const file = process.env.MCP_VERIFY_OUTPUT
  if (file) await Bun.write(file, JSON.stringify({ base, results }, null, 2))
  console.log(JSON.stringify({ passed: results.filter((item) => item.passed).length, total: results.length, failures: results.filter((item) => !item.passed) }))
  if (results.some((item) => !item.passed)) process.exitCode = 1
}
