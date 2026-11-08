/**
 * Phase C：审阅候选 → 保存草稿 → 草稿测试（确认暂停自动代答）→ 发布为固定应用。
 * 产物：state.json 增量（draftId、draftTestId、appId）、publish-result.json。
 * 全程记录消息数：草稿测试属固定执行器路径，不应新增模型消息。
 */
import { writeFileSync, readFileSync, statSync } from "node:fs"
import { signIn, api, log, sleep, DIR } from "./lib.mjs"

const state = JSON.parse(readFileSync(`${DIR}state.json`, "utf8"))
const request = api(state.token ?? (await signIn()))

const candidate = JSON.parse(readFileSync(`${DIR}draft-candidate.json`, "utf8")).definition
if (!candidate.steps.length) throw new Error("候选无步骤，不能保存")

// 1. 保存草稿
const saved = await request("POST", "/api/automation-apps/drafts", { sessionId: state.sessionId, definition: candidate }, 60_000)
if (![200, 201].includes(saved.status)) throw new Error(`保存草稿失败 ${saved.status}: ${saved.text}`)
state.draftId = saved.body.id
state.draftVersion = saved.body.version
log("draft", state.draftId, `v${state.draftVersion}`)

// 2. 草稿测试运行
const parameters = Object.fromEntries(candidate.parameters.map((p) => [p.key, p.defaultValue]))
const messagesBefore = await request("GET", `/api/sessions/${state.sessionId}/messages`, undefined, 15_000)
state.messagesBeforeTest = (messagesBefore.body?.data ?? []).length
const started = await request("POST", `/api/automation-apps/drafts/${state.draftId}/runs`, {
  version: state.draftVersion,
  requestKey: crypto.randomUUID(),
  parameters,
}, 60_000)
if (![200, 201].includes(started.status)) throw new Error(`草稿测试启动失败 ${started.status}: ${started.text}`)
state.draftTestId = started.body.id
log("draft test run", state.draftTestId, JSON.stringify(parameters))
writeFileSync(`${DIR}state.json`, JSON.stringify(state, null, 2))

// 3. 轮询至终态；确认类暂停自动 confirm，其余暂停视为用例失败并停机留证
const decisions = []
const deadline = Date.now() + 10 * 60_000
let run = started.body
while (Date.now() < deadline) {
  await sleep(2500)
  const res = await request("GET", `/api/automation-apps/runs/${state.draftTestId}`, undefined, 15_000)
  if (!res.ok) throw new Error(`查询运行失败 ${res.status}: ${res.text}`)
  run = res.body
  log(`status=${run.status} cursor=${run.cursor}`)
  if (run.status === "paused") {
    const current = run.results[run.cursor]
    if (current?.pauseReason === "confirmation") {
      const resumed = await request("POST", `/api/automation-apps/runs/${state.draftTestId}/resume`, { action: "confirm" }, 30_000)
      decisions.push({ at: run.cursor, action: "confirm", status: resumed.status })
      log(`resume confirm @${run.cursor} → ${resumed.status}`)
      continue
    }
    state.draftTestPaused = { pauseReason: current?.pauseReason, error: run.error }
    break
  }
  if (["succeeded", "failed"].includes(run.status)) break
}
state.draftTestFinal = { status: run.status, error: run.error, results: run.results, decisions }
writeFileSync(`${DIR}state.json`, JSON.stringify(state, null, 2))

// 4. 校验：完整成功、无修复、无跳过，才允许发布
const clean = run.status === "succeeded" &&
  run.results.length === candidate.steps.length &&
  run.results.every((item) => item.status === "succeeded" && !item.skipped && !item.repairedOperation)
if (!clean) {
  writeFileSync(`${DIR}publish-result.json`, JSON.stringify({ published: false, reason: "草稿测试未完整成功", final: state.draftTestFinal }, null, 2))
  throw new Error(`草稿测试未完整成功：${run.status} ${run.error ?? ""}`)
}

const messagesAfter = await request("GET", `/api/sessions/${state.sessionId}/messages`, undefined, 15_000)
state.messagesAfterTest = (messagesAfter.body?.data ?? []).length
log(`messages before/after test: ${state.messagesBeforeTest}/${state.messagesAfterTest}`)

// 5. 发布
const published = await request("POST", `/api/automation-apps/drafts/${state.draftId}/publish`, { version: state.draftVersion, runId: state.draftTestId }, 60_000)
if (![200, 201].includes(published.status)) throw new Error(`发布失败 ${published.status}: ${published.text}`)
state.appId = published.body.id
state.appVersion = published.body.version
writeFileSync(`${DIR}state.json`, JSON.stringify(state, null, 2))
writeFileSync(`${DIR}publish-result.json`, JSON.stringify({ published: true, appId: state.appId, version: state.appVersion, draftTestId: state.draftTestId, noModelDuringTest: state.messagesAfterTest === state.messagesBeforeTest }, null, 2))
log("published", state.appId, `v${state.appVersion}`)
