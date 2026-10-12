import { assert, authenticate, api, raw, pg, quote, fresh, put, select, prompt, shell, write, check, blocked, close, results, until, exec, container, watch, messages, text } from "./session-agents-matrix-lib.mjs"

async function fixture(title, command) {
  const sid = await fresh(title)
  await api(`/api/experimental/session/${sid}/keep-alive`, "POST", { enabled: true })
  await put(sid, "session/lifecycle-helper", { mode: "subagent", system: "Follow the task exactly. No questions. Run only the requested native shell command. Do not retry interrupted commands unless continuing after a server restart." })
  await select(sid, "session/lifecycle-owner", { mode: "primary", system: "Make the exact subagent call requested. Never poll or retry. Upon a synthetic child completion, reply exactly LIFECYCLE_PARENT_ACK and stop." })
  const r = await prompt(sid, `Call native subagent with agent session/lifecycle-helper, description lifecycle test, background true, prompt ${JSON.stringify(command)}. Then reply LAUNCHED.`)
  const call = r.tools.find(p => p.name === "subagent" && p.state.status === "completed")
  assert(call?.state.metadata?.sessionID, "必须真实后台 subagent")
  const child = call.state.metadata.sessionID
  await watch(child)
  await until("子远端工具 running", () => pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(child)} AND type='assistant' AND EXISTS (SELECT 1 FROM jsonb_array_elements(data::jsonb->'content') p WHERE p->>'type'='tool' AND p->>'name'='shell' AND p#>>'{state,status}'='running')`).then(n => Number(n) > 0))
  return { sid, child }
}
async function notice(sid, child, timeout = 180_000) {
  const n = await until("父通知", () => pg(`SELECT data::jsonb->>'text' FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${child}"%`)} ORDER BY seq DESC LIMIT 1`), timeout)
  await until("父自动恢复确认", async () => text(await messages(sid)).includes("LIFECYCLE_PARENT_ACK"))
  assert.equal(await pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${child}"%`)}`), "1")
  assert.equal(await pg(`SELECT count(*) FROM kv WHERE key LIKE 'job.background/%' AND value::jsonb#>>'{recovery,childSessionID}'=${quote(child)}`), "0")
  return n
}
const wanted = process.env.CASES?.split(",").map(Number)
const run = (id, title, fn) => !wanted || wanted.includes(id) ? check(id, title, fn) : Promise.resolve()
try {
  await authenticate()
  await run(59, "真实 watchdog 中断后台子工具及父通知", async () => {
    const f = await fixture("watchdog", "Run native shell exactly once with command tail -f /dev/null and timeout 0. Do not background the shell. Report its result only after it ends.")
    const event = await until("watchdog 终态（非人工 interrupt）", () => pg(`SELECT data::jsonb FROM event WHERE aggregate_id=${quote(f.child)} AND type LIKE 'session.execution.interrupted%' ORDER BY seq DESC LIMIT 1`), 240_000)
    const data = JSON.parse(event)
    assert.equal(data.reason, "watchdog")
    const n = await notice(f.sid, f.child)
    assert.match(n, /state="cancelled"/)
    return { ...f, event: data, notice: n }
  })
  await run(63, "原生前台父 interrupt 取消子与父后续恢复", async () => {
    const sid = await fresh("foreground-interrupt")
    await put(sid, "session/irq-helper", { mode: "subagent", system: "Run requested shell tail -f /dev/null with timeout 0 exactly once, not in background. Never ask questions." })
    await select(sid, "session/irq-owner", { mode: "primary", system: "Follow the requested call exactly. Never repair failures. After interruption, only follow new user text." })
    const active = prompt(sid, "Call native subagent session/irq-helper in foreground, description interrupt child, prompt Run the shell as instructed. Await it.", 180_000).catch(e => ({ error: String(e) }))
    const child = await until("前台 child 创建", () => pg(`SELECT id FROM session_v2 WHERE parent_id=${quote(sid)} ORDER BY time_created DESC LIMIT 1`))
    await watch(child)
    await until("前台 child 工具 running", () => pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(child)} AND type='assistant' AND EXISTS (SELECT 1 FROM jsonb_array_elements(data::jsonb->'content') p WHERE p->>'type'='tool' AND p#>>'{state,status}'='running')`).then(n => Number(n) > 0))
    await api(`/api/session/${sid}/interrupt`, "POST")
    const parentStream = await active
    const terminal = await until("前台子取消终态", () => pg(`SELECT type FROM event WHERE aggregate_id=${quote(child)} AND type LIKE 'session.execution.interrupted%' ORDER BY seq DESC LIMIT 1`))
    const again = await prompt(sid, "No tools. Reply exactly PARENT_IRQ_RECOVERED.")
    assert(again.text.includes("PARENT_IRQ_RECOVERED"))
    return { sid, child, terminal, parentStreamEvents: parentStream.events?.filter(e => /execution\./.test(e.type)), parentStreamError: parentStream.error }
  })
  await run(64, "PVC 重建保留双向文件与 git 未提交 diff", async () => {
    const sid = await fresh("pvc-vcs", { sandbox: { cpu: "1", memory: "1Gi", persistMode: "pvc" } })
    await api(`/api/experimental/session/${sid}/keep-alive`, "POST", { enabled: true })
    await shell(sid, "git -C /workspace init -q && git -C /workspace config user.email matrix@example.invalid && git -C /workspace config user.name Matrix && printf BASE > /workspace/vcs-marker.txt && git -C /workspace add vcs-marker.txt && git -C /workspace commit -qm baseline && printf MODIFIED > /workspace/vcs-marker.txt && printf UNTRACKED > /workspace/vcs-untracked.txt")
    const before = await shell(sid, "cat /workspace/vcs-marker.txt && git -C /workspace diff -- vcs-marker.txt && git -C /workspace status --porcelain")
    const oldSandbox = await pg(`SELECT id FROM sandbox WHERE session_id=${quote(sid)}`)
    const killed = await api(`/api/session/${sid}/kill-sandbox`, "POST", {})
    const after = await shell(sid, "cat /workspace/vcs-marker.txt && git -C /workspace diff -- vcs-marker.txt && git -C /workspace status --porcelain")
    assert.equal(after, before)
    const newSandbox = await pg(`SELECT id FROM sandbox WHERE session_id=${quote(sid)}`)
    assert.notEqual(newSandbox, oldSandbox)
    return { sid, oldSandbox, newSandbox, killed, before, after, snapshot: "snapshot leg 尚未执行" }
  })
  await run(62, "后台 child running 时删根，无孤儿定义/通知复活", async () => {
    const f = await fixture("delete-running", "Run native shell exactly once command tail -f /dev/null with timeout 0, foreground. No questions.")
    await put(f.sid, "session/delete-probe", { system: "DELETE_TEST" })
    await api(`/api/session/${f.sid}`, "DELETE")
    assert.equal(await pg(`SELECT count(*) FROM session_v2 WHERE id IN (${quote(f.sid)},${quote(f.child)})`), "0")
    assert.equal(await pg(`SELECT count(*) FROM session_agents WHERE session_id=${quote(f.sid)}`), "0")
    const pending = await pg(`SELECT count(*) FROM kv WHERE key LIKE 'job.background/%' AND value::jsonb#>>'{recovery,childSessionID}'=${quote(f.child)}`)
    return { ...f, remainingBackgroundJob: Number(pending), interpretation: Number(pending) ? "孤儿 job 待下一次恢复扫描清理；不能标清理全通过" : "同步清零" }
  })
  await run(64, "snapshot ready→重建保留真实 git diff/未跟踪文件", async () => {
    const sid = await fresh("snapshot-vcs", { sandbox: { cpu: "1", memory: "1Gi", persistMode: "snapshot" } })
    await api(`/api/experimental/session/${sid}/keep-alive`, "POST", { enabled: true })
    await shell(sid, "git -C /workspace init -q && git -C /workspace config user.email matrix@example.invalid && git -C /workspace config user.name Matrix && printf SNAP_BASE > /workspace/snapshot-vcs.txt && git -C /workspace add snapshot-vcs.txt && git -C /workspace commit -qm baseline && printf SNAP_MODIFIED > /workspace/snapshot-vcs.txt && printf SNAP_UNTRACKED > /workspace/snapshot-untracked.txt")
    const command = "cat /workspace/snapshot-vcs.txt /workspace/snapshot-untracked.txt && git -C /workspace diff -- snapshot-vcs.txt && git -C /workspace status --porcelain"
    const before = await shell(sid, command)
    const oldSandbox = await pg(`SELECT id FROM sandbox WHERE session_id=${quote(sid)}`)
    const created = await api(`/api/session/${sid}/snapshot`, "POST")
    const snapshotID = created.data.snapshotID
    assert(snapshotID)
    const snapshot = await until("snapshot ready", async () => {
      const row = (await api(`/api/session/${sid}/snapshot`)).data
      if (row?.state === "failed") throw new Error(`snapshot failed: ${JSON.stringify(row)}`)
      return row?.state === "ready" ? row : undefined
    }, 180_000)
    await api(`/api/session/${sid}/kill-sandbox`, "POST", {})
    assert.equal(await shell(sid, command), before)
    const newSandbox = await pg(`SELECT id FROM sandbox WHERE session_id=${quote(sid)}`)
    assert.notEqual(newSandbox, oldSandbox)
    const restored = JSON.parse(await pg(`SELECT row_to_json(s)::text FROM session_snapshot s WHERE id=${quote(snapshotID)}`))
    assert.equal(restored.state, "stale")
    assert.equal(Number(restored.restored_count), 1)
    return { sid, oldSandbox, newSandbox, snapshotID, ready: snapshot, restored, before }
  })
  blocked(60, "SIGKILL 会中断现有服务的所有会话；需先确认无其他活跃任务再单独执行，不与 runtime 并行")
  blocked(61, "确定性投递崩溃窗口需故障注入入口；现有服务无测试探针，不以随机重启代替")
  blocked(67, "真实 provider 403/429/流断连故障代理未接入；unavailable 已有通知专项，不冒称其余错误已覆盖")
} catch (e) { results.push({ status: "failed", error: String(e), stack: e.stack }) }
finally { await close(results.every(r => r.status !== "failed")) }
process.exitCode = results.some(r => r.status === "failed") ? 1 : 0
