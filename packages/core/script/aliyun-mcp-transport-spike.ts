import { readFile, mkdir, writeFile } from "node:fs/promises"
import { Sandbox } from "e2b"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { McpHttpBridge } from "../src/session/mcp-http-bridge"

if (process.env.OPENCODE_ALIYUN_SPIKE !== "1") throw new Error("Explicit billable-resource opt-in required")
const settings = process.env.OPENCODE_ALIYUN_ENV_FILE ? Object.fromEntries((await readFile(process.env.OPENCODE_ALIYUN_ENV_FILE, "utf8")).trim().split("\n").map((line) => {
  const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]
})) : process.env
const connection = { apiKey: settings.OPENCODE_ALIYUN_API_KEY, apiUrl: settings.OPENCODE_ALIYUN_API_URL, domain: settings.OPENCODE_ALIYUN_DOMAIN, requestTimeoutMs: 120000 }
const sandbox = await Sandbox.create("code-interpreter-v1", { ...connection, timeoutMs: 300000, secure: true, network: { allowPublicTraffic: false } })
const evidence: { cases: Array<Record<string, unknown>>; killed: boolean } = { cases: [], killed: false }
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
try {
  await sandbox.files.write("/tmp/mcp-echo.mjs", `import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'echo',inputSchema:{type:'object',properties:{message:{type:'string'}}}}]}:{content:[{type:'text',text:m.params.arguments.message}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}))}`)
  for (const [offset, idle] of [0, 12_000, 45_000].entries()) {
    const port = 18700 + offset
    const source = McpHttpBridge.script
    await sandbox.files.write(`/tmp/mcp-bridge-${port}.mjs`, source)
    const stdio = process.env.OPENCODE_MCP_SPIKE_EVERYTHING === "1" ? "npx -y @modelcontextprotocol/server-everything" : "node /tmp/mcp-echo.mjs"
    const launch = await sandbox.commands.run(`mkdir -p /workspace/.opencode/output; (nohup node /tmp/mcp-bridge-${port}.mjs --stdio ${quote(stdio)} --port ${port} >/tmp/mcp-${port}.log 2>&1 </dev/null & sleep 1) >/tmp/launch-${port}.log 2>&1`, { background: true, timeoutMs: 0 })
    await launch.wait()
    const requests: Array<{ method: string; status: number; body?: string }> = []
    const transport = new StreamableHTTPClientTransport(new URL(`https://${sandbox.getHost(port)}/mcp?codemode=false`), {
      requestInit: { headers: { "e2b-traffic-access-token": sandbox.trafficAccessToken ?? "" } },
      fetch: async (input, init) => {
        const response = await fetch(input, init)
        requests.push({ method: init?.method ?? "GET", status: response.status, ...(response.status >= 400 ? { body: (await response.clone().text()).slice(0, 400) } : {}) })
        return response
      },
    })
    const client = new Client({ name: "probe", version: "1" }, { capabilities: { roots: {}, sampling: {}, elicitation: { form: {} } } })
    client.setRequestHandler("roots/list", () => ({ roots: [{ uri: "file:///workspace" }] }))
    const result: Record<string, unknown> = { idleBeforeCallMs: idle, requests }
    try {
      await client.connect(transport)
      await client.listTools()
      if (process.env.OPENCODE_MCP_SPIKE_EVERYTHING === "1") await Promise.all([client.listPrompts(), client.listResources(), client.listResourceTemplates()])
      await new Promise((resolve) => setTimeout(resolve, idle))
      result.call = await client.callTool({ name: "echo", arguments: { message: "NATIVE-MCP-OK" }, _meta: { "ai.opencode/sessionID": "ses_native" } }, { onprogress: () => {} })
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
      result.bridgeLog = await sandbox.files.read(`/tmp/mcp-${port}.log`)
    }
    finally { await client.close() }
    evidence.cases.push(result)
  }
} finally {
  evidence.killed = await sandbox.kill()
  const directory = process.env.OPENCODE_ALIYUN_EVIDENCE ?? "../../artifacts/aliyun-sandbox"
  await mkdir(directory, { recursive: true })
  await writeFile(`${directory}/mcp-transport-spike.json`, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
}
