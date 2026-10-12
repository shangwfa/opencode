// 旁路脚本：独立进程 open-connector runtime（同 PG/dataDir/密钥），直连引擎 runtime API /v1/actions/:actionId
// 用途：验证引擎动作执行与 idempotency-key 幂等回放（SaaS HTTP 层未暴露 execute 端点时的引擎能力对照）
// 用法: bun bypass-actions.mjs <bearerToken> <actionId> <bodyJson> [idempotencyKey]
const modPath = new URL("../src/engine/server/connector-runtime.ts", import.meta.url).href
const { createConnectorRuntime } = await import(modPath)

const runtime = await createConnectorRuntime({
  dataDir: "/tmp/opencode-connector-e2e-data",
  publicOrigin: "http://127.0.0.1:14963/connector",
  encryptionKey: "e2e-test-encryption-key-20261010",
  adminToken: "e2e-admin-token-20261010",
  postgres: { connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/opencode-v2-up?options=-c%20search_path%3Dconnector" },
})

const [, , token, actionId, bodyJson, idempotencyKey] = process.argv
try {
  const res = await runtime.fetch(
    new Request(`http://127.0.0.1:14963/connector/v1/actions/${encodeURIComponent(actionId)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: bodyJson,
    }),
  )
  console.log(JSON.stringify({ status: res.status, body: safeJson(await res.text()) }))
} finally {
  await runtime.close()
}
function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
