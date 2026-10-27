import { readFile, writeFile } from "node:fs/promises"
import { Sandbox } from "e2b"

if (process.env.OPENCODE_ALIYUN_SPIKE !== "1") throw new Error("Explicit billable-resource opt-in required")
const settings = process.env.OPENCODE_ALIYUN_ENV_FILE ? Object.fromEntries((await readFile(process.env.OPENCODE_ALIYUN_ENV_FILE, "utf8")).trim().split("\n").map((line) => {
  const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]
})) : process.env
const connection = { apiKey: settings.OPENCODE_ALIYUN_API_KEY, apiUrl: settings.OPENCODE_ALIYUN_API_URL, domain: settings.OPENCODE_ALIYUN_DOMAIN, requestTimeoutMs: 120000 }
const sandbox = await Sandbox.create("code-interpreter-v1", { ...connection, timeoutMs: 600000, secure: true, network: { allowPublicTraffic: false } })
const port = 18992
const evidence: Record<string, unknown> = { sandboxId: sandbox.sandboxId }
const post = async (label: string) => {
  const started = Date.now()
  try {
    const response = await fetch(`https://${sandbox.getHost(port)}/`, { method: "POST", headers: { "content-type": "application/json", "e2b-traffic-access-token": sandbox.trafficAccessToken ?? "" }, body: JSON.stringify({ jsonrpc: "2.0", id: label, method: "ping" }), signal: AbortSignal.timeout(8000) })
    return { label, status: response.status, ms: Date.now() - started, reused: response.headers.get("x-debug-pool") ?? undefined }
  } catch (error) { return { label, status: String(error).slice(0, 60), ms: Date.now() - started } }
}
try {
  await sandbox.files.write("/tmp/mini.mjs", `import http from 'node:http';http.createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{s.writeHead(200,{'content-type':'text/event-stream'});s.end('event: message\\ndata: '+JSON.stringify({jsonrpc:'2.0',id:JSON.parse(b||'{}').id??1,result:{ok:true}})+'\\n\\n')})}).listen(${port},'0.0.0.0',()=>console.log('mini-up'))`)
  await sandbox.commands.run(`nohup node /tmp/mini.mjs >/tmp/mini.log 2>&1 </dev/null & sleep 1`, { timeoutMs: 10000 })
  // Prime the pool exactly like the SaaS warm turn: connect + list (two requests).
  evidence.prime = [await post("prime-1"), await post("prime-2")]
  const series: Array<Record<string, unknown>> = []
  let elapsed = 0
  for (const idle of [30, 60, 90, 150, 210]) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, idle * 1000 - elapsed)))
    const result = await post(`idle-${idle}s`)
    elapsed += idle * 1000
    series.push({ ...result, waitedMs: idle })
    console.log(`idle=${idle}s → ${result.status} (${result.ms}ms)`)
    if (result.status !== 200) {
      // Immediately probe whether a fresh connection still works while the pool is poisoned.
      const retry = await post(`retry-after-${idle}s`)
      series.push({ ...retry, note: "immediate retry" })
      console.log(`  immediate retry → ${retry.status}`)
      if (retry.status !== 200) break
    }
  }
  evidence.series = series
} finally {
  evidence.killed = await sandbox.kill()
  await writeFile(process.env.OPENCODE_ALIYUN_EVIDENCE ?? "../../artifacts/aliyun-sandbox/keepalive-spike.json", JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
}
