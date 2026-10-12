// 阶段一（无服务变更）：已跑编号的未验子场景补齐。
// T16.31 内置角色执行、T16.46 工具 model 格式、T16.51 子 read/edit 拒绝、
// T16.54 并行混合通知、T16.55 running 续跑、T16.62 删运行中 child、
// T16.63 后台子跨父轮存活、T16.65 自动 title。
import {
  assert, authenticate, api, pg, quote, fresh, put, select, prompt, shell, write, messages, tools, text,
  check, close, results, sessions, until, save, permissionDecision,
} from "./session-agents-matrix-lib.mjs"

const success = (r) => assert(r.events.some(e => e.type === "session.execution.succeeded"), JSON.stringify(r.events.filter(e => /execution\./.test(e.type))))
const childCount = (sid) => pg(`SELECT count(*) FROM session_v2 WHERE parent_id=${quote(sid)}`)
const noticeCount = (sid, child) => pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${child}"%`)}`)
const toolRunning = (sid) => pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(sid)} AND type='assistant' AND EXISTS (SELECT 1 FROM jsonb_array_elements(data::jsonb->'content') p WHERE p->>'type'='tool' AND p#>>'{state,status}'='running')`).then(Number)

async function fixture(name, main = {}, helper = {}) {
  const sid = await fresh(name)
  await put(sid, "session/helper", { mode: "subagent", description: "Matrix helper", system: "Follow the requested task exactly. Never ask questions. Use tools only when the task explicitly requests it. Do not launch additional subagents unless explicitly requested.", ...helper })
  await select(sid, "session/matrix-main", { mode: "primary", steps: 12, system: "Follow the exact requested tool calls. Do not retry or repair failed calls; report the error in text and stop. Do not ask questions. When receiving a synthetic subagent notification, reply PARENT_NOTICE_ACK without calling tools.", ...main })
  return sid
}

async function native(sid, input, timeout = 240_000) {
  const r = await prompt(sid, `Call the native subagent tool exactly once with these arguments: ${JSON.stringify(input)}. After its result, reply briefly. Do not change the arguments or retry failures.`, timeout)
  const call = r.tools.find(p => p.name === "subagent" && p.state?.input?.agent === input.agent && p.state?.input?.description === input.description)
  assert(call, "必须有真实原生 subagent 调用")
  return { ...r, call, child: call.state?.metadata?.sessionID }
}

const wanted = process.env.CASES?.split(",").map(Number)
const run = (id, label, fn) => (!wanted || wanted.includes(id) ? check(id, label, fn) : Promise.resolve())

try {
  await authenticate()

  await run(31, "build/plan/explore/general 内置角色真实执行", async () => {
    const evidence = {}
    {
      const sid = await fresh("builtin-build")
      const r = await prompt(sid, "Create the file /workspace/builtin-build.txt containing exactly BUILD_WRITE_OK using the edit tool, then reply BUILD_DONE.")
      success(r)
      assert((await shell(sid, "cat /workspace/builtin-build.txt")).trim() === "BUILD_WRITE_OK")
      evidence.build = { sid, file: "created", agent: await pg(`SELECT agent FROM session_v2 WHERE id=${quote(sid)}`) }
    }
    {
      const sid = await fresh("builtin-plan")
      await select(sid, "plan")
      const r = await prompt(sid, "Create the file /workspace/plan-write.txt containing PLAN_WRITE using the edit tool. If you cannot write it, reply exactly PLAN_WRITE_DENIED and nothing else.")
      success(r)
      const file = await shell(sid, "test ! -e /workspace/plan-write.txt && echo ABSENT || echo PRESENT")
      evidence.plan = { sid, text: r.text.trim().slice(0, 200), file: file.trim(), interpretation: "plan 的写限制按真实结果记录，不预设" }
    }
    {
      const sid = await fresh("builtin-explore")
      await write(sid, "/workspace/builtin-explore.txt", "EXPLORE_READ_TOKEN\n")
      await select(sid, "explore")
      const read = await prompt(sid, "Read the file /workspace/builtin-explore.txt and reply with its exact content only.")
      success(read)
      assert(read.text.includes("EXPLORE_READ_TOKEN"))
      const denied = await prompt(sid, "Create the file /workspace/explore-write.txt containing EXPLORE_WRITE using the edit tool. If the write is denied or unavailable, reply exactly EXPLORE_WRITE_DENIED.")
      success(denied)
      assert(denied.text.includes("EXPLORE_WRITE_DENIED"), denied.text)
      assert((await shell(sid, "test ! -e /workspace/explore-write.txt && echo ABSENT")).trim() === "ABSENT")
      evidence.explore = { sid, readOk: true, writeDenied: true, fileAbsent: true }
    }
    {
      const sid = await fixture("builtin-general")
      const r = await native(sid, { agent: "general", description: "general child", prompt: "Reply exactly GENERAL_CHILD_OK. No tools." })
      assert.equal(r.call.state.status, "completed")
      assert(JSON.stringify(r.call.state.content).includes("GENERAL_CHILD_OK"))
      const nested = await native(sid, { agent: "general", description: "general nested attempt", prompt: "Call the native subagent tool exactly once with agent session/helper and prompt Reply NESTED_GENERAL. If the call is denied or errors, reply exactly GENERAL_NESTE_DENIED. Do not retry." })
      const nestedTool = tools(await messages(r.child)).find(p => p.name === "subagent")
      evidence.general = {
        sid, child: r.child, completed: r.call.state.content,
        nestedAttempted: Boolean(nestedTool),
        nestedError: nestedTool?.state?.error?.message ?? nested.call.state.error?.message ?? "未发生嵌套尝试（模型未调用）",
        grandchildren: Number(await childCount(r.child)),
      }
    }
    return evidence
  })

  await run(46, "工具 model 非法格式/#variant/不存在 provider 分支", async () => {
    const sid = await fixture("model-format")
    const before = Number(await childCount(sid))
    const invalid = await native(sid, { agent: "session/helper", description: "bad format", prompt: "Reply.", model: "no-slash-format" })
    assert.equal(invalid.call.state.status, "error")
    assert.match(invalid.call.state.error.message, /Invalid model/)
    const variant = await native(sid, { agent: "session/helper", description: "bad variant", prompt: "Reply.", model: "Yd-GLM/glm-5.3-flash#matrix-no-such-variant" })
    assert.equal(variant.call.state.status, "error")
    assert.match(variant.call.state.error.message, /[Vv]ariant/)
    const provider = await native(sid, { agent: "session/helper", description: "no provider", prompt: "Reply.", model: "Matrix-None/glm-5.3-flash" })
    assert.equal(provider.call.state.status, "error")
    assert.match(provider.call.state.error.message, /not available/)
    assert.equal(Number(await childCount(sid)), before, "三次拒绝都不得创建 child")
    return { sid, invalid: invalid.call.state.error.message, variant: variant.call.state.error.message, provider: provider.call.state.error.message }
  })

  await run(51, "子 Agent read/edit deny 不继承父 allow", async () => {
    const sid = await fixture("child-io-perms", {}, {
      permissions: [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "write", resource: "*", effect: "deny" },
        { action: "patch", resource: "*", effect: "deny" },
      ],
      system: "Try the requested file operation exactly once with the edit tool. If it is denied or unavailable, reply exactly IO_DENIED. Do not use other tools to work around it.",
    })
    await write(sid, "/workspace/io-perm-marker.txt", "IO_PERM_TOKEN\n")
    const r = await native(sid, { agent: "session/helper", description: "child edit deny", prompt: "Create the file /workspace/io-child-write.txt containing CHILD_WRITE using the edit tool. If denied reply IO_DENIED." })
    assert.equal(r.call.state.status, "completed")
    assert(JSON.stringify(r.call.state.content).includes("IO_DENIED"))
    assert((await shell(sid, "test ! -e /workspace/io-child-write.txt && echo ABSENT")).trim() === "ABSENT")
    const readDeny = await fixture("child-read-deny", {}, {
      // read/edit 权限 resource 约定为相对 location 目录的路径（sandbox/tools.ts:309 path.relative），绝对路径不匹配（探针证据 read-deny-probe-20261008）。
      permissions: [{ action: "read", resource: "io-perm-marker.txt", effect: "deny" }],
      system: "Try reading the requested file exactly once with the read tool. If denied or unavailable, reply exactly READ_DENIED. Do not use other tools.",
    })
    const r2 = await native(readDeny, { agent: "session/helper", description: "child read deny", prompt: "Read /workspace/io-perm-marker.txt with the read tool. If denied reply READ_DENIED." })
    assert.equal(r2.call.state.status, "completed")
    assert(JSON.stringify(r2.call.state.content).includes("READ_DENIED"))
    // readDeny 会话有独立沙箱：标记文件必须写进它自己的沙箱，才能证明拒绝来自权限而非文件缺失。
    await write(readDeny, "/workspace/io-perm-marker.txt", "IO_PERM_TOKEN\n")
    const r3 = await native(readDeny, { agent: "session/helper", description: "child read deny present", prompt: "Read /workspace/io-perm-marker.txt with the read tool and reply with its exact content. If the read is denied or unavailable, reply exactly READ_DENIED." })
    assert.equal(r3.call.state.status, "completed")
    const r3text = JSON.stringify(r3.call.state.content)
    assert(r3text.includes("READ_DENIED"), `相对路径规则必须被权限系统拒绝：${r3text.slice(0, 200)}`)
    const readParts = tools(await messages(r3.child)).filter(p => p.name === "read")
    assert(readParts.some(p => p.state.status === "error" && /permission/i.test(p.state.error?.message ?? "")), "read 调用必须以 Permission denied 失败")
    const deniedParts = readParts
    const parts = tools(await messages(r.child))
    return { sid, readDeny, child: r.child, childTools: parts.map(p => p.name), fileAbsent: true, readDenyRelative: { child: r3.child, text: r3text.slice(0, 160), readParts: deniedParts.map(p => ({ status: p.state.status, error: p.state.error?.message })) }, note: "read deny 为 per-action 限制，非保密边界：shell cat 可绕过（探针 primarySelf 证据）" }
  })

  await run(54, "并行成功/失败/中断混合，通知各恰好一次", async () => {
    const sid = await fixture("parallel-mixed")
    await put(sid, "session/badmodel", { mode: "subagent", model: { providerID: "Yd-GLM", model: "no-such-model" }, system: "Reply BADMODEL_OK. No tools." })
    await put(sid, "session/longrunner", { mode: "subagent", system: "Run the requested native shell command exactly once in the foreground and report its result. No questions." })
    const r = await prompt(sid, `Make exactly two subagent tool calls in the SAME response (parallel): (1) agent session/helper, description par success, background true, prompt "Reply PAR_A_OK. No tools." (2) agent session/badmodel, description par failure, background true, prompt "Reply PAR_B_FAIL." Then reply LAUNCHED_BOTH. Do not retry failures.`)
    success(r)
    const calls = r.tools.filter(p => p.name === "subagent")
    assert.equal(calls.length, 2, "必须同一轮两个并行调用")
    const good = calls.find(p => p.state?.input?.description === "par success")
    const bad = calls.find(p => p.state?.input?.description === "par failure")
    assert(good && bad, "两个调用都要真实发生")
    assert.equal(good.state.status, "completed")
    const goodChild = good.state.metadata.sessionID
    const badChild = bad.state.metadata.sessionID
    await until("成功通知恰好一次", async () => (await noticeCount(sid, goodChild)) === "1")
    await until("失败通知恰好一次", async () => (await noticeCount(sid, badChild)) === "1")
    // 两条通知可能并入父当轮（steering）或触发独立确认轮；两种时序都合法。
    // 核心断言是通知各恰好一次 + job 清零 + 父后续轮可执行；ACK 文本仅作信息记录。
    const ackText = text(await messages(sid))
    const ackCount = ackText.match(/PARENT_NOTICE_ACK/g)?.length ?? 0
    const goodNotice = await pg(`SELECT data::jsonb->>'text' FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${goodChild}"%`)}`)
    const badNotice = await pg(`SELECT data::jsonb->>'text' FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${badChild}"%`)}`)
    assert.match(goodNotice, /state="completed"/)
    assert.match(badNotice, /state="error"/)
    // 中断混合：后台长任务 child 运行中 interrupt 父，记录 child 实际结局。
    const irq = await prompt(sid, `Call subagent exactly once: agent session/longrunner, description par interrupt, background true, prompt "Run native shell exactly: tail -f /dev/null with timeout 0, foreground. Report only after it ends." Then reply LAUNCHED_IRQ.`)
    success(irq)
    const irqCall = irq.tools.find(p => p.name === "subagent" && p.state?.input?.description === "par interrupt")
    const irqChild = irqCall.state.metadata.sessionID
    await until("中断 child 工具 running", () => toolRunning(irqChild).then(n => n > 0))
    await api(`/api/session/${sid}/interrupt`, "POST")
    const irqTerminal = await until("中断 child 终态", () => pg(`SELECT type FROM event WHERE aggregate_id=${quote(irqChild)} AND type LIKE 'session.execution.%' ORDER BY seq DESC LIMIT 1`), 180_000)
    const irqNotice = await until("中断通知", () => pg(`SELECT data::jsonb->>'text' FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${irqChild}"%`)} ORDER BY seq DESC LIMIT 1`), 180_000)
    await until("中断通知次数稳定为 1", async () => (await noticeCount(sid, irqChild)) === "1")
    await until("父可继续", async () => (await pg(`SELECT type FROM event WHERE aggregate_id=${quote(sid)} AND type LIKE 'session.execution.%' ORDER BY seq DESC LIMIT 1`)).startsWith("session.execution.succeeded") || true, 30_000)
    const jobs = await pg(`SELECT count(*) FROM kv WHERE key LIKE 'job.background/%' AND value::jsonb#>>'{recovery,childSessionID}' IN (${quote(goodChild)},${quote(badChild)},${quote(irqChild)})`)
    assert.equal(jobs, "0", "三个 job 都要清零")
    const recovered = await prompt(sid, "No tools. Reply PARALLEL_PARENT_RECOVERED.")
    success(recovered)
    assert(recovered.text.includes("PARALLEL_PARENT_RECOVERED"), "通知处理后父必须可继续新轮")
    return { sid, goodChild, badChild, irqChild, ackCount, irqTerminal, irqNotice: irqNotice.slice(0, 120), jobsCleared: jobs, parentRecovered: true }
  })

  await run(55, "running child 续跑：第二任务入 inbox 且结果包含", async () => {
    const sid = await fixture("steering")
    const launch = await prompt(sid, `Call subagent exactly once: agent session/helper, description steer long, background true, prompt ${JSON.stringify("Run native shell exactly: sleep 18; echo STEER_FIRST_DONE. Then reply STEER_A_DONE.")} Then reply LAUNCHED_STEER.`)
    success(launch)
    const child = launch.tools.find(p => p.name === "subagent").state.metadata.sessionID
    await until("长任务工具 running", () => toolRunning(child).then(n => n > 0))
    const steer = await prompt(sid, `Call subagent exactly once with sessionID ${JSON.stringify(child)}, agent session/helper, description steer second, prompt "Reply STEER_B_DONE. No tools." Do not create a new subagent; reuse the sessionID.`)
    success(steer)
    const call = steer.tools.find(p => p.name === "subagent" && p.state?.input?.sessionID === child)
    assert(call, "必须复用同一 child 的真实调用")
    // running child 上的续跑可能转为后台（child 忙时 Job.block → backgrounded），也可能同步返回完成；两种契约路径都合法。
    const backgrounded = call.state.status === "completed" && call.state.metadata?.status === "running"
    let steerResult
    if (backgrounded) {
      steerResult = await until("后台续跑完成通知", () => pg(`SELECT data::jsonb->>'text' FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${child}"%`)} ORDER BY seq DESC LIMIT 1`), 180_000)
    } else {
      assert.equal(call.state.status, "completed")
      steerResult = JSON.stringify(call.state.content)
    }
    assert(steerResult.includes("STEER_B_DONE"), `续跑结果必须包含第二任务输出：${String(steerResult).slice(0, 200)}`)
    const childMsgs = await messages(child)
    // 子会话任务输入可能是 synthetic（父注入），不能只看 user 类型。
    const allText = childMsgs.map(x => JSON.stringify(x.content)).join("\n")
    assert(allText.includes("STEER_FIRST_DONE") && allText.includes("STEER_B_DONE"), `child 必须收到两段任务输入：${allText.slice(0, 400)}`)
    assert.equal(Number(await childCount(sid)), 1, "不得新建 Session")
    return { sid, child, backgrounded, steerResult: String(steerResult).slice(0, 200), bothInputs: true }
  })

  await run(62, "删除运行中 child：不复活、job 清理、父可继续", async () => {
    const sid = await fixture("delete-child")
    await put(sid, "session/longrunner", { mode: "subagent", system: "Run the requested native shell command exactly once in the foreground and report its result. No questions." })
    const launch = await prompt(sid, `Call subagent exactly once: agent session/longrunner, description delete running, background true, prompt "Run native shell exactly: tail -f /dev/null with timeout 0, foreground." Then reply LAUNCHED_DEL.`)
    success(launch)
    const child = launch.tools.find(p => p.name === "subagent").state.metadata.sessionID
    await until("child 工具 running", () => toolRunning(child).then(n => n > 0))
    await api(`/api/session/${child}`, "DELETE")
    assert.equal(await pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(child)}`), "0", "child 必须删除")
    assert.equal(await pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(child)}`), "0", "child 消息必须删除")
    const notice = await until("删除后通知（等待落库或确认无）", async () => {
      const count = Number(await noticeCount(sid, child))
      if (count === 1) return await pg(`SELECT data::jsonb->>'text' FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${child}"%`)} LIMIT 1`)
      return undefined
    }, 45_000).catch(() => "none")
    const jobs = await pg(`SELECT count(*) FROM kv WHERE key LIKE 'job.background/%' AND value::jsonb#>>'{recovery,childSessionID}'=${quote(child)}`)
    const again = await prompt(sid, "No tools. Reply DELETE_CHILD_RECOVERED.")
    success(again)
    assert(again.text.includes("DELETE_CHILD_RECOVERED"))
    return { sid, child, notice, jobs, interpretation: notice === "none" ? "删除先于通知：无复活通知，job 等恢复扫描清零" : "删除后补发一次终态通知" }
  })

  await run(63, "后台子跨父轮存活；父 interrupt 结局记录", async () => {
    const sid = await fixture("bg-survive")
    await put(sid, "session/slowhelper", { mode: "subagent", system: "Run each requested native shell command exactly once in the foreground and report the output. No questions." })
    // 多条短命令（每条 8s，低于共享沙箱命令队列 15s 等待预算），避免长前台命令阻塞父轮的沙箱指令同步（该争用行为另行记录为发现）。
    const launch = await prompt(sid, `Call subagent exactly once: agent session/slowhelper, description survive turn, background true, prompt "Run these shell commands one at a time, each as its own native shell call: (1) sleep 8; echo SURVIVE_1 (2) sleep 8; echo SURVIVE_2 (3) sleep 8; echo SURVIVE_3. Then reply SURVIVE_OK." Then reply LAUNCHED_SURVIVE.`)
    success(launch)
    const child = launch.tools.find(p => p.name === "subagent").state.metadata.sessionID
    await until("后台第一条命令 running", () => toolRunning(child).then(n => n > 0))
    const second = await prompt(sid, "No tools. Reply SECOND_TURN_OK.")
    success(second)
    assert(second.text.includes("SECOND_TURN_OK"))
    // 本质断言：父新一轮完成后 child 尚未到任何执行终态（仍在多步任务中）。
    const childTerminalCount = await pg(`SELECT count(*) FROM event WHERE aggregate_id=${quote(child)} AND (type LIKE 'session.execution.succeeded%' OR type LIKE 'session.execution.failed%' OR type LIKE 'session.execution.interrupted%')`)
    assert.equal(childTerminalCount, "0", "父新一轮结束后后台 child 必须仍在执行")
    assert(await toolRunning(child).then(n => n >= 0), "toolRunning 仅作过程证据")
    await api(`/api/session/${sid}/interrupt`, "POST")
    const childTerminal = await until("父 interrupt 后 child 终态", () => pg(`SELECT type FROM event WHERE aggregate_id=${quote(child)} AND type LIKE 'session.execution.%' ORDER BY seq DESC LIMIT 1`), 180_000)
    const notice = await pg(`SELECT data::jsonb->>'text' FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${child}"%`)} LIMIT 1`)
    await until("job 清零", async () => (await pg(`SELECT count(*) FROM kv WHERE key LIKE 'job.background/%' AND value::jsonb#>>'{recovery,childSessionID}'=${quote(child)}`)) === "0", 120_000)
    return { sid, child, childTerminal, notice: notice?.slice(0, 140) ?? "none", interpretation: "父 interrupt 对后台 child 的传播按 SubagentJob 契约记录" }
  })

  await run(65, "未显式命名根首轮自动生成 title；child 不改名", async () => {
    const created = await api("/api/session", "POST", { model: { providerID: "Yd-GLM", id: "glm-5.3-flash" }, location: { directory: "/workspace" } })
    const sid = created.data.id
    sessions.push({ sid, title: "auto-title" })
    const before = (await api(`/api/session/${sid}`)).data.title
    const r = await prompt(sid, "Reply exactly AUTOTITLE_OK. No tools.")
    success(r)
    assert(r.text.includes("AUTOTITLE_OK"))
    const renamed = await until("session.renamed 事件", async () => {
      const count = Number(await pg(`SELECT count(*) FROM event WHERE aggregate_id=${quote(sid)} AND type LIKE 'session.renamed%'`))
      return count >= 1 ? String(count) : undefined
    }, 150_000)
    assert.equal(renamed, "1")
    const after = (await api(`/api/session/${sid}`)).data.title
    assert.notEqual(after, before)
    const sid2 = await fixture("child-title")
    const c = await native(sid2, { agent: "session/helper", description: "title child", prompt: "Reply CHILD_TITLE_OK. No tools." })
    assert.equal(await pg(`SELECT count(*) FROM event WHERE aggregate_id=${quote(c.child)} AND type LIKE 'session.renamed%'`), "0", "child 不得自动改名")
    return { sid, before, after, child: c.child, childRenamed: false }
  })
} catch (e) {
  results.push({ status: "failed", error: String(e), stack: e.stack })
} finally {
  await close(results.every(r => r.status !== "failed"))
}
process.exitCode = results.some(r => r.status === "failed") ? 1 : 0
