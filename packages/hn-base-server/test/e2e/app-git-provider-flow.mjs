import assert from "node:assert/strict"
import pg from "pg"

const base = process.env.BASE ?? "http://localhost:3201"
const appId = process.env.E2E_APP_ID ?? "rumu-demo-001"
const providerId = process.env.E2E_PROVIDER_ID
const token = process.env.E2E_TOKEN
assert(token && providerId, "请提供 E2E_TOKEN 和 E2E_PROVIDER_ID")
const headers = { authorization: `Bearer ${token}`, origin: process.env.E2E_ORIGIN ?? "http://localhost:3002", "content-type": "application/json" }
const endpoint = `${base}/api/apps/${encodeURIComponent(appId)}/git-provider`
const patch = (body, auth = headers) => fetch(endpoint, { method: "PATCH", headers: auth, body: JSON.stringify(body) })

const client = new pg.Client({ connectionString: process.env.BASE_DATABASE_URL ?? "postgres://postgres:ab123456@127.0.0.1:5432/opencode-v2-up" })
try {
  const good = await patch({ gitProviderId: providerId })
  assert.equal(good.status, 200)
  assert.equal((await good.json()).gitProviderInstanceId, providerId)
  console.log("✓ 应用可以切换到已授权连接")
  assert.equal((await patch({ gitProviderId: "gp_not_available" })).status, 404)
  assert.equal((await patch({ gitProviderId: "" })).status, 400)
  assert.equal((await patch({ gitProviderId: providerId }, { "content-type": "application/json" })).status, 401)
  console.log("✓ 无权使用、无效参数及未登录请求被拒绝")
  await client.connect()
  const schema = process.env.BASE_DATABASE_SCHEMA ?? "hn_base_dev"
  assert(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema))
  const row = await client.query(`select git_provider_instance_id from "${schema}"."app" where app_id=$1`, [appId])
  assert.equal(row.rows[0]?.git_provider_instance_id, providerId)
  console.log("✓ PG 保存新绑定，失败请求没有覆盖绑定")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await client.end()
}
