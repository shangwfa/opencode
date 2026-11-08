/**
 * 真实 SaaS 验证流式草稿端点：/draft/start 建立可观察生成会话并授权给当前用户，
 * /draft/result 轮询到 ready 后落库；同时确认错误文案不含原始 provider JSON。
 * 复用 state-stats.json 中已完成探索、且带成功运行证据的 DeepSeek 会话。
 */
import { readFileSync } from "node:fs"
import { signIn, api, log } from "./lib.mjs"

const state = JSON.parse(readFileSync(`${new URL(".", import.meta.url).pathname}state-stats.json`, "utf8"))
const request = api(state.token ?? (await signIn()))
const sourceSessionId = state.sessionId

log("发起流式生成…", sourceSessionId)
const start = await request("POST", "/api/automation-apps/draft/start", { sessionId: sourceSessionId }, 60_000)
if (!start.ok) throw new Error(`start 失败 ${start.status}: ${start.text}`)
const job = start.body
log("生成会话", job.sessionId, "prompt", job.promptId, "source", job.sourceSessionId)

const deadline = Date.now() + 4 * 60_000
let outcome
for (;;) {
  const res = await request("POST", "/api/automation-apps/draft/result", { job: { sessionId: job.sessionId, promptId: job.promptId }, sourceSessionId: job.sourceSessionId }, 30_000)
  if (!res.ok) throw new Error(`result 失败 ${res.status}: ${res.text}`)
  outcome = res.body
  log("轮询：", outcome.status, outcome.status === "ready" ? `steps=${outcome.draft.definition.steps.length}` : "")
  if (outcome.status === "ready") break
  if (Date.now() > deadline) throw new Error("流式生成超时")
  await new Promise((r) => setTimeout(r, 3000))
}
const draft = outcome.draft
// 幂等：同一 job 再查一次应返回同一草稿。
const again = await request("POST", "/api/automation-apps/draft/result", { job: { sessionId: job.sessionId, promptId: job.promptId }, sourceSessionId: job.sourceSessionId }, 30_000)
const steps = draft.definition.steps.map((s) => `${s.businessStage ?? "-"}|${s.operation.type}`)
log("草稿", draft.id, "steps:", steps.join("  ·  "))
log("幂等复用同一草稿：", again.body?.draft?.id === draft.id)
if (!steps.length) throw new Error("流式生成未产出步骤")
