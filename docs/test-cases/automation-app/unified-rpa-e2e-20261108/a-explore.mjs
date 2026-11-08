/**
 * Phase A：创建会话 → 发送任务 → 讨论执行直到 assistant 完成（表单/权限自动代答）。
 * 产物：state.json（token/sessionId/promptId）、sse-discuss.log（SSE 全量事件）、explore-result.json。
 */
import { appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { signIn, api, createSession, waitAssistant, TASK, log, sleep, DIR } from "./lib.mjs"

const statePath = `${DIR}state.json`
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {}
const trace = { forms: [], permissions: [], ...(state.trace ?? {}) }
const token = state.token ?? (await signIn())
const request = api(token)

if (!state.sessionId) {
  state.sessionId = await createSession(request, `统一应用E2E 每日订单汇总 ${Date.now()}`)
  log("session", state.sessionId)
}
if (!state.promptId) {
  const sent = await request("POST", `/api/sessions/${state.sessionId}/message`, { parts: [{ type: "text", text: TASK }] }, 120_000)
  if (!sent.ok) throw new Error(`发送任务失败 ${sent.status}: ${sent.text}`)
  state.promptId = sent.body?.data?.id ?? sent.body?.id
  log("prompt", state.promptId, sent.status)
}
state.trace = trace
state.token = token
writeFileSync(statePath, JSON.stringify(state, null, 2))

log("等待讨论完成…")
const result = await waitAssistant(request, state.sessionId, state.promptId, trace, 20 * 60_000)
state.explore = result
state.trace = trace
writeFileSync(statePath, JSON.stringify(state, null, 2))
log("explore done=", result.done, "errored=", result.errored ?? false, "parts=", result.parts ?? 0)
if (!result.done) process.exit(1)
console.log("---- 最终回复摘要 ----")
console.log(result.text.slice(-1200))
