/**
 * Phase D：进入已发布应用并触发运行（模拟"进入应用，触发应用执行"）。
 * 断言：正常运行不调用模型（无新增 assistant/user prompt 消息、SSE 无 think/text）、
 * 步骤全部成功、本次独立产物可读。产物：run-result.json、sse-run.log（由外部监视器写入）。
 */
import { writeFileSync, readFileSync } from "node:fs"
import { signIn, api, log, sleep, DIR } from "./lib.mjs"

const state = JSON.parse(readFileSync(`${DIR}state.json`, "utf8"))
const request = api(state.token ?? (await signIn()))
const appDetail = await request("GET", `/api/automation-apps/${state.appId}`, undefined, 30_000)
if (!appDetail.ok) throw new Error(`读取应用失败 ${appDetail.status}: ${appDetail.text}`)
const definition = appDetail.body.app.definition
const parameters = Object.fromEntries(definition.parameters.map((p) => [p.key, p.defaultValue]))

const countModelMessages = (body) => {
  const list = body?.data ?? []
  return {
    prompts: list.filter((m) => m.type === "user").length,
    assistants: list.filter((m) => m.type === "assistant").length,
    other: list.length - list.filter((m) => m.type === "user" || m.type === "assistant").length,
  }
}

const before = countModelMessages((await request("GET", `/api/sessions/${state.sessionId}/messages`, undefined, 15_000)).body)
state.messagesBeforeRun = before
log(`before: user=${before.prompts} assistant=${before.assistants} shell/other=${before.other}`)

const started = await request("POST", `/api/automation-apps/${state.appId}/runs`, {
  sessionId: state.sessionId,
  requestKey: crypto.randomUUID(),
  parameters,
  confirmed: true,
}, 60_000)
if (![200, 201].includes(started.status)) throw new Error(`应用运行启动失败 ${started.status}: ${started.text}`)
state.appRunId = started.body.id
log("app run", state.appRunId, JSON.stringify(parameters))
writeFileSync(`${DIR}state.json`, JSON.stringify(state, null, 2))

const deadline = Date.now() + 8 * 60_000
let run = started.body
while (Date.now() < deadline) {
  await sleep(2500)
  const res = await request("GET", `/api/automation-apps/runs/${state.appRunId}`, undefined, 15_000)
  if (!res.ok) throw new Error(`查询运行失败 ${res.status}: ${res.text}`)
  run = res.body
  log(`status=${run.status} cursor=${run.cursor}`)
  if (run.status === "paused") {
    const resumed = await request("POST", `/api/automation-apps/runs/${state.appRunId}/resume`, { action: "confirm" }, 30_000)
    log(`unexpected pause(${run.results[run.cursor]?.pauseReason}) → confirm ${resumed.status}`)
    continue
  }
  if (["succeeded", "failed"].includes(run.status)) break
}

const after = countModelMessages((await request("GET", `/api/sessions/${state.sessionId}/messages`, undefined, 15_000)).body)
state.messagesAfterRun = after
const noModel = after.prompts === before.prompts && after.assistants === before.assistants

let output = null
const verifyPath = definition.verification?.path
if (verifyPath) {
  const file = await request("GET", `/api/sessions/${state.sessionId}/fs/content?path=${encodeURIComponent(`output/automation/${state.appRunId}/${verifyPath}`)}`, undefined, 30_000)
  output = { status: file.status, body: file.body?.content ?? file.text.slice(0, 300) }
}
state.appRunFinal = { status: run.status, error: run.error, results: run.results }
writeFileSync(`${DIR}state.json`, JSON.stringify(state, null, 2))
writeFileSync(`${DIR}run-result.json`, JSON.stringify({
  appRunId: state.appRunId,
  status: run.status,
  error: run.error,
  steps: run.results.map((item, index) => ({ index, stepId: item.stepId, status: item.status, output: (item.output ?? "").slice(0, 400) })),
  noModelDuringRun: noModel,
  messagesBeforeRun: before,
  messagesAfterRun: after,
  verification: definition.verification ?? null,
  verificationOutput: output,
}, null, 2))
log("app run done:", run.status, "noModel:", noModel, `user ${before.prompts}→${after.prompts}`, `assistant ${before.assistants}→${after.assistants}`, "output:", output ? output.status : "n/a")
if (run.status !== "succeeded" || !noModel) process.exit(1)
