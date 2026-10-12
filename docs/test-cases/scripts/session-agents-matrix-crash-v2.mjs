// 阶段三（崩溃窗口）：T16.60 SIGKILL 真实宕机恢复、T16.61 通知投递两个
// 确定性崩溃窗口（admission 前 / job 清除前）。使用注入补丁 + /tmp 开并文件，
// finally 恢复原始 completion 并重启校验。只操作本轮会话与指定容器。
import {
  assert, authenticate, api, pg, quote, fresh, put, select, prompt, messages, tools, text,
  check, close, results, sessions, until, save, watch,
} from "./session-agents-matrix-lib.mjs"
import { control } from "./session-agents-matrix-control.mjs"

const success = (r) => assert(r.events.some(e => e.type === "session.execution.succeeded"), JSON.stringify(r.events.filter(e => /execution\./.test(e.type))))
const noticeCount = (sid, child) => pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${child}"%`)}`)
const noticeText = (sid, child) => pg(`SELECT data::jsonb->>'text' FROM session_message WHERE session_id=${quote(sid)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${child}"%`)} ORDER BY seq DESC LIMIT 1`)
const jobCount = (child) => pg(`SELECT count(*) FROM kv WHERE key LIKE 'job.background/%' AND value::jsonb#>>'{recovery,childSessionID}'=${quote(child)}`)
const toolRunning = (sid) => pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(sid)} AND type='assistant' AND EXISTS (SELECT 1 FROM jsonb_array_elements(data::jsonb->'content') p WHERE p->>'type'='tool' AND p#>>'{state,status}'='running')`).then(Number)
const terminal = (sid) => pg(`SELECT type FROM event WHERE aggregate_id=${quote(sid)} AND type LIKE 'session.execution.%' ORDER BY seq DESC LIMIT 1`)

async function fixture(name) {
  const sid = await fresh(name)
  await put(sid, "session/helper", { mode: "subagent", system: "Run the requested native shell command exactly once in the foreground, report its actual output, then follow the reply instruction. Never ask questions. Do not launch additional subagents." })
  await select(sid, "session/matrix-main", { mode: "primary", steps: 12, system: "Follow the exact requested tool calls. Do not retry or repair failures. When receiving a synthetic subagent notification, reply PARENT_NOTICE_ACK without calling tools." })
  return sid
}
async function launchBackground(sid, description, childPrompt) {
  const r = await prompt(sid, `Call the native subagent tool exactly once: agent session/helper, description ${JSON.stringify(description)}, background true, prompt ${JSON.stringify(childPrompt)}. Then reply LAUNCHED.`)
  success(r)
  const call = r.tools.find(p => p.name === "subagent" && p.state?.input?.description === description)
  assert(call?.state?.metadata?.sessionID, "必须真实后台 child")
  const child = call.state.metadata.sessionID
  sessions.push({ sid: child, title: description, parentID: sid })
  await watch(child)
  return child
}

const wanted = process.env.CASES?.split(",").map(Number)
const run = (id, label, fn) => (!wanted || wanted.includes(id) ? check(id, label, fn) : Promise.resolve())
const ctl = await control()

try {
  await authenticate()
  await ctl.install()

  await run(60, "SIGKILL 宕机：child 恢复执行、通知恰好一次、job 清零", async () => {
    const sid = await fixture("sigkill")
    const child = await launchBackground(sid, "sigkill child", "Run native shell exactly: sleep 45; echo SIGKILL_CHILD_DONE. Then reply exactly CHILD_RECOVERED_OK.")
    await until("child 工具 running", () => toolRunning(child).then(n => n > 0))
    await until("job 已落 PG", async () => (await jobCount(child)) === "1")
    const beforeSandbox = await pg(`SELECT id FROM sandbox WHERE session_id=${quote(sid)}`)
    const beforeEvents = Number(await pg(`SELECT count(*) FROM event WHERE aggregate_id=${quote(child)}`))
    await ctl.restart(true, true)
    const childTerminal = await until("宕机后 child 终态", () => terminal(child), 300_000)
    const notice = await until("宕机后父通知", () => noticeText(sid, child), 300_000)
    assert.match(notice, /state="completed"/, notice)
    assert(notice.includes("CHILD_RECOVERED_OK"), `通知必须包含恢复后真实输出：${notice.slice(0, 200)}`)
    await until("父自动确认轮", async () => (await text(await messages(sid))).includes("PARENT_NOTICE_ACK"), 240_000)
    await until("通知稳定为 1", async () => (await noticeCount(sid, child)) === "1")
    await until("job 清零", async () => (await jobCount(child)) === "0", 120_000)
    const afterSandbox = await pg(`SELECT id FROM sandbox WHERE session_id=${quote(sid)}`)
    assert.equal(afterSandbox, beforeSandbox, "SaaS 宕机不得重建远端沙箱")
    const again = await prompt(sid, "No tools. Reply SIGKILL_PARENT_RECOVERED.")
    success(again)
    assert(again.text.includes("SIGKILL_PARENT_RECOVERED"))
    const afterEvents = Number(await pg(`SELECT count(*) FROM event WHERE aggregate_id=${quote(child)}`))
    const childShell = tools(await messages(child)).find(p => p.name === "shell")
    return {
      sid, child, childTerminal, notice: notice.slice(0, 200), beforeEvents, afterEvents,
      shellFinal: childShell?.state?.status ?? "none", shellOutput: JSON.stringify(childShell?.state?.content ?? "").slice(0, 160),
      sandboxUnchanged: true, jobsCleared: true,
      noLifecycleNote: "无注册 lifecycle 的恢复由 server 单测覆盖（process.test.ts），在线容器始终注册",
    }
  })

  await run(61, "崩溃窗口 before/after-admission：通知不重复、job 清零", async () => {
    await ctl.fault()
    await ctl.restart(false, true)
    const evidence = {}
    for (const [key, marker] of [["before-admission", "WIN1_DONE"], ["after-admission", "WIN2_DONE"]]) {
      const sid = await fixture(`crash-${key === "before-admission" ? 1 : 2}`)
      const child = await launchBackground(sid, `crash ${key}`, `Run native shell exactly: sleep 12; echo ${marker}. Then reply exactly ${marker}.`)
      await until("child 工具 running", () => toolRunning(child).then(n => n > 0))
      await ctl.arm(key, sid)
      // 等待崩溃真实发生（hit 文件出现且服务失联）。
      await until(`${key} 崩溃触发`, async () => {
        const hit = await ctl.crashHit()
        return hit?.window === key ? hit : undefined
      }, 120_000)
      await ctl.crashRecover()
      const notice = await until(`${key} 恢复后通知`, () => noticeText(sid, child), 300_000)
      await until(`${key} 父自动确认`, async () => (await text(await messages(sid))).includes("PARENT_NOTICE_ACK"), 240_000)
      const count = await noticeCount(sid, child)
      assert.equal(count, "1", `${key} 窗口恢复后通知必须恰好一次`)
      await until(`${key} job 清零`, async () => (await jobCount(child)) === "0", 120_000)
      evidence[key] = {
        sid, child, notice: notice.slice(0, 200), noticeCount: count,
        deduplicated: count === "1", contains: notice.includes(marker),
      }
      await ctl.clearCrashFiles()
    }
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
