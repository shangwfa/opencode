// 旁路脚本 v2：独立进程 open-connector runtime（同 PG/dataDir/密钥），直接 fetch /mcp
// 用法: bun bypass-engine.mjs mcp <bearerToken> <json-rpc-payload-json>
const modPath = new URL("../src/engine/server/connector-runtime.ts", import.meta.url).href
const { createConnectorRuntime } = await import(modPath)

const runtime = await createConnectorRuntime({
  dataDir: "/tmp/opencode-connector-e2e-data",
  publicOrigin: "http://127.0.0.1:14963/connector",
  encryptionKey: "e2e-test-encryption-key-20261010",
  adminToken: "e2e-admin-token-20261010",
  postgres: { connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/opencode-v2-up?options=-c%20search_path%3Dconnector" },
})

const [, , cmd, ...args] = process.argv
try {
  if (cmd === "mcp") {
    const [token, payloadJson] = args
    const res = await runtime.fetch(new Request("http://127.0.0.1:14963/connector/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: payloadJson,
    }))
    const text = await res.text()
    console.log(JSON.stringify({ status: res.status, body: text ? safeJson(text) : null }))
  } else if (cmd === "create") {
    const res = await runtime.fetch(new Request("http://127.0.0.1:14963/connector/v1/connections/postmark/connect/api-key", {
      method: "POST",
      headers: { authorization: "Bearer e2e-admin-token-20261010", "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "e2e-fake-bypass-key" }),
    }))
    console.log(JSON.stringify({ status: res.status, body: safeJson(await res.text()) }))
  } else if (cmd === "admin-mcp") {
    // 用 admin token 直连引擎 /mcp（预期 401：runtime scope 不认 admin token）
    const [payloadJson] = args
    const res = await runtime.fetch(new Request("http://127.0.0.1:14963/connector/mcp", {
      method: "POST",
      headers: { authorization: "Bearer e2e-admin-token-20261010", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: payloadJson,
    }))
    console.log(JSON.stringify({ status: res.status, body: safeJson(await res.text()) }))
  }
} finally {
  await runtime.close()
}
function safeJson(text) {
  try { return JSON.parse(text) } catch { return text }
}
