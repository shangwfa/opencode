import { assert, authenticate, api, raw, pg, quote, fresh, agents, put, select, messages, tools, text, prompt, shell, write, check, blocked, close, results, permissionDecision, until, save } from "./session-agents-matrix-lib.mjs"

const success = (r) => assert(r.events.some(e => e.type === "session.execution.succeeded"), JSON.stringify(r.events.filter(e => /execution\./.test(e.type))))
const cfgModel = { providerID: "Yd-GLM", model: "glm-5.3-flash" }
async function fixture(name, main = {}, helper = {}) {
  const sid = await fresh(name)
  await put(sid, "session/helper", { mode: "subagent", description: "Exact matrix helper", system: "Follow the requested task. Never ask questions. Use tools only if explicitly asked. Do not launch additional subagents unless the task explicitly requests it.", ...helper })
  await select(sid, "session/matrix-main", { mode: "primary", steps: 10, system: "Follow the exact requested tool calls. Do not retry or repair failed calls; report the error in text and stop. Do not ask questions. When receiving a synthetic subagent completion notification, reply exactly PARENT_NOTICE_ACK without calling tools.", ...main })
  return sid
}
async function native(sid, input, timeout) {
  const r = await prompt(sid, `Call the native subagent tool exactly once with these arguments: ${JSON.stringify(input)}. After its result, reply briefly. Do not change the arguments or retry failures.`, timeout)
  const call = r.tools.find(p => p.name === "subagent" && p.state?.input?.agent === input.agent)
  assert(call, "必须有真实原生 subagent 调用，不能以文本复述代替")
  return { ...r, call, child: call.state?.metadata?.sessionID }
}
const selectedCases = process.env.CASES?.split(",").map(Number)
const run = (id, label, fn, coverage = "partial") => !selectedCases || selectedCases.includes(id) ? check(id, label, fn, coverage) : Promise.resolve()

try {
  await authenticate()
  await run(33, "主 Agent A→B→A 真实 prompt 与历史保留", async () => {
    const sid = await fresh("selection")
    const marks = []
    for (const id of ["A", "B", "A"]) {
      await select(sid, `session/${id}`, { mode: "primary", system: `Reply exactly MATRIX_${id} and nothing else. Do not use tools.` })
      const r = await prompt(sid, "Reply now.")
      success(r)
      assert.equal(r.text.trim(), `MATRIX_${id}`)
      marks.push(r.text)
    }
    assert((await messages(sid)).filter(m => m.type === "assistant").length >= 3)
    return { sid, marks, selected: await pg(`SELECT agent FROM session_v2 WHERE id=${quote(sid)}`) }
  })
  await run(34, "all 两用与 primary 原生子调度拒绝", async () => {
    const sid = await fixture("mode")
    await put(sid, "session/both", { mode: "all", system: "Reply exactly MODE_ALL_OK. No tools." })
    await select(sid, "session/both")
    const primary = await prompt(sid, "Reply.")
    success(primary)
    assert.equal(primary.text.trim(), "MODE_ALL_OK")
    await select(sid, "session/matrix-main")
    const child = await native(sid, { agent: "session/both", description: "all mode", prompt: "Reply MODE_ALL_OK" })
    assert.equal(child.call.state.status, "completed")
    assert(JSON.stringify(child.call.state.content).includes("MODE_ALL_OK"))
    await put(sid, "session/primary-only", { mode: "primary" })
    const denied = await native(sid, { agent: "session/primary-only", description: "mode denied", prompt: "Reply anything" })
    assert.equal(denied.call.state.status, "error")
    assert.match(denied.call.state.error.message, /cannot run as a subagent/)
    return { sid, child: child.child, denied: denied.call.state.error }
  })
  await run(35, "hidden 已知 ID 可原生调用（不当权限）", async () => {
    const sid = await fixture("hidden", {}, { hidden: true, system: "Reply exactly HIDDEN_CHILD_OK. No tools." })
    const r = await native(sid, { agent: "session/helper", description: "known hidden", prompt: "Reply." })
    assert.equal(r.call.state.status, "completed")
    assert(JSON.stringify(r.call.state.content).includes("HIDDEN_CHILD_OK"))
    return { sid, child: r.child, catalogFiltering: "另需模型目录捕获，不据已知 ID 调用推断目录可见" }
  })
  await run(45, "primary 切 Agent 不改变已选 Session 模型", async () => {
    const sid = await fixture("primary-model", { model: { providerID: "Yd-GLM", model: "glm-5.3" }, system: "Reply exactly MODEL_ROUTE_OK. No tools." })
    const r = await prompt(sid, "Reply.")
    success(r)
    assert.equal(r.messages.find(m => m.type === "assistant")?.model.id, "glm-5.3-flash")
    await api(`/api/session/${sid}/model`, "POST", { model: { providerID: "Yd-GLM", id: "glm-5.3" } })
    const changed = await prompt(sid, "Reply.")
    success(changed)
    assert.equal(changed.messages.find(m => m.type === "assistant")?.model.id, "glm-5.3")
    return { sid, before: "glm-5.3-flash", after: "glm-5.3" }
  })
  await run(46, "原生子模型继承/Agent/工具显式优先级与非法模型", async () => {
    const sid = await fixture("child-model", {}, { system: "Reply exactly CHILD_ROUTE_OK. No tools." })
    const inherit = await native(sid, { agent: "session/helper", description: "inherit", prompt: "Reply." })
    assert.equal(inherit.call.state.status, "completed")
    assert.equal((await messages(inherit.child)).find(m => m.type === "assistant")?.model.id, "glm-5.3-flash")
    await put(sid, "session/helper", { mode: "subagent", model: { providerID: "Yd-GLM", model: "glm-5.3" }, system: "Reply CHILD_ROUTE_OK. No tools." })
    const agent = await native(sid, { agent: "session/helper", description: "agent model", prompt: "Reply." })
    assert.equal(agent.call.state.status, "completed")
    assert.equal((await messages(agent.child)).find(m => m.type === "assistant")?.model.id, "glm-5.3")
    const explicit = await native(sid, { agent: "session/helper", description: "explicit model", prompt: "Reply.", model: "Yd-GLM/glm-5.3-flash" })
    assert.equal(explicit.call.state.status, "completed")
    assert.equal((await messages(explicit.child)).find(m => m.type === "assistant")?.model.id, "glm-5.3-flash")
    const count = await pg(`SELECT count(*) FROM session_v2 WHERE parent_id=${quote(sid)}`)
    const invalid = await native(sid, { agent: "session/helper", description: "invalid model", prompt: "Reply.", model: "Yd-GLM/no-such-model" })
    assert.equal(invalid.call.state.status, "error")
    assert.equal(await pg(`SELECT count(*) FROM session_v2 WHERE parent_id=${quote(sid)}`), count)
    return { sid, inherited: inherit.child, configured: agent.child, explicit: explicit.child, invalid: invalid.call.state.error }
  })
  await run(48, "Agent system 与 Session/项目 AGENTS.md 共存", async () => {
    const sid = await fixture("system", { system: "Follow instructions. No tools. Your response must include AGENT_SYSTEM_MARK." })
    const agentMd = await raw(`/api/session/${sid}/agents-md`, "POST", { content: "Your response must include SESSION_MD_MARK." })
    if (agentMd.status !== 200 && agentMd.status !== 204) throw new Error(`agents-md API payload/route需核对：${agentMd.status}`)
    await write(sid, "/workspace/AGENTS.md", "Your response must include PROJECT_MD_MARK.\n")
    const r = await prompt(sid, "Reply following all instructions.")
    success(r)
    for (const mark of ["AGENT_SYSTEM_MARK", "SESSION_MD_MARK", "PROJECT_MD_MARK"]) assert(r.text.includes(mark), mark)
    return { sid, text: r.text }
  })
  await run(49, "steps=1 最后步无工具、新输入重置", async () => {
    const sid = await fixture("steps", { steps: 1, system: "When asked to run shell, try to use shell if available. If tools are unavailable, reply STEP_TEXT_ONLY. No questions." })
    const first = await prompt(sid, "Run shell echo MUST_NOT_RUN.")
    success(first)
    assert.equal(first.tools.length, 0)
    assert(first.text.trim().length > 0, "预算耗尽仍应返回文本，不强制覆盖内置最后步总结指令")
    const second = await prompt(sid, "Run shell echo MUST_NOT_RUN_AGAIN.")
    success(second)
    assert.equal(second.tools.length, 0)
    await put(sid, "session/matrix-main", { mode: "primary", steps: 2, system: "Call native shell exactly once when requested, then summarize. Never ask questions." })
    const third = await prompt(sid, "Call native shell exactly once: printf STEP_RESET_REAL. Then summarize.")
    success(third)
    const executed = third.tools.find(p => p.name === "shell" && p.state.status === "completed")
    assert(executed && JSON.stringify(executed.state.content).includes("STEP_RESET_REAL"), "新输入的 steps=2 预算必须允许真实工具调用")
    return { sid, first: first.text, second: second.text, resetTool: executed.state }
  })
  await run(50, "父 subagent ask→reject，无 child 副作用且后续恢复", async () => {
    const sid = await fixture("parent-permission", { permissions: [{ action: "subagent", resource: "*", effect: "ask" }] })
    permissionDecision(sid, "reject")
    const r = await native(sid, { agent: "session/helper", description: "denied helper", prompt: "Reply CHILD_MUST_NOT_EXIST" })
    assert.equal(r.call.state.status, "error")
    assert.equal(await pg(`SELECT count(*) FROM session_v2 WHERE parent_id=${quote(sid)}`), "0")
    const recovered = await prompt(sid, "Do not call tools. Reply exactly PERMISSION_RECOVERED.")
    success(recovered)
    assert.equal(recovered.text.trim(), "PERMISSION_RECOVERED")
    return { sid, error: r.call.state.error }
  })
  await run(51, "子 Agent shell deny 不继承父 allow", async () => {
    const sid = await fixture("child-permission", {}, { permissions: [{ action: "shell", resource: "*", effect: "deny" }], system: "Try the requested shell once. If unavailable or rejected, reply CHILD_DENIED. Do not work around it using other tools." })
    const r = await native(sid, { agent: "session/helper", description: "child denies shell", prompt: "Run shell: echo FORBIDDEN > /workspace/forbidden-by-child.txt. If unavailable reply CHILD_DENIED." })
    assert.equal(r.call.state.status, "completed")
    assert(JSON.stringify(r.call.state.content).includes("CHILD_DENIED"))
    const parts = tools(await messages(r.child))
    assert(!parts.some(p => p.name === "shell" && p.state.status === "completed"))
    assert.equal((await shell(sid, "test ! -e /workspace/forbidden-by-child.txt && echo NO_FILE")).trim(), "NO_FILE")
    return { sid, child: r.child, tools: parts }
  })
  await run(52, "shell ask→reject 带反馈，父新轮可执行", async () => {
    const sid = await fixture("tool-reject", { permissions: [{ action: "shell", resource: "*", effect: "ask" }] })
    permissionDecision(sid, "reject")
    const r = await prompt(sid, "Try native shell exactly once: echo BAD > /workspace/rejected-shell.txt. If rejected, report in text; no retries or alternate tools.")
    const call = r.tools.find(p => p.name === "shell")
    assert(call, "真实 shell 请求")
    assert.equal(call.state.status, "error")
    assert.equal((await shell(sid, "test ! -e /workspace/rejected-shell.txt && echo NO_FILE")).trim(), "NO_FILE")
    const again = await prompt(sid, "No tools. Reply REJECT_RECOVERED.")
    success(again)
    assert(again.text.includes("REJECT_RECOVERED"))
    return { sid, error: call.state.error }
  })
  await run(53, "原生前台 Session Agent、完成输出与 PG 关联", async () => {
    const sid = await fixture("foreground", {}, { system: "Reply exactly NATIVE_FG_OK. No tools." })
    const r = await native(sid, { agent: "session/helper", description: "foreground helper", prompt: "Reply." })
    success(r)
    assert.equal(r.call.state.status, "completed")
    assert.equal(r.call.state.metadata.status, "completed")
    assert(JSON.stringify(r.call.state.content).includes("NATIVE_FG_OK"))
    assert.equal(await pg(`SELECT parent_id FROM session_v2 WHERE id=${quote(r.child)}`), sid)
    return { sid, child: r.child, output: r.call.state.content }
  })
  await run(54, "原生后台 running→父自动通知恰好一次", async () => {
    const sid = await fixture("background", {}, { system: "Reply exactly NATIVE_BG_OK. No tools." })
    const r = await native(sid, { agent: "session/helper", description: "background helper", prompt: "Reply.", background: true })
    assert.equal(r.call.state.status, "completed")
    assert.equal(r.call.state.metadata.status, "running")
    const notice = await until("后台父通知", () => pg(`SELECT data::jsonb->>'text' FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${r.child}"%`)} ORDER BY seq DESC LIMIT 1`))
    const childText = text(await messages(r.child)).trim()
    assert(childText.length > 0 && notice.includes(childText), "通知必须包含真实 child 输出，不以模型遵循指定口令判投递")
    await until("后台父自动继续", async () => Number(await pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(sid)} AND type='assistant' AND seq > (SELECT max(seq) FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${r.child}"%`)})`)) > 0)
    await until("后台父确认轮成功终态", async () => (await pg(`SELECT type FROM event WHERE aggregate_id=${quote(sid)} AND type LIKE 'session.execution.%' ORDER BY seq DESC LIMIT 1`)).startsWith("session.execution.succeeded"))
    assert.equal(await pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${r.child}"%`)}`), "1")
    assert.equal(await pg(`SELECT count(*) FROM kv WHERE key LIKE 'job.background/%' AND value::jsonb#>>'{recovery,childSessionID}'=${quote(r.child)}`), "0")
    return { sid, child: r.child, notice, childText, markerFollowed: childText === "NATIVE_BG_OK" }
  })
  await run(55, "同父 child 续跑复用与无关 child 拒绝", async () => {
    const sid = await fixture("continuation", {}, { system: "Follow request and reply its requested marker. No tools." })
    const first = await native(sid, { agent: "session/helper", description: "first", prompt: "Reply CONTINUE_A" })
    assert.equal(first.call.state.status, "completed")
    const second = await native(sid, { agent: "session/helper", description: "second", prompt: "Reply CONTINUE_B", sessionID: first.child })
    assert.equal(second.child, first.child)
    assert(JSON.stringify(second.call.state.content).includes("CONTINUE_B"))
    assert.equal(await pg(`SELECT count(*) FROM session_v2 WHERE parent_id=${quote(sid)}`), "1")
    const other = await fixture("unrelated")
    const unrelated = await native(other, { agent: "session/helper", description: "unrelated", prompt: "Reply", sessionID: first.child })
    assert.equal(unrelated.call.state.status, "error")
    assert.match(unrelated.call.state.error.message, /not a child/)
    return { sid, child: first.child, other, error: unrelated.call.state.error }
  })
  await run(56, "默认深度限制拒绝孙子", async () => {
    const sid = await fixture("depth", {}, { system: "Call native subagent exactly once with agent session/helper, description nested, prompt Reply NESTED. If rejected, reply DEPTH_DENIED. No repair.", permissions: [{ action: "subagent", resource: "*", effect: "allow" }] })
    const r = await native(sid, { agent: "session/helper", description: "nested attempt", prompt: "Try nested subagent once as instructed." })
    assert.equal(r.call.state.status, "completed")
    const nested = tools(await messages(r.child)).find(p => p.name === "subagent")
    assert(nested, "子模型真实尝试嵌套工具")
    assert.equal(nested.state.status, "error")
    assert.match(nested.state.error.message, /depth limit/)
    assert.equal(await pg(`SELECT count(*) FROM session_v2 WHERE parent_id=${quote(r.child)}`), "0")
    return { sid, child: r.child, error: nested.state.error }
  })
  await run(57, "原生主写子读、子写主读与根沙箱隔离", async () => {
    const sid = await fixture("shared", {}, { system: "Execute the requested shell command exactly once, report the actual output, no questions." })
    await write(sid, "/workspace/native-shared.txt", "ROOT_NATIVE_TOKEN\n")
    const r = await native(sid, { agent: "session/helper", description: "shared file", prompt: "Run shell exactly: cat /workspace/native-shared.txt && printf CHILD_NATIVE_TOKEN > /workspace/native-child.txt . Report actual output." })
    assert.equal(r.call.state.status, "completed")
    const part = tools(await messages(r.child)).find(p => p.name === "shell" && p.state.status === "completed")
    assert(part && JSON.stringify(part.state.content).includes("ROOT_NATIVE_TOKEN"))
    assert.equal((await shell(sid, "cat /workspace/native-child.txt")).trim(), "CHILD_NATIVE_TOKEN")
    const binding = JSON.parse(await pg(`SELECT row_to_json(s)::text FROM sandbox s WHERE session_id=${quote(sid)}`))
    assert.equal(await pg(`SELECT count(*) FROM sandbox WHERE session_id=${quote(r.child)}`), "0")
    const other = await fresh("other-root")
    assert.equal((await shell(other, "test ! -e /workspace/native-child.txt && echo ISOLATED")).trim(), "ISOLATED")
    return { sid, child: r.child, sandbox: { id: binding.id, host: binding.host }, other }
  })
  await run(58, "primary/child Code Mode 真实输出与远端执行", async () => {
    const sid = await fixture("code-mode", {}, { system: "Call execute exactly once with code return {marker:'CHILD_CODEMODE_OK'}; then report its output. No other tools." })
    const p = await prompt(sid, "First call execute exactly once with code return {marker:'PRIMARY_CODEMODE_OK'}; then call native subagent session/helper, description code child, prompt Run your execute marker. Report the results.")
    success(p)
    const primary = p.tools.find(x => x.name === "execute" && x.state.status === "completed")
    assert(primary && JSON.stringify(primary.state.content).includes("PRIMARY_CODEMODE_OK"))
    const childID = p.tools.find(x => x.name === "subagent")?.state.metadata?.sessionID
    assert(childID)
    const child = tools(await messages(childID)).find(x => x.name === "execute" && x.state.status === "completed")
    assert(child && JSON.stringify(child.state.content).includes("CHILD_CODEMODE_OK"))
    return { sid, child: childID, primary: primary.state.content, childOutput: child.state.content }
  })
  await run(65, "显式 title 与 child 不自动改名", async () => {
    const sid = await fixture("explicit-title", { system: "Reply TITLE_TEST_OK. No tools." })
    const before = (await api(`/api/session/${sid}`)).data.title
    success(await prompt(sid, "Reply."))
    assert.equal((await api(`/api/session/${sid}`)).data.title, before)
    assert.equal(await pg(`SELECT count(*) FROM event WHERE aggregate_id=${quote(sid)} AND type LIKE 'session.renamed%'`), "0")
    return { sid, before }
  })
  blocked(47, "真实模型请求捕获探针未部署，request 不发送仅按官方限制记录，不能用字段保存代替")
  blocked(66, "compaction/summary 覆盖实际使用与维护角色直接选择支持范围仍待契约确认")
} catch (e) { results.push({ status: "failed", error: String(e), stack: e.stack }) }
finally { await close(results.every(r => r.status !== "failed")) }
process.exitCode = results.some(r => r.status === "failed") ? 1 : 0
