import { readFile, writeFile } from "node:fs/promises"
import { Sandbox } from "e2b"
import { McpHttpBridge } from "../src/session/mcp-http-bridge"

if (process.env.OPENCODE_ALIYUN_SPIKE !== "1") throw new Error("Explicit billable-resource opt-in required")
const settings = process.env.OPENCODE_ALIYUN_ENV_FILE ? Object.fromEntries((await readFile(process.env.OPENCODE_ALIYUN_ENV_FILE, "utf8")).trim().split("\n").map((line) => {
  const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]
})) : process.env
const connection = { apiKey: settings.OPENCODE_ALIYUN_API_KEY, apiUrl: settings.OPENCODE_ALIYUN_API_URL, domain: settings.OPENCODE_ALIYUN_DOMAIN, requestTimeoutMs: 120000 }
const sandbox = await Sandbox.create("code-interpreter-v1", { ...connection, timeoutMs: 600000, secure: true, network: { allowPublicTraffic: false } })
const port = 18993
const evidence: Record<string, unknown> = { sandboxId: sandbox.sandboxId }
const url = () => `https://${sandbox.getHost(port)}/mcp`
const token = () => sandbox.trafficAccessToken ?? ""
const post = async (label: string, body: Record<string, unknown>) => {
  const started = Date.now()
  const response = await fetch(url(), { method: "POST", headers: { "content-type": "application/json", "e2b-traffic-access-token": token() }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) })
  const text = await response.text()
  return { label, status: response.status, ms: Date.now() - started, body: text.slice(0, 100) }
}
try {
  await sandbox.files.write("/tmp/echo.mjs", `import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}}:{tools:[{name:'echo',inputSchema:{type:'object'}}]}}))}`)
  // The exact production bridge script, including the GET SSE notification stream.
  await sandbox.files.write("/tmp/bridge.mjs", McpHttpBridge.script)
  await sandbox.commands.run(`nohup node /tmp/bridge.mjs --stdio 'node /tmp/echo.mjs' --port ${port} >/tmp/bridge.log 2>&1 </dev/null & sleep 1`, { timeoutMs: 10000 })
  // Session lifecycle mirroring the SaaS client: POST SSE streams + GET notification stream.
  evidence.initialize = await post("initialize", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } } })
  evidence.initialized = await post("initialized", { jsonrpc: "2.0", method: "notifications/initialized" })
  const controller = new AbortController()
  const sse = fetch(url(), { headers: { accept: "text/event-stream", "e2b-traffic-access-token": token() }, signal: controller.signal })
  evidence.sseStatus = (await sse).status
  // Give the gateway time to classify the long stream, then idle exactly like a model turn.
  const series: Array<Record<string, unknown>> = []
  for (const idle of [45, 75, 120]) {
    await new Promise((resolve) => setTimeout(resolve, idle * 1000))
    const call = await post(`tools/call-after-${idle}s`, { jsonrpc: "2.0", id: 100 + idle, method: "tools/list" })
    series.push(call)
    console.log(`sse-open idle=${idle}s → ${call.status} (${call.ms}ms) ${call.body.slice(0, 60)}`)
    if (call.status !== 200) {
      const retry = await post(`retry-after-${idle}s`, { jsonrpc: "2.0", id: 200 + idle, method: "tools/list" })
      series.push(retry)
      console.log(`  immediate retry → ${retry.status}`)
    }
  }
  evidence.series = series
  controller.abort()
} finally {
  evidence.killed = await sandbox.kill()
  await writeFile(process.env.OPENCODE_ALIYUN_EVIDENCE ?? "../../artifacts/aliyun-sandbox/sse-spike.json", JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
}
