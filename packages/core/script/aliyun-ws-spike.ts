import { readFile, writeFile } from "node:fs/promises"
import { Sandbox } from "e2b"

if (process.env.OPENCODE_ALIYUN_SPIKE !== "1") throw new Error("Explicit billable-resource opt-in required")
const settings = process.env.OPENCODE_ALIYUN_ENV_FILE ? Object.fromEntries((await readFile(process.env.OPENCODE_ALIYUN_ENV_FILE, "utf8")).trim().split("\n").map((line) => {
  const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]
})) : process.env
const connection = { apiKey: settings.OPENCODE_ALIYUN_API_KEY, apiUrl: settings.OPENCODE_ALIYUN_API_URL, domain: settings.OPENCODE_ALIYUN_DOMAIN, requestTimeoutMs: 120000 }
const sandbox = await Sandbox.create("code-interpreter-v1", { ...connection, timeoutMs: 300000, secure: true, network: { allowPublicTraffic: false } })
const port = 18991
const evidence: Record<string, unknown> = { sandboxId: sandbox.sandboxId }
const post = async (label: string) => {
  try {
    const response = await fetch(`https://${sandbox.getHost(port)}/`, { method: "POST", headers: { "content-type": "application/json", "e2b-traffic-access-token": sandbox.trafficAccessToken ?? "" }, body: JSON.stringify({ jsonrpc: "2.0", id: label, method: "ping" }), signal: AbortSignal.timeout(8000) })
    return { label, status: response.status, body: (await response.text()).slice(0, 80) }
  } catch (error) { return { label, status: String(error).slice(0, 60), body: "" } }
}
try {
  await sandbox.files.write("/tmp/mini.mjs", `import http from 'node:http';http.createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{s.writeHead(200,{'content-type':'text/event-stream'});s.end('event: message\\ndata: '+JSON.stringify({jsonrpc:'2.0',id:JSON.parse(b||'{}').id??1,result:{ok:true}})+'\\n\\n')})}).listen(${port},'0.0.0.0',()=>console.log('mini-up'))`)
  await sandbox.commands.run(`nohup node /tmp/mini.mjs >/tmp/mini.log 2>&1 </dev/null & sleep 1`, { timeoutMs: 10000 })
  evidence.baseline = await post("baseline")
  // Replicate the SaaS pattern: a WebSocket through the gateway opens, and MCP
  // POSTs fire in the same instant (Runner tool callbacks race the handshake).
  const results = await new Promise<Array<Record<string, unknown>>>((resolve) => {
    const outcomes: Array<Record<string, unknown>> = []
    const socket = new WebSocket(`wss://${sandbox.getHost(port)}/`)
    const timer = setTimeout(() => resolve(outcomes), 8000)
    socket.onopen = () => {
      void post("onopen-0").then((value) => {
        outcomes.push(value)
        void post("onopen-60").then((value2) => { outcomes.push(value2); clearTimeout(timer); socket.close(); resolve(outcomes) })
      })
    }
    socket.onerror = () => outcomes.push({ label: "ws-error" })
  })
  evidence.concurrentWithWsOpen = results
  await new Promise((resolve) => setTimeout(resolve, 1000))
  evidence.afterClose = await post("after-close")
} finally {
  evidence.killed = await sandbox.kill()
  await writeFile(process.env.OPENCODE_ALIYUN_EVIDENCE ?? "../../artifacts/aliyun-sandbox/ws-spike.json", JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
}
