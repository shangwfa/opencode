// Docker SaaS API → Vercel workspace → stdio MCP → SaaS Form/LLM → JSON-RPC response.
// Run through sandbox-vercel-t19.mjs to subscribe public SSE before the first prompt and purge resources.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"

const base = process.env.BASE.replace(/\/$/, "")
const headers = { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}` }
const model = { providerID: "deepseek", id: "deepseek-flash" }
const out = process.env.STRESS_OUT
await mkdir(out, { recursive: true })
const api = async (method, path, body, timeout = 30_000) => {
  const response = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) })
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${(await response.clone().text()).slice(0, 500)}`)
  return response
}
const session = (await (await api("POST", "/session", { title: "mcp-interactions-standard" })).json()).data
await writeFile(`${out}/session.json`, JSON.stringify({ id: session.id }))
const prefix = `/session/${session.id}`
const fixture = `
import { createInterface } from 'node:readline';
let parent, expected;
const send = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize')return send({id:m.id,result:{protocolVersion:'2025-11-25',serverInfo:{name:'standard-probe',version:'1'},capabilities:{tools:{}}}});
 if(m.method==='tools/list')return send({id:m.id,result:{tools:['sampling_probe','form_probe','url_probe'].map(name=>({name,description:'MCP standard '+name,inputSchema:{type:'object',properties:{marker:{type:'string'}},required:['marker']}}))}});
 if(m.method==='tools/call'){
  parent=m; expected=m.params.name;
  const marker=m.params.arguments.marker;
  const sampling=expected==='sampling_probe';
  const url=expected==='url_probe';
  const params=sampling?{messages:[{role:'user',content:{type:'text',text:'Reply exactly SAMPLED-OK'}}],maxTokens:64,temperature:0}
    :url?{mode:'url',message:marker,url:'https://example.com/mcp-consent',elicitationId:'url-'+m.id}
    :{mode:'form',message:marker,requestedSchema:{type:'object',properties:{name:{type:'string'}},required:['name']}};
  return send({id:'reverse-id',method:sampling?'sampling/createMessage':'elicitation/create',params});
 }
 if(m.id==='reverse-id'&&!m.method){
  send({id:parent.id,result:{content:[{type:'text',text:JSON.stringify({probe:expected,response:m.result??m.error})}]}});
 }
});
`
const encoded = Buffer.from(fixture).toString("base64")
await api("POST", `${prefix}/shell`, { command: `printf %s '${encoded}' | base64 -d > /workspace/mcp-standard-probe.mjs` }, 90_000)
await api("POST", `${prefix}/mcps`, { name: "standard", config: { type: "local", command: ["node", "/workspace/mcp-standard-probe.mjs"] } })

let stop = false
let targetAction = "accept"
let autoError
const decisions = []
const answered = new Set()
let delayed = false
const automatic = (async () => {
  while (!stop) {
    try {
      const forms = (await (await api("GET", `${prefix}/form`)).json()).data
      for (const form of forms) {
        if (answered.has(form.id)) continue
        const kind = form.metadata?.kind
        if (!delayed && kind === "mcp-sampling-request" && Number(process.env.MCP_APPROVAL_DELAY_MS) > 0) {
          delayed = true
          console.log(`表单 ⏳ 模拟人工等待 ${process.env.MCP_APPROVAL_DELAY_MS}ms`)
          await new Promise(resolve => setTimeout(resolve, Number(process.env.MCP_APPROVAL_DELAY_MS)))
        }
        const action = kind === "mcp-elicitation" ? targetAction : "accept"
        if (action === "cancel") {
          await api("DELETE", `${prefix}/form/${form.id}`)
        } else {
          const answer = {}
          for (const field of form.fields) {
            if (field.when?.some(condition => condition.value !== action)) continue
            if (field.key.startsWith("_mcp_action") || field.key === "decision") answer[field.key] = action
            else if (field.type === "string") answer[field.key] = field.options?.[0]?.value ?? "ELICITED-OK"
            else if (field.type === "boolean") answer[field.key] = true
            else if (field.type === "number" || field.type === "integer") answer[field.key] = field.default ?? field.minimum ?? 1
            else if (field.type === "multiselect") answer[field.key] = [field.options[0].value]
          }
          await api("POST", `${prefix}/form/${form.id}/reply`, { answer })
        }
        answered.add(form.id)
        decisions.push({ id: form.id, kind, action, owner: form.sessionID })
        console.log(`表单 ✓ ${kind ?? "question"} ${action} ${form.id}`)
      }
    } catch (error) { autoError = error; return }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
})()
const scenarios = []
const findProbe = (value, tool) => {
  if (!value || typeof value !== "object") return undefined
  if (value.probe === tool) return value
  for (const child of Object.values(value)) {
    const found = findProbe(child, tool)
    if (found) return found
  }
}
try {
  for (const [tool, action, expected] of [
    ["sampling_probe", "accept", "SAMPLED-OK"],
    ["form_probe", "accept", "ELICITED-OK"],
    ["form_probe", "decline", "decline"],
    ["form_probe", "cancel", "cancel"],
    ["url_probe", "accept", "accept"],
  ].filter(([tool]) => !process.env.MCP_SCENARIO || tool === process.env.MCP_SCENARIO)) {
    targetAction = action
    console.log(`场景 ▶ ${tool} / ${action}`)
    const response = await api("POST", `${prefix}/prompt_stream`, { model, text: `请实际调用 standard MCP 的 ${tool} 工具，marker 参数为 '${tool}-${action}'。默认 Code Mode 下请通过 execute 搜索并调用它。不要模拟调用，也不要自己写代码替代该 MCP 工具。完成后把 MCP 工具的完整 JSON 结果原样回复。` }, 300_000)
    const text = await response.text()
    const events = text.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
    await writeFile(`${out}/${tool}-${action}.json`, JSON.stringify(events, null, 2))
    if (autoError) throw autoError
    const answer = events.filter(e => e.type === "session.text.ended").map(e => e.data?.text ?? "").join("\n")
    assert.ok(events.some(e => e.type === "session.tool.input.started" && e.data?.name === "execute"), "默认 Code Mode 未生效")
    assert.ok(!events.some(e => e.type === "session.execution.failed"), "模型执行失败")
    assert.ok(!events.some(e => e.type === "session.tool.failed"), "不能把工具失败后的模型重试算成通过")
    let probe
    for (const event of events.filter(e => e.type === "session.tool.success")) {
      for (const part of event.data?.content ?? []) {
        if (part.type !== "text") continue
        try { probe ??= findProbe(JSON.parse(part.text), tool) } catch {}
      }
    }
    assert.ok(probe, "缺少 MCP 工具实际 JSON 响应")
    if (tool === "sampling_probe") {
      assert.equal(probe.response.role, "assistant")
      assert.equal(probe.response.model, model.id)
      assert.equal(probe.response.content.type, "text")
      assert.ok(probe.response.content.text.length > 0)
      assert.ok(answer.includes(probe.response.content.text), "最终回复未包含真实采样内容")
    } else assert.ok(answer.includes(expected), `${tool}/${action}: ${answer.slice(0, 800)}`)
    const nested = events.flatMap(e => e.data?.metadata?.toolCalls ?? []).filter(c => c.tool?.includes(tool))
    assert.ok(nested.length > 0, "缺少真实 MCP 嵌套调用证据")
    scenarios.push({ tool, action, expected, passed: true, nested, response: probe.response })
    await writeFile(`${out}/scenarios.json`, JSON.stringify(scenarios, null, 2))
    console.log(`场景 ✅ ${tool} / ${action}`)
  }
  const query = `SELECT json_build_object('id',id,'sessionID',session_id,'decision',decision,'payload',payload,'result',result)::text FROM hitl_request WHERE session_id='${session.id.replaceAll("'", "''")}' AND kind='form' ORDER BY time_created`
  const rows = execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", query], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(JSON.parse).map(row => ({ ...row, payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload, result: typeof row.result === "string" ? JSON.parse(row.result) : row.result }))
  await writeFile(`${out}/pg.json`, JSON.stringify(rows, null, 2))
  const samplingCount = scenarios.filter(row => row.tool === "sampling_probe").length
  assert.equal(rows.filter(r => r.payload.metadata?.kind === "mcp-sampling-request").length, samplingCount)
  assert.equal(rows.filter(r => r.payload.metadata?.kind === "mcp-sampling-result").length, samplingCount)
  assert.equal(rows.filter(r => r.payload.metadata?.kind === "mcp-elicitation").length, scenarios.length - samplingCount)
  const sampled = scenarios.find(row => row.tool === "sampling_probe")
  if (sampled) assert.equal(rows.find(r => r.payload.metadata?.kind === "mcp-sampling-result")?.payload.metadata.message, sampled.response.content.text)
  assert.ok(rows.every(r => r.sessionID === session.id && r.decision !== "pending"))
  await writeFile(`${out}/mcp-interactions-report.json`, JSON.stringify({ passed: true, scenarios, decisions, pg: rows }, null, 2))
} finally {
  stop = true
  await automatic
}
