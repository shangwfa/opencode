import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  agents,
  api,
  authenticate,
  check,
  close,
  fresh,
  messages,
  model,
  pg,
  prompt,
  put,
  quote,
  results,
  select,
  shell,
  tools,
  write,
} from "./session-agents-matrix-lib.mjs"

const nonce = Date.now().toString(36)
const agentID = `session/preset-${nonce}`
const selectedCases = process.env.CASES?.split(",").map(Number)
const succeeded = (run) => run.events.some((event) => event.type === "session.execution.succeeded")
const runCase = (id, label, operation) =>
  !selectedCases || selectedCases.includes(id)
    ? check(id, label, operation, "full")
    : Promise.resolve()

try {
  await authenticate()

  await runCase(1, "默认 Code Mode 在当前 Sandbox 会话中实际执行", async () => {
    const sid = await fresh("permission-preset-codemode")
    const result = await prompt(
      sid,
      "必须调用 execute 恰好一次，执行精确代码：return { marker: 'PRESET_CODEMODE_ACTIVE' }。不要调用其他工具。",
    )
    assert(succeeded(result), "Code Mode turn did not succeed")
    const call = result.tools.find((item) => item.name === "execute" && item.state?.status === "completed")
    assert(call, "实际模型轮次未调用 execute；不能证明 Code Mode 生效")
    assert(JSON.stringify(call.state.content).includes("PRESET_CODEMODE_ACTIVE"), "Code Mode output marker missing")
    const env = JSON.parse(
      execFileSync("docker", ["inspect", "--format", "{{json .Config.Env}}", process.env.SAAS_CONTAINER ?? "opencode-saas-permission-presets"], { encoding: "utf8" }),
    )
    const executor = env.find((item) => item.startsWith("OPENCODE_CODEMODE_EXECUTOR="))?.split("=")[1]
    assert.notEqual(executor, "server", "test container explicitly uses server Code Mode executor")
    return { sid, model: result.messages.find((item) => item.type === "assistant")?.model?.id, executor: executor ?? "默认 sandbox" }
  })

  await runCase(2, "Session read-only 允许真实 Sandbox 读取并阻止写入", async () => {
    const sid = await fresh("permission-preset-session-read-only")
    const file = `/workspace/preset-read-${nonce}.txt`
    const value = `READ_ALLOWED_${nonce}`
    await write(sid, file, `${value}\n`)
    const created = await put(sid, agentID, {
      mode: "primary",
      system: "严格按用户要求调用原生 read 或 write 工具。不要使用 execute、shell、其他工具或猜测结果；失败后停止并报告。",
    })
    assert(created, "Session Agent setup failed")
    await select(sid, agentID)

    const preset = await api(`/api/session/${sid}/permissions/preset`, "PUT", { preset: "read-only" })
    assert.equal(preset.preset, "read-only")
    assert.equal((await agents(sid)).find((item) => item.agent.id === agentID)?.agent?.permissions?.at(-1)?.effect, "allow")

    const read = await prompt(sid, `只用 read 工具读取 ${file}，原样返回内容。`)
    assert(succeeded(read), "read prompt did not reach successful execution terminal")
    const readCall = tools(read.messages).find((item) => item.name === "read" && item.state?.status === "completed")
    assert(readCall, "真实 Sandbox read 工具未成功执行")
    assert(read.text.includes(value) || JSON.stringify(readCall.state.output).includes(value), "读取到的 canary 未回到模型结果")

    const forbidden = `/workspace/preset-read-denied-${nonce}.txt`
    const denied = await prompt(sid, `只用 write 工具创建 ${forbidden}，内容必须为 FORBIDDEN_${nonce}。不要使用其他工具。`)
    assert(succeeded(denied), "denied-write prompt did not complete")
    const writeCall = tools(denied.messages).find((item) => item.name === "write" && item.state?.status === "completed")
    assert(!writeCall, "只读预设下 write 工具竟成功")
    assert.equal((await shell(sid, `test ! -e ${quote(forbidden)} && echo ABSENT`)).trim(), "ABSENT", "只读预设产生了实际文件副作用")
    const stored = JSON.parse(await pg(`SELECT permission::jsonb FROM session_v2 WHERE id=${quote(sid)}`))
    assert(stored.some((rule) => rule.action === "*" && rule.effect === "deny"))
    assert(stored.some((rule) => rule.action === "read" && rule.effect === "allow"))

    await api(`/api/session/${sid}`, "PATCH", { permissions: [] })
    const agentPreset = await api(`/api/session/${sid}/agents/${encodeURIComponent(agentID)}/permissions/preset`, "PUT", {
      preset: "read-only",
    })
    assert.equal(agentPreset.preset, "read-only")
    const agentRead = await prompt(sid, `只用 read 工具读取 ${file}，原样返回内容。`)
    assert(succeeded(agentRead), "Agent read-only read prompt did not succeed")
    assert(tools(agentRead.messages).some((item) => item.name === "read" && item.state?.status === "completed"))
    assert(agentRead.text.includes(value), "Agent read-only did not return the allowed canary")
    const agentForbidden = `/workspace/preset-agent-read-denied-${nonce}.txt`
    const agentDenied = await prompt(sid, `只用 write 工具创建 ${agentForbidden}，内容必须为 AGENT_FORBIDDEN_${nonce}。不要用其他工具。`)
    assert(succeeded(agentDenied), "Agent read-only denied-write prompt did not complete")
    assert(!tools(agentDenied.messages).some((item) => item.name === "write" && item.state?.status === "completed"))
    assert.equal((await shell(sid, `test ! -e ${quote(agentForbidden)} && echo ABSENT`)).trim(), "ABSENT")
    const storedAgent = JSON.parse(await pg(`SELECT config::jsonb FROM session_agents WHERE session_id=${quote(sid)} AND agent_id=${quote(agentID)}`))
    assert(storedAgent.permissions.some((rule) => rule.action === "*" && rule.effect === "deny"))
    return {
      sid,
      readTools: read.tools.map((item) => item.name),
      sessionDeniedTools: denied.tools.map((item) => item.name),
      agentReadTools: agentRead.tools.map((item) => item.name),
      agentDeniedTools: agentDenied.tools.map((item) => item.name),
      readCanary: value,
      forbiddenFiles: ["ABSENT", "ABSENT"],
      pgRules: stored.length,
      agentRules: storedAgent.permissions.length,
    }
  })

  await runCase(3, "Agent workspace-write 与 full-access 在真实 Sandbox 执行", async () => {
    const sid = await fresh("permission-preset-agent-write")
    const agent = `session/preset-write-${nonce}`
    await put(sid, agent, {
      mode: "primary",
      system: "严格按用户要求调用原生 write 工具一次。不要用 execute、shell 或其他工具；报告实际结果。",
      description: "PERMISSION_PRESET_FIELD_PRESERVED",
    })
    await select(sid, agent)

    const workspace = await api(`/api/session/${sid}/agents/${encodeURIComponent(agent)}/permissions/preset`, "PUT", {
      preset: "workspace-write",
    })
    assert.equal(workspace.preset, "workspace-write")
    assert.equal(workspace.agent.agent.system.includes("严格按用户要求"), true, "Agent system 被预设覆盖")
    assert.equal(workspace.agent.agent.description, "PERMISSION_PRESET_FIELD_PRESERVED", "Agent description 被预设覆盖")
    const inWorkspace = `/workspace/preset-write-${nonce}.txt`
    const written = await prompt(sid, `只用 write 将 ${inWorkspace} 写入精确内容 WORKSPACE_WRITE_${nonce}。`)
    assert(succeeded(written), "workspace-write execution failed")
    assert(tools(written.messages).some((item) => item.name === "write" && item.state?.status === "completed"), "workspace-write 未真实调用成功 write")
    assert.equal((await shell(sid, `cat ${quote(inWorkspace)}`)).trim(), `WORKSPACE_WRITE_${nonce}`, "Sandbox 内文件内容不符合预期")
    const storedWorkspace = JSON.parse(await pg(`SELECT config::jsonb FROM session_agents WHERE session_id=${quote(sid)} AND agent_id=${quote(agent)}`))
    assert(storedWorkspace.permissions.some((rule) => rule.action === "edit" && rule.effect === "allow"))
    assert.equal(storedWorkspace.description, "PERMISSION_PRESET_FIELD_PRESERVED")

    const full = await api(`/api/session/${sid}/agents/${encodeURIComponent(agent)}/permissions/preset`, "PUT", {
      preset: "full-access",
    })
    assert.equal(full.preset, "full-access")
    assert.equal((await api(`/api/session/${sid}/permission`, "POST", { action: "external_directory", resources: ["/tmp"], agent })).data.effect, "allow")
    const outside = `/tmp/preset-boundary-${nonce}.txt`
    const escaped = await prompt(sid, `只用 write 尝试在 ${outside} 创建内容 OUTSIDE_${nonce}。不要改写到 workspace。`)
    const escapedWrite = tools(escaped.messages).find((item) => item.name === "write")
    assert(escapedWrite, "full-access 下模型没有实际尝试外部路径 write")
    assert.notEqual(escapedWrite.state?.status, "completed", "Sandbox 越界写入竟然成功")
    const failure = JSON.stringify(escapedWrite.state?.error ?? escapedWrite.state?.output ?? escapedWrite.state)
    assert.match(failure, /Path escapes the location|escapes|outside|workspace/i, `不是预期的 Sandbox 路径边界错误：${failure}`)
    assert.equal((await shell(sid, `test ! -e ${quote(outside)} && echo ABSENT`)).trim(), "ABSENT", "Sandbox 越界写入产生了文件")
    const storedFull = JSON.parse(await pg(`SELECT config::jsonb FROM session_agents WHERE session_id=${quote(sid)} AND agent_id=${quote(agent)}`))
    assert.equal(storedFull.permissions.length, 2)
    assert(storedFull.permissions.some((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow"))
    assert(
      storedFull.permissions.some((rule) => rule.action === "external_directory" && rule.resource === "*" && rule.effect === "allow"),
      "full-access must keep external_directory allow explicit",
    )
    return {
      sid,
      workspaceFile: inWorkspace,
      outsideFile: "ABSENT",
      workspaceRules: storedWorkspace.permissions.length,
      fullRules: storedFull.permissions,
    }
  })

  await runCase(4, "同一 Session 多轮开发：prompt_stream 设置预设并在下一轮恢复 Agent 细粒度规则", async () => {
    const sid = await fresh("permission-preset-session-development-workflow")
    const agent = `session/preset-workflow-${nonce}`
    const source = `/workspace/src/workflow-${nonce}.js`
    const deniedTarget = `/workspace/src/readonly-${nonce}.js`
    const defaultFirst = `/workspace/src/agent-default-first-${nonce}.js`
    const followup = `/workspace/src/agent-default-${nonce}.js`
    const initial = `export const status = "TODO_${nonce}";\n`
    const updated = `export const status = "IMPLEMENTED_${nonce}";\n`
    const final = `export const status = "AGENT_DEFAULT_${nonce}";\n`

    await put(sid, agent, {
      mode: "primary",
      system: "你在同一个代码仓库中协助开发。严格按本轮要求使用 read/write 工具，不要使用 execute 或 shell；只报告工具实际返回的结果。",
      permissions: [
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "edit", resource: "src/**", effect: "ask" },
      ],
    })
    await select(sid, agent)
    await write(sid, source, initial)

    // Standard baseline: no prompt preset means the Agent's original fine-grained rules apply.
    assert.equal((await api(`/api/session/${sid}/permission`, "POST", { action: "edit", resources: [source.slice("/workspace/".length)], agent })).data.effect, "ask")
    const defaultRound = await prompt(sid, `只用 read 读取 ${source}，并只用 write 在 ${defaultFirst} 创建内容 AGENT_DEFAULT_FIRST_${nonce}。`)
    assert(succeeded(defaultRound), "未设置 preset 的 Agent 默认权限轮次未完成")
    assert(tools(defaultRound.messages).some((item) => item.name === "read" && item.state?.status === "completed"), "Agent 默认权限下未读取源码")
    assert(tools(defaultRound.messages).some((item) => item.name === "write" && item.state?.status === "completed"), "Agent ask 规则未通过 SSE once 后完成真实 write")
    assert.equal((await shell(sid, `cat ${quote(defaultFirst)}`)).trim(), `AGENT_DEFAULT_FIRST_${nonce}`, "Agent 默认权限下首次写入内容不符")

    const inspected = await prompt(
      sid,
      `先只用 read 读取 ${source} 并报告 status 的当前值；然后只用 write 尝试创建 ${deniedTarget}，内容为 DENIED_${nonce}。不要使用其他工具。`,
      180_000,
      { preset: "read-only" },
    )
    assert(succeeded(inspected), "read-only 检查轮次未完成")
    assert(tools(inspected.messages).some((item) => item.name === "read" && item.state?.status === "completed"), "开发流程未实际读取源文件")
    assert(inspected.text.includes(`TODO_${nonce}`), "读取结果与沙箱源文件不符")
    assert(!tools(inspected.messages).some((item) => item.name === "write" && item.state?.status === "completed"), "read-only 轮次竟成功写入")
    assert.equal((await shell(sid, `test ! -e ${quote(deniedTarget)} && echo ABSENT`)).trim(), "ABSENT", "read-only 轮次产生文件副作用")

    const implemented = await prompt(
      sid,
      `只用 read 和 write 把 ${source} 的 status 从 TODO_${nonce} 改成 IMPLEMENTED_${nonce}，不要碰其他文件。`,
      180_000,
      { preset: "workspace-write" },
    )
    assert(succeeded(implemented), "workspace-write 开发轮次未完成")
    assert(tools(implemented.messages).some((item) => item.name === "write" && item.state?.status === "completed"), "workspace-write 轮次未真实调用并完成 write")
    assert.equal((await shell(sid, `cat ${quote(source)}`)).trim(), updated.trim(), "Sandbox 中的实现结果不符合预期")
    assert.equal((await shell(sid, `node --check ${quote(source)} && echo SYNTAX_OK`)).trim(), "SYNTAX_OK", "实现文件语法检查失败")

    // Omitting preset after preset-scoped turns must restore the Agent's fine-grained rules.
    const fallback = await prompt(sid, `只用 write 在 ${followup} 创建内容 ${final.trim()}。不要使用其他工具。`)
    assert(succeeded(fallback), "Agent 默认规则下的 once 授权轮次未完成")
    assert(tools(fallback.messages).some((item) => item.name === "write" && item.state?.status === "completed"), "Agent ask 规则未通过 SSE 权限询问后完成真实 write")
    assert.equal((await shell(sid, `cat ${quote(followup)}`)).trim(), final.trim(), "Agent 默认规则授权后的文件内容不符")
    const saved = await pg(`SELECT count(*) FROM permission WHERE project_id=(SELECT project_id FROM session_v2 WHERE id=${quote(sid)}) AND action='edit' AND resource=${quote(followup)}`)
    assert.equal(saved, "0", "once 权限回复意外持久化为 saved permission")

    const storedPresets = JSON.parse(await pg(`SELECT COALESCE(json_agg(data::json->>'preset' ORDER BY seq), '[]'::json) FROM session_message WHERE session_id=${quote(sid)} AND type='user'`))
    assert.deepEqual(storedPresets, [null, "read-only", "workspace-write", null], "PG 没有按 prompt 持久化各轮预设/未设置状态")
    const storedAgent = JSON.parse(await pg(`SELECT config::jsonb FROM session_agents WHERE session_id=${quote(sid)} AND agent_id=${quote(agent)}`))
    assert(storedAgent.permissions.some((rule) => rule.action === "edit" && rule.resource === "src/**" && rule.effect === "ask"), "prompt 未设置 preset 时没有回到 Agent 细粒度 ask 规则")
    assert(storedAgent.permissions.some((rule) => rule.action === "edit" && rule.resource === "*" && rule.effect === "deny"), "Agent 细粒度 deny 规则没有保留")
    const sessionPermission = await pg(`SELECT permission IS NULL OR permission::jsonb='[]'::jsonb FROM session_v2 WHERE id=${quote(sid)}`)
    assert.equal(sessionPermission, "t", "本用例意外通过 Session 权限 API 修改了 Session 权限")

    return {
      sid,
      agent,
      rounds: ["preset omitted: Agent read/ask rules + SSE once write", "prompt preset read-only: read + denied write", "prompt preset workspace-write: edit + syntax check", "preset omitted again: Agent ask/deny + SSE once write"],
      deniedFile: "ABSENT",
      implementation: updated.trim(),
      fallbackWrite: final.trim(),
      storedPromptPresets: storedPresets,
      savedPermissionRowsAfterOnce: saved,
    }
  })
} finally {
  await close(true)
}

const failures = results.filter((item) => item.status === "failed")
if (failures.length) {
  console.error(`\n${failures.length} Session/Sandbox permission preset runtime case(s) failed.`)
  process.exitCode = 1
} else {
  console.log("\nAll Session/Sandbox permission preset runtime cases passed.")
}
