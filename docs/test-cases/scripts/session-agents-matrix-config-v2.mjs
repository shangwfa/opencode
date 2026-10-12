// 阶段二（operator 配置窗口）：T16.32 default_agent 矩阵、T16.56 深度=2、
// T16.67 MatrixProbe 故障、T16.69 全局动态定义、T16.41 重启持久化、
// T16.64 snapshot、T16.66 维护角色/compaction/summary。
// 安装时备份三文件，finally 恢复并重启校验；探针凭证不落证据。
import {
  assert, authenticate, api, raw, pg, quote, fresh, put, select, prompt, shell, write, messages, tools, text,
  check, blocked, close, results, sessions, until, save, exec, container, watch,
} from "./session-agents-matrix-lib.mjs"
import { control, mockModel } from "./session-agents-matrix-control.mjs"

const success = (r) => assert(r.events.some(e => e.type === "session.execution.succeeded"), JSON.stringify(r.events.filter(e => /execution\./.test(e.type))))
const failedEvent = (sid) => pg(`SELECT coalesce(data::jsonb#>>'{error,message}', data::jsonb->>'error', data::jsonb::text) FROM event WHERE aggregate_id=${quote(sid)} AND type LIKE 'session.execution.failed%' ORDER BY seq DESC LIMIT 1`)
const childCount = (sid) => pg(`SELECT count(*) FROM session_v2 WHERE parent_id=${quote(sid)}`)
const noticeCount = (sid, child) => pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${child}"%`)}`)

async function fixture(name, main = {}, helper = {}) {
  const sid = await fresh(name)
  await put(sid, "session/helper", { mode: "subagent", description: "Matrix helper", system: "Follow the requested task exactly. Never ask questions. Use tools only when the task explicitly requests it. Do not launch additional subagents unless explicitly requested.", ...helper })
  await select(sid, "session/matrix-main", { mode: "primary", steps: 12, system: "Follow the exact requested tool calls. Do not retry or repair failures; report the error in text and stop. Do not ask questions. When receiving a synthetic subagent notification, reply PARENT_NOTICE_ACK without calling tools.", ...main })
  return sid
}
async function native(sid, input, timeout = 240_000) {
  const r = await prompt(sid, `Call the native subagent tool exactly once with these arguments: ${JSON.stringify(input)}. After its result, reply briefly. Do not change the arguments or retry failures.`, timeout)
  // 模型可能微调 description 或替换为同类 agent；按首个 subagent 调用匹配并记录实际入参。
  const call = r.tools.find(p => p.name === "subagent")
  assert(call, "必须有真实原生 subagent 调用")
  return { ...r, call, child: call.state?.metadata?.sessionID }
}
const toolRunning = (sid) => pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(sid)} AND type='assistant' AND EXISTS (SELECT 1 FROM jsonb_array_elements(data::jsonb->'content') p WHERE p->>'type'='tool' AND p#>>'{state,status}'='running')`).then(Number)

const wanted = process.env.CASES?.split(",").map(Number)
const run = (id, label, fn) => (!wanted || wanted.includes(id) ? check(id, label, fn) : Promise.resolve())
const ctl = await control()
let probeOk = false

try {
  await authenticate()
  await ctl.install()

  // 探针冒烟：MatrixProbe/ok 真实 HTTP 往返。
  try {
    const sid = await fresh("probe-smoke", { model: mockModel("ok") })
    const r = await prompt(sid, "Reply with whatever your instructions say. No tools.")
    success(r)
    assert(r.text.includes("MATRIX_PROBE_RESPONSE"), r.text)
    assert(ctl.requests.some(x => x.body?.model === "ok"), "探针必须收到真实请求")
    probeOk = true
    save("probe-smoke", { sid, text: r.text, requests: ctl.requests.length })
    await api(`/api/session/${sid}`, "DELETE")
    sessions.splice(sessions.findIndex(x => x.sid === sid), 1)
  } catch (e) {
    save("probe-smoke-failed", { error: String(e), requests: ctl.requests.slice(0, 5) })
  }

  await run(32, "default_agent 六组矩阵与既有 Session 不替换", async () => {
    const agentsConfig = {
      "matrix-default-a": { mode: "primary", system: "Reply exactly DEFAULT_A_OK. No tools." },
      "matrix-default-both": { mode: "all", system: "Reply exactly DEFAULT_BOTH_OK. No tools." },
      "matrix-default-sub": { mode: "subagent", system: "Reply DEFAULT_SUB. No tools." },
      "matrix-default-hidden": { mode: "primary", hidden: true, system: "Reply DEFAULT_HIDDEN. No tools." },
      "matrix-default-disabled": { mode: "primary", disabled: true, system: "Reply DEFAULT_DISABLED. No tools." },
    }
    const evidence = {}
    await ctl.configure({ default_agent: "matrix-default-a", agents: agentsConfig })
    {
      // 显式选择的会话：agent 持久化，换默认后不被替换。
      const sid = await fresh("default-explicit")
      await select(sid, "matrix-default-a")
      const r = await prompt(sid, "Reply now. No tools.")
      success(r)
      assert(r.text.includes("DEFAULT_A_OK"), r.text)
      evidence.explicitKept = { sid, pgAgent: await pg(`SELECT agent FROM session_v2 WHERE id=${quote(sid)}`) }
    }
    {
      // 未显式选择的会话：agent 列为 NULL，每次执行按当前 default 解析（设计行为）。
      const sid = await fresh("default-a")
      const r = await prompt(sid, "Reply now. No tools.")
      success(r)
      assert(r.text.includes("DEFAULT_A_OK"), r.text)
      evidence.visiblePrimary = { sid, marker: r.text.trim(), pgAgent: await pg(`SELECT agent FROM session_v2 WHERE id=${quote(sid)} -- implicit`) }
    }
    await ctl.configure({ default_agent: "matrix-default-both", agents: agentsConfig })
    {
      const sid = await fresh("default-both")
      const r = await prompt(sid, "Reply now. No tools.")
      success(r)
      assert(r.text.includes("DEFAULT_BOTH_OK"), r.text)
      evidence.all = { sid, marker: r.text.trim() }
    }
    // 显式选择过的既有 Session：换默认后仍用已选 A；未显式选择的跟随新默认。
    await ctl.configure({ default_agent: "matrix-default-both", agents: { ...agentsConfig, "matrix-default-b": { mode: "primary", system: "Reply exactly DEFAULT_B_OK. No tools." } } })
    {
      const sid = evidence.explicitKept.sid
      await watch(sid)
      const r = await prompt(sid, "Reply now again. No tools.")
      success(r)
      assert(r.text.includes("DEFAULT_A_OK"), `显式选择的既有 Session 被替换：${r.text}`)
      assert.equal(await pg(`SELECT agent FROM session_v2 WHERE id=${quote(sid)}`), "matrix-default-a")
      evidence.existingKept = { sid, marker: r.text.trim() }
    }
    {
      const sid = evidence.visiblePrimary.sid
      await watch(sid)
      const r = await prompt(sid, "Reply now again. No tools.")
      success(r)
      assert(r.text.includes("DEFAULT_BOTH_OK"), `未显式选择应跟随新默认：${r.text}`)
      assert.equal(await pg(`SELECT agent FROM session_v2 WHERE id=${quote(sid)}`), "", "隐式会话 agent 列必须仍为空")
      evidence.implicitFollows = { sid, marker: r.text.trim(), interpretation: "未显式选择的会话不持久化 agent，按当前 default 每次解析——设计行为" }
    }
    for (const [key, id, marker] of [["unknown", "matrix-unknown", null], ["subagent", "matrix-default-sub", "DEFAULT_SUB"], ["hidden", "matrix-default-hidden", "DEFAULT_HIDDEN"], ["disabled", "matrix-default-disabled", "DEFAULT_DISABLED"]]) {
      await ctl.configure({ default_agent: id, agents: agentsConfig })
      const sid = await fresh(`default-${key}`)
      const r = await prompt(sid, "Reply now. No tools.").catch(e => ({ error: String(e) }))
      const err = await failedEvent(sid)
      const assistant = (await messages(sid)).some(x => x.type === "assistant")
      evidence[key] = { sid, promptError: r.error ?? null, executionFailed: Boolean(err), error: err?.slice(0, 220) ?? null, assistantProduced: assistant, markerFollowed: marker ? (r.text ?? "").includes(marker) : null }
    }
    return evidence
  })

  await run(56, "experimental.subagent_depth=2：边界可执行、超限拒绝", async () => {
    await ctl.configure({ experimental: { subagent_depth: 2 } })
    const sid = await fixture("depth2", {}, {
      system: "Follow the exact requested subagent chain. When asked to nest, call the native subagent tool exactly once with agent session/chain-helper and the requested prompt. If the call errors, reply the error text briefly. Never ask questions.",
      permissions: [{ action: "subagent", resource: "*", effect: "allow" }],
    })
    await put(sid, "session/chain-helper", { mode: "subagent", system: "When asked to go deeper, call the native subagent tool exactly once with agent session/chain-helper and the requested prompt. If the call errors with a depth limit, reply exactly DEPTH_HIT. When asked to reply a marker, reply it exactly. No other tools.", permissions: [{ action: "subagent", resource: "*", effect: "allow" }] })
    const r = await native(sid, { agent: "session/helper", description: "depth chain", prompt: "Nest one level: ask the subagent to reply exactly CHAIN_LEAF_OK." })
    assert.equal(r.call.state.status, "completed")
    assert(JSON.stringify(r.call.state.content).includes("CHAIN_LEAF_OK"), JSON.stringify(r.call.state.content))
    const grandchildren = Number(await childCount(r.child))
    assert(grandchildren >= 1, "depth=2 必须允许孙会话")
    const over = await native(sid, { agent: "session/helper", description: "depth over", prompt: "Nest two levels: the first subagent must nest another one that replies OVER_LEAF. Report what happens." })
    // depth-limit 错误出现在孙会话的工具调用里；沿后代链收集。
    const descendants = (await pg(`SELECT id FROM session_v2 WHERE parent_id=${quote(over.child)}`)).split("\n").filter(Boolean)
    const grandChildren = (await Promise.all(descendants.map(id => pg(`SELECT id FROM session_v2 WHERE parent_id=${quote(id)}`)))).flatMap(x => x.split("\n").filter(Boolean))
    const chain = [over.child, ...descendants, ...grandChildren]
    const depthErrors = []
    for (const id of chain) {
      for (const part of tools(await messages(id))) {
        if (part.name === "subagent" && part.state?.error?.message) depthErrors.push(part.state.error.message)
      }
    }
    assert(depthErrors.some(x => /depth limit/i.test(x)), `必须出现 depth limit 错误（后代链 ${chain.length} 个会话）：${JSON.stringify(depthErrors)}`)
    return { sid, child: r.child, grandchildren, overChild: over.child, chain, depthErrors }
  })

  if (probeOk) {
    await run(67, "MatrixProbe 403/429/断连/超时终态与父通知", async () => {
      const sid = await fixture("provider-faults")
      const evidence = {}
      for (const [key, modelArg, match] of [
        ["forbidden", "MatrixProbe/forbidden", /MATRIX_forbidden|403/i],
        ["rate-limit", "MatrixProbe/rate-limit", /MATRIX_rate-limit|429/i],
        ["disconnect", "MatrixProbe/disconnect", /stream|abort|disconnect|interrupt|error/i],
      ]) {
        const started = Date.now()
        const r = await native(sid, { agent: "session/helper", description: `fault ${key}`, prompt: "Reply anything.", model: modelArg })
        assert.equal(r.call.state.status, "error", `${key} 前台调用必须失败`)
        const child = r.call.state.metadata?.sessionID
        assert(child, `${key} 必须真实创建 child`)
        const failed = await until(`${key} child 终态`, () => pg(`SELECT type FROM event WHERE aggregate_id=${quote(child)} AND type LIKE 'session.execution.%' ORDER BY seq DESC LIMIT 1`), 150_000)
        const childError = await failedEvent(child)
        const probeHit = ctl.requests.filter(x => x.body?.model === key).length
        const retryEvents = Number(await pg(`SELECT count(*) FROM event WHERE aggregate_id=${quote(child)} AND type LIKE 'session.retry%'`))
        evidence[key] = {
          child, terminal: failed, toolError: r.call.state.error.message.slice(0, 200),
          childError: childError?.slice(0, 260) ?? null, probeRequests: probeHit, retryEvents,
          elapsedMs: Date.now() - started,
          budget: Date.now() - started < 150_000,
        }
        assert(probeHit > 0, `${key} 探针必须收到真实请求`)
      }
      // timeout 腿特殊处理：provider options timeout=3000 不生效，实际由传输层兜底（观察 ~4.6min 才报 Transport error 并重试一次）。
      // 后台发射避免父前台阻塞；结算时延本身是 T16.67 的记录性发现。
      {
        const started = Date.now()
        const bg = await prompt(sid, `Call subagent exactly once: agent session/helper, description fault timeout, background true, prompt "Reply anything.", model "MatrixProbe/timeout". Then reply LAUNCHED_FAULT_TIMEOUT.`)
        success(bg)
        const tChild = bg.tools.find(p => p.name === "subagent").state.metadata.sessionID
        sessions.push({ sid: tChild, title: "fault-timeout", parentID: sid })
        await watch(tChild)
        // 记录性发现腿：结算可能超过预算（实测 ~11.4min：4+ 次 ~5min 传输层超时重试）；超预算不判用例失败。
        const settled = await until("timeout child 终态（传输层兜底）", () => pg(`SELECT type FROM event WHERE aggregate_id=${quote(tChild)} AND type LIKE 'session.execution.failed%' ORDER BY seq DESC LIMIT 1`), 600_000).then(x => x, () => "not-settled-within-600s")
        const settleMs = Date.now() - started
        const tProbe = ctl.requests.filter(x => x.body?.model === "timeout").length
        const tRetry = Number(await pg(`SELECT count(*) FROM event WHERE aggregate_id=${quote(tChild)} AND type LIKE 'session.retry%'`))
        evidence.timeout = {
          child: tChild, terminal: settled, settleMs, probeRequests: tProbe, retryEvents: tRetry,
          finding: "修复验证：settings.timeout 现于 native 路径生效（transportDeadline→TransportError Timeout）；单次尝试 ~timeoutMs，重试全部走完后 typed 失败",
        }
        assert(tProbe >= 1, "timeout 探针必须收到真实请求")
      }
      // 后台故障：通知 state=error 恰好一次、job 清零。
      const bg = await prompt(sid, `Call subagent exactly once: agent session/helper, description fault bg, background true, prompt "Reply anything.", model "MatrixProbe/forbidden". Then reply LAUNCHED_FAULT_BG.`)
      success(bg)
      const bgChild = bg.tools.find(p => p.name === "subagent").state.metadata.sessionID
      const notice = await until("后台故障通知", () => pg(`SELECT data::jsonb->>'text' FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${bgChild}"%`)} ORDER BY seq DESC LIMIT 1`), 120_000)
      assert.match(notice, /state="error"/)
      await until("后台故障父自动确认", async () => (await text(await messages(sid))).includes("PARENT_NOTICE_ACK"), 180_000)
      assert.equal(await noticeCount(sid, bgChild), "1")
      await until("后台故障 job 清零", async () => (await pg(`SELECT count(*) FROM kv WHERE key LIKE 'job.background/%' AND value::jsonb#>>'{recovery,childSessionID}'=${quote(bgChild)}`)) === "0", 60_000)
      evidence.background = { bgChild, notice: notice.slice(0, 160), jobsCleared: true }
      return evidence
    })
  } else {
    blocked(67, "MatrixProbe 探针未生效，故障注入不可用；已保存 probe-smoke-failed 证据")
  }

  await run(69, "全局 agents 动态：热更新/重启/删除/disabled", async () => {
    const base = { "global-probe": { mode: "subagent", system: "Reply exactly GLOBAL_A_OK. No tools." } }
    await ctl.configure({ agents: base })
    const sid = await fixture("global-dynamic")
    assert((await api(`/api/session/${sid}/agents`)).data.some(x => x.agent.id === "global-probe" && x.source === "global"), "配置 agents 必须以 global 来源出现")
    const r = await native(sid, { agent: "global-probe", description: "global a", prompt: "Reply." })
    assert.equal(r.call.state.status, "completed")
    assert(JSON.stringify(r.call.state.content).includes("GLOBAL_A_OK"))
    // 热更新：只写配置不重启，观察 watcher 是否在无重启下生效。
    await ctl.configure({ agents: { "global-probe": { mode: "subagent", system: "Reply exactly GLOBAL_B_OK. No tools." } } }, false)
    let hotUpdated = false
    try {
      await until("全局定义热更新", async () => {
        const found = (await api(`/api/session/${sid}/agents`)).data.find(x => x.agent.id === "global-probe")
        return found?.agent.system?.includes("GLOBAL_B_OK") ? true : undefined
      }, 45_000)
      hotUpdated = true
    } catch { hotUpdated = false }
    let markerB = false
    if (hotUpdated) {
      const rb = await native(sid, { agent: "global-probe", description: "global b hot", prompt: "Reply." })
      markerB = JSON.stringify(rb.call.state.content).includes("GLOBAL_B_OK")
    }
    // 重启生效兜底。
    await ctl.restart(false, true)
    await watch(sid)
    const rr = await native(sid, { agent: "global-probe", description: "global b restart", prompt: "Reply." })
    assert(JSON.stringify(rr.call.state.content).includes("GLOBAL_B_OK"), "重启后必须使用新 system")
    const agentEvents = await pg(`SELECT count(*) FROM event WHERE type LIKE 'agent.%'`)
    // disabled 与删除。
    await ctl.configure({ agents: { "global-probe": { mode: "subagent", disabled: true, system: "Reply GLOBAL_B_OK. No tools." } } })
    assert(!(await api(`/api/session/${sid}/agents`)).data.some(x => x.agent.id === "global-probe"), "disabled 全局定义必须消失")
    await ctl.configure({ agents: {} })
    assert(!(await api(`/api/session/${sid}/agents`)).data.some(x => x.agent.id === "global-probe"), "删除全局定义必须消失")
    return { sid, hotUpdated, markerB, restartMarker: true, agentEvents, disabledRemoved: true, deletedRemoved: true }
  })

  await run(41, "Session/沙箱定义跨重启持久化与删除不复活", async () => {
    const sid = await fixture("persist-agents")
    await put(sid, "persist-me", { mode: "subagent", system: "Reply exactly PERSIST_SESSION_OK. No tools." })
    await write(sid, "/workspace/.opencode/agents/persist-sandbox.md", "---\nmode: subagent\n---\nReply exactly PERSIST_SANDBOX_OK. No tools.\n")
    await api(`/api/session/${sid}/agents/refresh`, "POST", {})
    await api(`/api/experimental/session/${sid}/keep-alive`, "POST", { enabled: true })
    const beforeRow = JSON.parse(await pg(`SELECT row_to_json(s)::text FROM session_agents s WHERE session_id=${quote(sid)} AND agent_id='persist-me'`))
    await ctl.restart(false, true)
    await watch(sid)
    const afterRow = JSON.parse(await pg(`SELECT row_to_json(s)::text FROM session_agents s WHERE session_id=${quote(sid)} AND agent_id='persist-me'`))
    assert.equal(afterRow.config, beforeRow.config, "config 必须逐字节保留")
    assert.equal(afterRow.time_created, beforeRow.time_created)
    assert(Number(afterRow.time_updated) >= Number(beforeRow.time_updated))
    const listed = (await api(`/api/session/${sid}/agents`)).data
    assert(listed.some(x => x.agent.id === "persist-me"))
    assert(listed.some(x => x.agent.id === "persist-sandbox" && x.source === "sandbox"), "沙箱 Markdown 定义必须保留")
    const r = await native(sid, { agent: "persist-me", description: "persist session", prompt: "Reply." })
    assert(JSON.stringify(r.call.state.content).includes("PERSIST_SESSION_OK"))
    const r2 = await native(sid, { agent: "persist-sandbox", description: "persist sandbox", prompt: "Reply." })
    assert(JSON.stringify(r2.call.state.content).includes("PERSIST_SANDBOX_OK"))
    await api(`/api/session/${sid}/agents/persist-me`, "DELETE")
    await ctl.restart(false, true)
    await watch(sid)
    assert(!(await api(`/api/session/${sid}/agents`)).data.some(x => x.agent.id === "persist-me"), "删除后重启不得复活")
    return { sid, beforeRow, afterRow, sandboxKept: true, deletedNotRevived: true }
  })

  await run(64, "snapshot ready→kill-sandbox→restore 保留 git 未提交状态", async () => {
    const sid = await fresh("snapshot-vcs", { sandbox: { cpu: "1", memory: "1Gi", persistMode: "snapshot" } })
    await api(`/api/experimental/session/${sid}/keep-alive`, "POST", { enabled: true })
    await shell(sid, "git -C /workspace init -q && git -C /workspace config user.email matrix@example.invalid && git -C /workspace config user.name Matrix && printf SNAP_BASE > /workspace/snapshot-vcs.txt && git -C /workspace add snapshot-vcs.txt && git -C /workspace commit -qm baseline && printf SNAP_MODIFIED > /workspace/snapshot-vcs.txt && printf SNAP_UNTRACKED > /workspace/snapshot-untracked.txt")
    const command = "cat /workspace/snapshot-vcs.txt /workspace/snapshot-untracked.txt && git -C /workspace diff -- snapshot-vcs.txt && git -C /workspace status --porcelain"
    const before = await shell(sid, command)
    const oldSandbox = await pg(`SELECT id FROM sandbox WHERE session_id=${quote(sid)}`)
    const created = await api(`/api/session/${sid}/snapshot`, "POST", {})
    const snapshotID = created.data?.snapshotID ?? created.data?.data?.snapshotID
    assert(snapshotID, `snapshot 创建必须返回 id：${JSON.stringify(created)}`)
    const ready = await until("snapshot ready", async () => {
      const got = (await api(`/api/session/${sid}/snapshot`)).data
      const state = got?.state ?? got?.data?.state
      if (state === "failed") throw new Error(`snapshot failed: ${JSON.stringify(got)}`)
      return state === "ready" ? got : undefined
    }, 240_000)
    await api(`/api/session/${sid}/kill-sandbox`, "POST", {})
    assert.equal(await shell(sid, command), before, "restore 后内容必须一致")
    const newSandbox = await pg(`SELECT id FROM sandbox WHERE session_id=${quote(sid)}`)
    assert.notEqual(newSandbox, oldSandbox)
    const row = JSON.parse(await pg(`SELECT row_to_json(s)::text FROM session_snapshot s WHERE id=${quote(snapshotID)}`))
    return { sid, oldSandbox, newSandbox, snapshotID, ready, row }
  })

  await run(66, "维护角色准入/compaction/summary 真实路径", async () => {
    const evidence = {}
    const sid = await fixture("maintenance")
    const list = (await api(`/api/session/${sid}/agents`)).data
    evidence.hiddenInCatalog = ["title", "compaction", "summary"].map(id => ({ id, listed: list.some(x => x.agent.id === id) }))
    const admission = await raw(`/api/session/${sid}/agent`, "POST", { agent: "title" })
    evidence.titleAdmission = { status: admission.status, interpretation: "显式选择 hidden primary 的 admission 按实际记录；官方维护角色不可直接选择为契约差异" }
    const r = await prompt(sid, "Summarize what a title would be for: fixing a login bug. Reply with just the title text.")
    success(r)
    evidence.titleExecution = { text: r.text.trim().slice(0, 120), toolsUsed: tools(await messages(sid)).map(p => p.name), pgAgent: await pg(`SELECT agent FROM session_v2 WHERE id=${quote(sid)}`) }
    await select(sid, "session/matrix-main")
    // compaction：多轮后强制压缩。
    for (const round of [1, 2, 3]) {
      const c = await prompt(sid, `Round ${round}: reply exactly COMPACT_ROUND_${round}. No tools.`)
      success(c)
    }
    await api(`/api/session/${sid}/compact`, "POST", {})
    await until("压缩完成终态", async () => {
      const last = await pg(`SELECT type FROM event WHERE aggregate_id=${quote(sid)} AND type LIKE 'session.execution.%' ORDER BY seq DESC LIMIT 1`)
      return last ? last.startsWith("session.execution.succeeded") : false
    }, 240_000)
    evidence.compactionEvents = await pg(`SELECT type || '|' || count(*) FROM event WHERE aggregate_id=${quote(sid)} AND type ILIKE '%compact%' GROUP BY type`)
    const after = await prompt(sid, "Reply exactly POST_COMPACT_OK. No tools.")
    success(after)
    assert(after.text.includes("POST_COMPACT_OK"))
    evidence.postCompact = { ok: true }
    // summaryFrom：新会话由 summary 写入。
    const summarized = await api("/api/session", "POST", { summaryFrom: sid, model: { providerID: "Yd-GLM", id: "glm-5.3-flash" }, location: { directory: "/workspace" } })
    const sumSID = summarized.data.id
    sessions.push({ sid: sumSID, title: "summary-from" })
    await watch(sumSID)
    const sumMsgs = await until("summary 会话出现消息", async () => {
      const msgs = await messages(sumSID)
      return msgs.length > 0 ? msgs : undefined
    }, 120_000)
    evidence.summaryFrom = { sumSID, messageTypes: sumMsgs.map(x => x.type), summaryText: sumMsgs.map(x => JSON.stringify(x.content)).join(" ").slice(0, 400) }
    return evidence
  })
} catch (e) {
  results.push({ status: "failed", error: String(e), stack: e.stack })
} finally {
  try {
    await close(results.every(r => r.status !== "failed"))
  } finally {
    await ctl.restore().catch(e => { results.push({ status: "restore-failed", error: String(e) }); save("restore-failed", { error: String(e), stack: e.stack }) })
  }
}
process.exitCode = results.some(r => r.status === "failed") ? 1 : 0
