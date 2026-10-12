// 旁路脚本：独立进程 open-connector runtime（同 PG/dataDir/密钥），任意 method/path 直调引擎
// 用法: bun bypass-raw.mjs <method> <path> [bodyJson] [bearerToken]
const modPath = new URL("../src/engine/server/connector-runtime.ts", import.meta.url).href
const { createConnectorRuntime } = await import(modPath)

const runtime = await createConnectorRuntime({
  dataDir: "/tmp/opencode-connector-e2e-data",
  publicOrigin: "http://127.0.0.1:14963/connector",
  encryptionKey: "e2e-test-encryption-key-20261010",
  adminToken: "e2e-admin-token-20261010",
  postgres: { connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/opencode-v2-up?options=-c%20search_path%3Dconnector" },
})

const [, , method, path, bodyJson, bearer] = process.argv
try {
  const res = await runtime.fetch(
    new Request(`http://127.0.0.1:14963/connector${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer ?? "e2e-admin-token-20261010"}`,
        "content-type": "application/json",
      },
      ...(bodyJson ? { body: bodyJson } : {}),
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
