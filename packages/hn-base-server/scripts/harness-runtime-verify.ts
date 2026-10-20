import { readFile, writeFile } from "node:fs/promises"
import assert from "node:assert/strict"
import { saasFetch } from "../src/lib/saas.js"

const output = process.env.HARNESS_VERIFY_OUTPUT!
const { sessions } = JSON.parse(await readFile(`${output}/result.json`, "utf8"))
const sid = sessions[0]
if (!sid) throw new Error("缺少临时测试会话")
const events: any[] = []
const cases: { name: string; passed: boolean; detail?: string }[] = []
const prefix = process.env.HARNESS_VERIFY_COMMAND_ONLY === "1" ? "command-recheck" : "runtime"
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 240000)
const path = `/api/session/${sid}`
const persist = () => writeFile(`${output}/${prefix}-result.json`, JSON.stringify({ sid, cases, eventCount: events.length }, null, 2))
const check = async (name: string, work: () => Promise<void>) => { try { await work(); cases.push({ name, passed: true }); console.log(`通过 ${name}`) } catch (error) { const detail = error instanceof Error ? error.message : String(error); cases.push({ name, passed: false, detail }); console.log(`失败 ${name} ${detail.slice(0, 200)}`) } await persist() }
const request = async (suffix: string, body: unknown) => { const r = await saasFetch(`${path}/${suffix}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal }); if (!r.ok) throw new Error(`${suffix}: HTTP ${r.status} ${(await r.text()).slice(0, 150)}`); return r }
async function* sse(response: Response) {
  assert(response.ok, `SSE HTTP ${response.status}`)
  const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ""
  try { while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let index: number; while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); if (!line.startsWith("data:")) continue; try { yield JSON.parse(line.slice(5)) } catch {} } } } finally { reader.releaseLock() }
}
const formAttempts = new Map<string, number>()
async function answerForm(form: any) {
  if (!form?.id || (formAttempts.get(form.id) ?? 0) >= 2) return
  formAttempts.set(form.id, (formAttempts.get(form.id) ?? 0) + 1)
  const answer: Record<string, unknown> = {}
  for (const field of form.fields ?? []) {
    if (field.type === "external") continue
    if (field.when?.some((condition: any) => { const value = answer[condition.key]; const matches = Array.isArray(value) ? value.includes(condition.value) : value === condition.value; return condition.op === "eq" ? !matches : matches })) continue
    answer[field.key] = field.default ?? (field.type === "boolean" ? true : ["number", "integer"].includes(field.type) ? field.minimum ?? 1 : field.type === "multiselect" ? field.options.slice(0, Math.max(1, field.minItems ?? 1)).map((item: any) => item.value) : field.options?.[0]?.value ?? "继续执行验证")
  }
  const response = await saasFetch(`${path}/form/${form.id}/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer }) })
  console.log(`表单自动回答 HTTP ${response.status}`)
}
let watch: Promise<void> | undefined
try {
  const response = await saasFetch(`${path}/event`, { signal: controller.signal })
  assert.equal(response.status, 200)
  watch = (async () => { for await (const event of sse(response)) {
    events.push(event)
    if (event.type === "form.created") await answerForm(event.data?.form)
    if (/session\.(execution\.|tool\.(input.started|success|failed)|text.ended|reasoning.ended)/.test(event.type)) console.log(`事件 ${event.type} ${String(event.data?.name ?? event.data?.text ?? "").replace(/\s+/g, " ").slice(0, 140)}`)
  } })().catch((error) => { if (!controller.signal.aborted) console.log(`事件订阅错误 ${String(error).slice(0, 150)}`) })
  if (process.env.HARNESS_VERIFY_COMMAND_ONLY !== "1") await check("MCP 本地服务定义注册（不代表连接成功）", async () => {
    const server = String.raw`const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{try{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'harness-probe',version:'1.0.0'}};if(r.method==='tools/list')result={tools:[{name:'harness_echo',description:'Harness验收，返回固定标识',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};if(r.method==='tools/call')result={content:[{type:'text',text:'HARNESS_MCP_OK'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n')}catch{}})`
    new Function("require", server)
    await request("mcps", { name: "harness_probe", config: { type: "local", command: ["node", "-e", server], codemode: true } })
    const r = await saasFetch(`${path}/mcps`); const data = await r.json(); await writeFile(`${output}/runtime-mcps.json`, JSON.stringify(data, null, 2))
    assert(JSON.stringify(data).includes("harness_probe"))
  })
  await request("model", { model: { providerID: "Yd-GLM", id: "glm-5.3" } })
  if (process.env.HARNESS_VERIFY_COMMAND_ONLY !== "1") await check("Agent + Skills 资源 + MCP + Code Mode 实际执行", async () => {
    const response = await request("prompt_stream", { text: "这是隔离 Harness 功能验收。请实际加载 harness_verification_skill，读取该技能的 references/check.md，并运行技能 scripts/check.py（只运行此测试脚本，不修改仓库）。通过 Code Mode 调用 harness_probe 的 harness_echo 工具。不要仅声称完成，必须调用工具并依据输出回复。最终包含资源标识、脚本标识、MCP 标识，并遵循当前 Agent 的结尾约束。无需提问。", model: { providerID: "Yd-GLM", id: "glm-5.3" } })
    const round: any[] = []
    for await (const event of sse(response)) round.push(event)
    await writeFile(`${output}/runtime-prompt.json`, JSON.stringify(round, null, 2))
    const text = round.filter((event) => event.type === "session.text.ended").map((event) => event.data?.text ?? "").join("\n")
    for (const marker of ["HARNESS_AGENT_OK", "HARNESS_RESOURCE_OK", "HARNESS_SCRIPT_OK", "HARNESS_MCP_OK"]) assert(text.includes(marker), `回复缺少 ${marker}`)
    assert(round.some((event) => event.type === "session.execution.succeeded"), "无执行成功事件")
    const names = round.filter((event) => event.type === "session.tool.input.started").map((event) => event.data?.name)
    assert(names.some((name) => /execute|code.?mode/i.test(String(name))), `未观察到 Code Mode 工具：${names.join(",")}`)
  })
  await check("Commands 实际执行且保持 Agent 约束", async () => {
    const offset = events.length
    await request("command", { name: "harness_check", text: "" })
    const started = Date.now()
    while (Date.now() - started < 90000) {
      const round = events.slice(offset)
      if (round.some((event) => /session.execution.(succeeded|failed|interrupted)/.test(event.type))) {
        await writeFile(`${output}/runtime-command.json`, JSON.stringify(round, null, 2))
        const text = round.filter((event) => event.type === "session.text.ended").map((event) => event.data?.text ?? "").join("\n")
        assert(text.includes("HARNESS_COMMAND_OK"), "命令未返回预期标识")
        assert(text.includes("HARNESS_AGENT_OK"), "命令未沿用 Agent 约束")
        return
      }
      if (controller.signal.aborted) throw new Error("总执行超时")
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error("命令执行超时")
  })
} catch (error) { cases.push({ name: "运行环境", passed: false, detail: error instanceof Error ? error.message : String(error) }) }
finally { controller.abort(); clearTimeout(timeout); await watch; await writeFile(`${output}/${prefix}-events.json`, JSON.stringify(events, null, 2)); await persist(); console.log(`运行验收完成 ${cases.filter((item) => item.passed).length} 通过 ${cases.filter((item) => !item.passed).length} 失败`); if (cases.some((item) => !item.passed)) process.exitCode = 1 }
