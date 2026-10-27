import { readFile, writeFile } from "node:fs/promises"
import { Sandbox } from "e2b"

if (process.env.OPENCODE_ALIYUN_SPIKE !== "1") throw new Error("Explicit billable-resource opt-in required")
const settings = process.env.OPENCODE_ALIYUN_ENV_FILE ? Object.fromEntries((await readFile(process.env.OPENCODE_ALIYUN_ENV_FILE, "utf8")).trim().split("\n").map((line) => {
  const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]
})) : process.env
const connection = { apiKey: settings.OPENCODE_ALIYUN_API_KEY, apiUrl: settings.OPENCODE_ALIYUN_API_URL, domain: settings.OPENCODE_ALIYUN_DOMAIN, requestTimeoutMs: 120000 }
const sandbox = await Sandbox.create("code-interpreter-v1", { ...connection, timeoutMs: 300000, secure: true, network: { allowPublicTraffic: false } })
const port = 18990
const evidence: Record<string, unknown> = { sandboxId: sandbox.sandboxId }
try {
  await sandbox.files.write("/tmp/mini.mjs", `import http from 'node:http';http.createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{s.writeHead(200,{'content-type':'text/event-stream'});s.end('event: message\\ndata: '+JSON.stringify({jsonrpc:'2.0',id:JSON.parse(b||'{}').id??1,result:{ok:true}})+'\\n\\n')})}).listen(${port},'0.0.0.0')`)
  await sandbox.commands.run(`nohup node /tmp/mini.mjs >/tmp/mini.log 2>&1 </dev/null & sleep 1`, { timeoutMs: 10000 })
  const getHostValue = sandbox.getHost(port)
  const manual = `${port}-${sandbox.sandboxId}.${settings.OPENCODE_ALIYUN_DOMAIN}`
  evidence.getHost = getHostValue
  evidence.manual = manual
  evidence.identical = getHostValue === manual
  const probe = async (label: string, host: string) => {
    const attempts: Array<{ status: number | string; body: string }> = []
    for (let index = 0; index < 3; index++) {
      try {
        const response = await fetch(`https://${host}/`, { method: "POST", headers: { "content-type": "application/json", "e2b-traffic-access-token": sandbox.trafficAccessToken ?? "" }, body: JSON.stringify({ jsonrpc: "2.0", id: index, method: "ping" }), signal: AbortSignal.timeout(8000) })
        attempts.push({ status: response.status, body: (await response.text()).slice(0, 120) })
      } catch (error) { attempts.push({ status: String(error).slice(0, 80), body: "" }) }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    evidence[label] = attempts
  }
  await probe("viaGetHost", getHostValue)
  await probe("viaManual", manual)
  await probe("viaGetHostAgain", sandbox.getHost(port))
} finally {
  evidence.killed = await sandbox.kill()
  await writeFile(process.env.OPENCODE_ALIYUN_EVIDENCE ?? "../../artifacts/aliyun-sandbox/host-spike.json", JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
}
