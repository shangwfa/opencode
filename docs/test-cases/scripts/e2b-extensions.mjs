// E2B 扩展能力验收：自定义工具 Tool Host、skills、commands、agents、plugins、MCP。
// 经 sandbox-vercel-t19.mjs 包装（公共 SSE + 自动应答表单 + PG/远端清理）。
// 结论只认 tool part、SSE、PG 与确定性 shell 证据，不认模型自述。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"

const base = process.env.BASE
const second = process.env.BASE_SECONDARY
assert.ok(base && second, "需要两个 Pod 的 BASE 与 BASE_SECONDARY")
assert.ok(process.env.PG_URL?.endsWith("-test"), "必须使用专用测试 PG")
const headers = {
  "content-type": "application/json",
  authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`,
}
const model = JSON.parse(process.env.MODEL ?? '{"providerID":"deepseek","id":"deepseek-flash"}')
const out = process.env.STRESS_OUT
await mkdir(out, { recursive: true })
const report = { passed: false, checks: [], codeMode: "真实模型轮次驱动；自定义工具/嵌套调用以 tool part 与 SSE 为准", turns: 0 }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pg = (query) => execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", query], { encoding: "utf8" }).trim()
const quote = (value) => `'${value.replaceAll("'", "''")}'`
const check = (name, detail = {}) => {
  report.checks.push({ name, passed: true, ...detail })
  console.log(`✓ ${name}`)
}
const api = async (path, method = "GET", body, target = base) => {
  const response = await fetch(target + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(240000) })
  const text = response.status === 204 ? "" : await response.text()
  let data
  try { data = text ? JSON.parse(text) : undefined } catch { data = text }
  return { response, text, data }
}
const unwrap = (result) => {
  assert.ok(result.response.ok, `HTTP ${result.response.status}: ${String(result.text).slice(0, 400)}`)
  return result.data?.data ?? result.data
}
const messages = async (id) => unwrap(await api(`/api/session/${id}/message?order=asc&limit=200`))
const toolParts = (rows) => rows.flatMap((message) => message.type === "assistant" ? (message.content ?? []).filter((part) => part.type === "tool") : [])
const nestedCalls = (events) => events
  .filter((event) => event.type === "session.tool.progress")
  .flatMap((event) => event.data?.metadata?.toolCalls ?? [])
const runPrompt = async (id, text, options = {}) => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = new Set(toolParts(await messages(id)).map((part) => part.id))
    const response = await fetch(`${options.target ?? base}/api/session/${id}/prompt_stream`, {
      method: "POST", headers,
      body: JSON.stringify({ text, model, ...(options.skills ? { skills: options.skills } : {}) }),
      signal: AbortSignal.timeout(600000),
    })
    const stream = await response.text()
    if (response.status !== 200) {
      assert.ok(attempt === 2, `prompt HTTP ${response.status}: ${stream.slice(0, 300)}`)
      continue
    }
    report.turns++
    const events = stream.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
    await writeFile(`${out}/turn-${report.turns}.json`, JSON.stringify(events, null, 2))
    const failed = events.find((event) => event.type === "session.execution.failed")
    assert.equal(failed, undefined, `execution failed: ${JSON.stringify(failed?.data ?? null).slice(0, 300)}`)
    assert.ok(events.some((event) => event.type === "session.execution.succeeded"), "缺少 execution.succeeded")
    return {
      events,
      calls: toolParts(await messages(id)).filter((part) => !before.has(part.id)),
      text: events.filter((event) => event.type === "session.text.ended").map((event) => event.data?.text ?? "").join("\n"),
    }
  }
  throw new Error("prompt retry exhausted")
}
const assertTool = (result, name, count = 1) => {
  const calls = result.calls.filter((part) => part.name === name && part.state?.status === "completed")
  assert.equal(calls.length, count, `${name} completed 数量 ${calls.length} != ${count}: ${JSON.stringify(result.calls.map((p) => [p.name, p.state?.status]))}`)
  return calls
}
const toolText = (part) => {
  const output = part.state?.output
  if (typeof output === "string") return output
  return Array.isArray(part.state?.content) ? part.state.content.filter((item) => item.type === "text").map((item) => item.text).join("") : ""
}
// hook 是否真实触发以 user 消息被改写为准；模型自行读插件源码后模仿标记不能算恢复。
const lastUserText = async (id) => {
  const rows = await messages(id)
  return rows.filter((message) => message.type === "user").at(-1)?.text ?? ""
}
const assertRewritten = async (id, marker) => {
  const text = await lastUserText(id)
  assert.match(text, new RegExp(`^Reply with exactly ${marker} and nothing else\\.$`), `user 消息未被 hook 改写: ${text.slice(0, 120)}`)
}
const runShell = async (id, command) => {
  const started = Date.now()
  const sent = await api(`/api/session/${id}/shell`, "POST", { command })
  assert.ok([200, 204].includes(sent.response.status), `shell HTTP ${sent.response.status}`)
  for (;;) {
    const recent = (await messages(id)).findLast((message) => message.type === "shell" && (message.time?.created ?? 0) * (message.time?.created > 1e12 ? 1 : 1000) >= started - 2000)
    if (recent?.time?.completed != null) return recent
    assert.ok(Date.now() - started < 120000, `shell timeout: ${command.slice(0, 60)}`)
    await sleep(500)
  }
}
const skillSource = (id, description, body) => ({ id, content: `---\ndescription: ${description}\n---\n${body}\n` })

let id
try {
  id = unwrap(await api("/api/session", "POST", { title: "e2b-extensions", model, location: { directory: "/workspace" } })).id
  await writeFile(`${out}/session.json`, JSON.stringify({ id }))
  await api(`/api/experimental/session/${id}/keep-alive`, "POST", { enabled: true, boot: true })

  // 1. 自定义工具 Tool Host：执行于会话沙箱，upsert 版本切换，kill 后恢复。
  if (process.env.SKIP_DONE !== "1") {
  const probeSource = (version) => `import fs from 'node:fs/promises';import {Effect} from 'effect';
let count=0;export default {description:'E2B sandbox probe',args:{},async execute(args,context){
count++;await fs.writeFile('/workspace/session-tool-probe.txt','${version}:'+count);
await Effect.runPromise(context.progress({phase:'e2b-tool-verified'}));
return {title:'E2B probe',output:JSON.stringify({version:'${version}',count,cwd:process.cwd(),directory:context.directory,sessionID:context.sessionID,file:await fs.readFile('/workspace/session-tool-probe.txt','utf8')})};}}`
  unwrap(await api(`/api/session/${id}/tools`, "POST", { name: "sandbox_probe", description: "E2B probe", code: probeSource("v1") }))
  const first = await runPrompt(id, "必须实际调用一次且仅一次 sandbox_probe 工具，参数 {}。不要调用其他工具。收到结果后原样报告 JSON。")
  const v1 = JSON.parse(toolText(assertTool(first, "sandbox_probe")[0]))
  assert.equal(v1.cwd, "/workspace")
  assert.equal(v1.directory, "/workspace")
  assert.equal(v1.sessionID, id)
  assert.equal(v1.file, "v1:1")
  assert.ok(JSON.stringify(first.events).includes("e2b-tool-verified"), "缺少 progress 事件")
  check("自定义工具在 E2B 会话沙箱执行且 progress 可见", { version: v1.version })
  unwrap(await api(`/api/session/${id}/tools`, "POST", { name: "sandbox_probe", description: "E2B probe V2", code: probeSource("v2") }))
  const v2 = JSON.parse(toolText(assertTool(await runPrompt(id, "必须实际调用一次且仅一次 sandbox_probe 工具，参数 {}。原样报告 JSON。"), "sandbox_probe")[0]))
  assert.deepEqual([v2.version, v2.count], ["v2", 1])
  const oldGeneration = pg(`SELECT id FROM sandbox WHERE session_id=${quote(id)}`)
  unwrap(await api(`/api/session/${id}/kill-sandbox`, "POST", {}))
  const recovered = JSON.parse(toolText(assertTool(await runPrompt(id, "必须实际调用一次且仅一次 sandbox_probe 工具，参数 {}。原样报告 JSON。"), "sandbox_probe")[0]))
  assert.deepEqual([recovered.version, recovered.count], ["v2", 1])
  const newGeneration = pg(`SELECT id FROM sandbox WHERE session_id=${quote(id)}`)
  assert.notEqual(newGeneration, oldGeneration)
  check("kill-sandbox 后新代次自动恢复工具与版本", { oldGeneration, newGeneration })
  assert.equal(pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(id)} AND type='assistant' AND data::text LIKE '%\"status\":\"completed\"%' AND data::text LIKE '%sandbox_probe%'`) > 0, true)
  }

  // 2. Skills：Session 注册、attachment 激活、沙箱发现、脚本资源执行。
  if (process.env.SKIP_DONE !== "1") {
  unwrap(await api(`/api/session/${id}/skills`, "POST", skillSource("reviewer", "Reviewer", "# Reviewer\n只回复 REVIEWER_OK")))
  assert.ok(unwrap(await api(`/api/session/${id}/skills`)).some((item) => item.skill.id === "reviewer" && item.source === "session"))
  const attached = await runPrompt(id, "使用 reviewer skill 回复。", { skills: [{ id: "reviewer" }] })
  assert.match(attached.text, /REVIEWER_OK/)
  const missing = await fetch(`${base}/api/session/${id}/prompt_stream`, { method: "POST", headers,
    body: JSON.stringify({ text: "x", model, skills: [{ id: "no-such-skill" }] }), signal: AbortSignal.timeout(60000) })
  assert.equal(missing.status, 400, "缺失 skill attachment 应 400")
  check("Session skill 注册与显式 attachment 激活", {})
  const skillMd = "---\ndescription: E2B sandbox skill\n---\n# E2B Demo\n按 scripts/run.sh 执行\n"
  const script = "#!/bin/sh\necho E2B-SKILL-SCRIPT-OK\n"
  await runShell(id, `mkdir -p /workspace/.opencode/skills/e2b-demo/scripts && printf %s '${Buffer.from(skillMd).toString("base64")}' | base64 -d > /workspace/.opencode/skills/e2b-demo/SKILL.md && printf %s '${Buffer.from(script).toString("base64")}' | base64 -d > /workspace/.opencode/skills/e2b-demo/scripts/run.sh && chmod +x /workspace/.opencode/skills/e2b-demo/scripts/run.sh`)
  const refreshed = unwrap(await api(`/api/session/${id}/skills/refresh`, "POST"))
  const demo = refreshed.find((item) => item.skill.id === "e2b-demo")
  assert.ok(demo && demo.source === "sandbox" && demo.sourcePath === "e2b-demo/SKILL.md", JSON.stringify(demo))
  const run = await runShell(id, "/workspace/.opencode/skills/e2b-demo/scripts/run.sh")
  assert.match(run.output.output, /E2B-SKILL-SCRIPT-OK/)
  assert.equal(unwrap(await api(`/api/session/${id}/skills/reviewer`, "DELETE")), undefined)
  assert.ok(!unwrap(await api(`/api/session/${id}/skills`)).some((item) => item.skill.id === "reviewer"))
  check("沙箱 skill 发现、脚本资源执行与删除", { sourcePath: demo.sourcePath })
  }

  // 3. Commands：重复名优先级稳定，执行展开沙箱模板。
  const name = "e2b-cmd"
  const tmpl = (tag) => `---\ndescription: ${tag}\n---\nE2B_COMMAND_${tag}_${Date.now().toString(36)}\n`
  const singular = tmpl("SINGULAR"), plural = tmpl("PLURAL")
  await runShell(id, `mkdir -p /workspace/.opencode/command /workspace/.opencode/commands && printf %s '${Buffer.from(singular).toString("base64")}' | base64 -d > /workspace/.opencode/command/${name}.md && printf %s '${Buffer.from(plural).toString("base64")}' | base64 -d > /workspace/.opencode/commands/${name}.md`)
  // shell API 会产生 steer 型合成通知；先用一轮廉价 prompt 落地通知，使 queue 投递符合契约前提（独占唤醒）。
  await runPrompt(id, "只回复 ok，不执行任何工具。")
  unwrap(await api(`/api/session/${id}/commands`, "POST", { name, template: `SESSION_TEMPLATE_${Date.now().toString(36)}` }))
  const collapse = async () => unwrap(await api(`/api/session/${id}/commands/refresh`, "POST")).filter((item) => item.name === name)
  const firstList = await collapse()
  assert.equal(firstList.length, 1, "重复名未折叠")
  assert.equal(firstList[0].source, "sandbox", "沙箱定义未胜出")
  assert.deepEqual((await collapse()).map((item) => item.sourcePath), [firstList[0].sourcePath], "优先级不稳定")
  unwrap(await api(`/api/session/${id}/command`, "POST", { name, text: "", delivery: "queue" }))
  const commandWinner = firstList[0].template.trim()
  let texts = []
  for (let wait = 0; wait < 40 && !texts.includes(commandWinner); wait++) {
    await sleep(500)
    texts = (await messages(id)).filter((message) => message.type === "user").map((message) => message.text ?? "")
  }
  assert.ok(texts.includes(commandWinner), "命令未展开获胜模板")
  check("command 重复名折叠、沙箱优先且执行获胜模板", { sourcePath: firstList[0].sourcePath })

  // 4. Agents：沙箱发现 + 子会话共享根沙箱 + PG 零写入。
  await runShell(id, `mkdir -p /workspace/.opencode/agents/e2b-a && printf %s '${Buffer.from("---\ndescription: Shared\nmode: subagent\n---\nSYSTEM_SHARED_E2B\n").toString("base64")}' | base64 -d > /workspace/.opencode/agents/e2b-a/shared.md`)
  const agents = unwrap(await api(`/api/session/${id}/agents/refresh`, "POST"))
  assert.ok(agents.some((item) => item.agent.id === "e2b-a/shared" && item.source === "sandbox"), JSON.stringify(agents.map((item) => item.agent.id)))
  await runPrompt(id, '调用一次 subagent 工具，agent 为 "general"，description 为 "e2b share check"，background 为 false，prompt 为 "Reply with the single word DONE and use no tools."。之后立即停止。')
  const sessions = unwrap(await api("/api/session"))
  const child = sessions.find((item) => item.parentID === id)
  assert.ok(child, "未创建子会话")
  const childAgents = unwrap(await api(`/api/session/${child.id}/agents/refresh`, "POST"))
  assert.ok(childAgents.some((item) => item.agent.id === "e2b-a/shared" && item.source === "sandbox"), "子会话未读取根沙箱 agent")
  assert.equal(pg(`SELECT count(*) FROM session_agents WHERE session_id=${quote(child.id)}`), "0", "扫描写入了子会话 PG 行")
  check("agent 沙箱发现与子会话共享根沙箱", { child: child.id })

  // 5. Plugins：hook 变换、故障隔离、agent 重启恢复、跨 Pod 更新与并发 upsert。
  const hookMarker = `E2B_PLUGIN_${Date.now().toString(36)}`
  const hookCode = (marker) => `export default async () => ({ "session.prompt": (event) => { event.prompt.text = "Reply with exactly ${marker} and nothing else." } })`
  const created = unwrap(await api(`/api/session/${id}/plugins`, "POST", { name: "e2e-hook", description: "E2B hook", source: { type: "code", code: hookCode(hookMarker) } }))
  assert.deepEqual(created.source, { type: "code" }, "create 未脱敏插件源码")
  const listed = unwrap(await api(`/api/session/${id}/plugins`))
  assert.ok(!JSON.stringify(listed).includes("export default"), "list 泄露插件源码")
  const hooked = await runPrompt(id, "Follow the installed session plugin hook.")
  assert.match(hooked.text.trim(), new RegExp(`^${hookMarker}$`), `hook 未改写 prompt: ${hooked.text.slice(0, 120)}`)
  check("plugin hook 改写 prompt 且源码脱敏", { hookMarker })
  unwrap(await api(`/api/session/${id}/plugins`, "POST", { name: "ordinary-hook-throws", description: "x", source: { type: "code", code: 'export default async () => ({ "session.prompt": () => { throw new Error("E2B_THROW_PROBE") } })' } }))
  assert.match((await runPrompt(id, "The plugin hook will fail. Continue normally and reply exactly FAIL_OPEN_CONTINUES.")).text, /FAIL_OPEN_CONTINUES/)
  unwrap(await api(`/api/session/${id}/plugins`, "POST", { name: "timeout-hook", description: "x", source: { type: "code", code: 'export default async () => ({ "session.prompt": async () => new Promise(() => {}) } })' } }))
  assert.match((await runPrompt(id, "The plugin hook will time out. Continue normally and reply exactly TIMEOUT_FAIL_OPEN.")).text, /TIMEOUT_FAIL_OPEN/)
  check("plugin 抛错与超时均 fail-open", {})
  // 契约序列：故障 hook 会让所有 prompt 改写 fail-open，恢复测试前必须移除。
  for (const broken of ["ordinary-hook-throws", "timeout-hook"])
    unwrap(await api(`/api/session/${id}/plugins/${broken}`, "DELETE", undefined, second))
  unwrap(await api(`/api/session/${id}/plugins`, "POST", { name: "npm-valid", description: "x", source: { type: "npm", spec: "debug@4.4.1" } }))
  unwrap(await api(`/api/session/${id}/plugins`, "POST", { name: "npm-invalid", description: "x", source: { type: "npm", spec: "../invalid-plugin" } }))
  unwrap(await api(`/api/session/${id}/plugins`, "POST", { name: "syntax-invalid", description: "x", source: { type: "code", code: "export default {{{" } }))
  unwrap(await api(`/api/session/${id}/plugins`, "POST", { name: "factory-throws", description: "x", source: { type: "code", code: 'export default async () => { throw new Error("FACTORY_THROW") }' } }))
  await runPrompt(id, "Reply exactly PLUGINS_INSTALLED.")
  const health = JSON.parse((await runShell(id, `node -e 'fetch("http://127.0.0.1:9200/health").then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))'`)).output.output.trim())
  for (const broken of ["npm-invalid", "syntax-invalid", "factory-throws"]) assert.ok(health.errors.some((item) => item.name === broken), `${broken} 未隔离上报: ${JSON.stringify(health)}`)
  assert.ok(!health.errors.some((item) => item.name === "npm-valid"), `合法 npm 插件失败: ${JSON.stringify(health.errors)}`)
  assert.ok(health.hooks.includes("session.prompt"))
  check("沙箱内 npm/code 插件故障隔离", { errors: health.errors.map((item) => item.name) })
  await runShell(id, `kill "$(cat /tmp/plugin-agent.pid)" 2>/dev/null; sleep 1; echo killed`)
  const afterKill = await runPrompt(id, "Follow the installed session plugin hook.")
  assert.match(afterKill.text.trim(), new RegExp(`^${hookMarker}$`), "agent 重启后 hook 未恢复")
  await assertRewritten(id, hookMarker)
  check("plugin agent 被杀后下一轮自动恢复", {})
  const updatedMarker = `${hookMarker}_V2`
  unwrap(await api(`/api/session/${id}/plugins`, "POST", { name: "e2e-hook", description: "updated", source: { type: "code", code: hookCode(updatedMarker) } }, second))
  assert.match((await runPrompt(id, "Use the updated session plugin version.")).text.trim(), new RegExp(`^${updatedMarker}$`), "跨 Pod 更新未生效")
  await assertRewritten(id, updatedMarker)
  const winners = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    api(`/api/session/${id}/plugins`, "POST", { name: "e2e-hook", description: `c${index}`, source: { type: "code", code: hookCode(`CONCURRENT_${index}_E2B`) } }, index % 2 ? second : base)))
  assert.ok(winners.every((result) => result.response.status === 200), "并发 upsert 失败")
  const persisted = pg(`SELECT source::jsonb->>'code' FROM session_plugins WHERE session_id=${quote(id)} AND name='e2e-hook'`)
  const winner = persisted.match(/CONCURRENT_\d+_E2B/)?.[0]
  assert.ok(winner, `PG 无并发胜者: ${persisted.slice(0, 120)}`)
  assert.match((await runPrompt(id, "Follow the latest concurrently stored plugin.")).text.trim(), new RegExp(`^${winner}$`), "运行时未消费 PG 胜者")
  await assertRewritten(id, winner)
  check("跨 Pod 并发 upsert 后运行时消费 PG 胜者", { winner })
  for (const plugin of ["e2e-hook", "npm-valid", "npm-invalid", "syntax-invalid", "factory-throws"])
    unwrap(await api(`/api/session/${id}/plugins/${plugin}`, "DELETE", undefined, second))
  assert.equal(pg(`SELECT count(*) FROM session_plugins WHERE session_id=${quote(id)}`), "0")
  assert.match((await runPrompt(id, "With no session plugin installed, reply exactly CLEAN_PLUGIN_OK.")).text, /CLEAN_PLUGIN_OK/)
  const empty = JSON.parse((await runShell(id, `node -e 'fetch("http://127.0.0.1:9200/health").then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))'`)).output.output.trim())
  assert.equal(empty.plugins, 0)
  assert.deepEqual(empty.hooks, [])
  check("插件删除后 PG/Agent 清零且会话可用", {})

  // 6. MCP：本地 stdio server 注册、真实调用、删除。
  const fixture = await readFile(new URL("./session-mcp-shared-fixture.mjs", import.meta.url), "utf8")
  await runShell(id, `printf %s '${Buffer.from(fixture).toString("base64")}' | base64 -d > /workspace/shared-mcp.mjs`)
  unwrap(await api(`/api/session/${id}/mcps`, "POST", { name: "shared", config: { type: "local", command: ["node", "/workspace/shared-mcp.mjs"] } }))
  const mcpRun = await runPrompt(id, "实际调用 shared.echo，message='e2b-mcp-extensions'，仅报告真实结果")
  const echo = nestedCalls(mcpRun.events).find((call) => call.tool === "shared.echo" && call.status === "completed")
  assert.ok(echo && echo.input?.message === "e2b-mcp-extensions", JSON.stringify(nestedCalls(mcpRun.events)))
  unwrap(await api(`/api/session/${id}/mcps/shared`, "DELETE"))
  check("MCP 注册、真实 completed 调用与删除", { echo: echo.input.message })
  report.passed = true
} catch (error) {
  report.error = error.message
  console.error(`✗ ${error.message}`)
  process.exitCode = 1
} finally {
  report.pg = JSON.parse(pg(`SELECT json_build_object('tools',(SELECT count(*) FROM session_tools),'plugins',(SELECT count(*) FROM session_plugins),'commands',(SELECT count(*) FROM session_commands),'agents',(SELECT count(*) FROM session_agents),'mcps',(SELECT count(*) FROM session_mcps),'children',(SELECT count(*) FROM session_v2 WHERE parent_id=${quote(id ?? "")}))::text`))
  await writeFile(`${out}/checks.json`, JSON.stringify(report, null, 2))
}
