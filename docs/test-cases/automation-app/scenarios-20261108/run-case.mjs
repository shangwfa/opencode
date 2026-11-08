/**
 * 单场景完整闭环执行器：bun run-case.mjs <browser|stats|report> [overrideParamsJSON]
 * 流程：创建会话 → 发任务（SSE 监视）→ 模型真实执行 → 生成固定草稿 → 草稿测试（自动确认）
 *      → 发布 → 用已发布应用运行（默认参数或覆盖参数）→ 断言产物与「无模型」。
 * 产物：state-<case>.json、result-<case>.json、sse-<case>.log。
 */
import { spawn } from "node:child_process"
import { writeFileSync, readFileSync, existsSync, openSync } from "node:fs"
import { api, signIn, createSession, waitTurn, countNow, readArtifact, sleep, log, SAAS, SAAS_PASSWORD } from "./lib.mjs"
import { CASES } from "./cases.mjs"

const caseName = process.argv[2]
const override = process.argv[3] ? JSON.parse(process.argv[3]) : null
const kase = CASES[caseName]
if (!kase) throw new Error(`未知用例：${caseName}（可选：${Object.keys(CASES).join(" / ")}）`)
const DIR = new URL(".", import.meta.url).pathname
const stateFile = `${DIR}state-${caseName}.json`
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {}
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2))
const trace = { forms: [], permissions: [] }
let sseChild

const startSse = (sessionId, file) => {
  const out = openSync(`${DIR}${file}`, "a")
  sseChild = spawn("bun", [`${DIR}../../scripts/session-sse-watch.mjs`, SAAS, SAAS_PASSWORD, sessionId, "1500"], {
    stdio: ["ignore", out, out],
  })
}

try {
  const token = state.token ?? (await signIn())
  state.token = token
  const request = api(token)

  if (!state.sessionId) {
    state.sessionId = await createSession(request, `场景E2E ${caseName} ${Date.now()}`)
    log("session", state.sessionId)
  }
  if (!state.promptId) {
    startSse(state.sessionId, `sse-${caseName}.log`)
    const sent = await request("POST", `/api/sessions/${state.sessionId}/message`, { parts: [{ type: "text", text: kase.task }] }, 120_000)
    if (!sent.ok) throw new Error(`发送任务失败 ${sent.status}: ${sent.text}`)
    state.promptId = sent.body?.data?.id ?? sent.body?.id
    state.messagesAtStart = await countNow(request, state.sessionId)
    log("prompt", state.promptId, "初始消息 user/assistant:", state.messagesAtStart.prompts, state.messagesAtStart.assistants)
  }
  save()

  if (!state.explore) {
    log("等待探索轮完成…")
    const turn = await waitTurn(request, state.sessionId, state.promptId, trace, 12 * 60_000)
    if (!turn.done) throw new Error("探索轮超时未完成")
    state.explore = { done: true, summary: turn.text.slice(-800) }
    save()
    log("探索完成，回复末尾：", turn.text.slice(-160).replace(/\n/g, " "))
  }

  if (!state.candidate) {
    log("生成固定草稿候选…")
    const draft = await request("POST", "/api/automation-apps/draft", { sessionId: state.sessionId }, 700_000)
    if (!draft.ok) throw new Error(`生成草稿失败 ${draft.status}: ${draft.text}`)
    state.candidate = draft.body.definition
    save()
    log("候选：", state.candidate.name, `steps=${state.candidate.steps.length}`, `params=${state.candidate.parameters.map((p) => p.key).join(",") || "无"}`, `verification=${state.candidate.verification?.path ?? "无"}`)
  }

  if (!state.draftId) {
    const saved = await request("POST", "/api/automation-apps/drafts", { sessionId: state.sessionId, definition: state.candidate }, 60_000)
    if (![200, 201].includes(saved.status)) throw new Error(`保存草稿失败 ${saved.status}: ${saved.text}`)
    state.draftId = saved.body.id
    state.draftVersion = saved.body.version
    log("draft", state.draftId, `v${state.draftVersion}`)
  }

  if (!state.draftTestId) {
    const parameters = Object.fromEntries(state.candidate.parameters.map((p) => [p.key, p.defaultValue]))
    const started = await request("POST", `/api/automation-apps/drafts/${state.draftId}/runs`, {
      version: state.draftVersion, requestKey: crypto.randomUUID(), parameters,
    }, 60_000)
    if (![200, 201].includes(started.status)) throw new Error(`草稿测试启动失败 ${started.status}: ${started.text}`)
    state.draftTestId = started.body.id
    state.beforeTest = await countNow(request, state.sessionId)
    log("draft test", state.draftTestId)
  }
  save()

  if (!state.draftTestFinal) {
    state.draftTestFinal = await driveRun(request, state.draftTestId, trace)
    state.afterTest = await countNow(request, state.sessionId)
    save()
  }
  const test = state.draftTestFinal
  const clean = test.status === "succeeded" && (test.results ?? []).length === state.candidate.steps.length &&
    (test.results ?? []).every((item) => item.status === "succeeded" && !item.skipped && !item.repairedOperation)
  if (!clean) throw new Error(`草稿测试未干净成功：${test.status} ${test.error ?? ""}`)

  if (!state.appId) {
    const published = await request("POST", `/api/automation-apps/drafts/${state.draftId}/publish`, { version: state.draftVersion, runId: state.draftTestId }, 60_000)
    if (![200, 201].includes(published.status)) throw new Error(`发布失败 ${published.status}: ${published.text}`)
    state.appId = published.body.id
    state.appVersion = published.body.version
    log("published", state.appId, `v${state.appVersion}`)
  }
  save()

  if (!state.appRunId) {
    let parameters = Object.fromEntries(state.candidate.parameters.map((p) => [p.key, p.defaultValue]))
    if (override && state.candidate.parameters.length) parameters = { ...parameters, ...override }
    state.runParameters = parameters
    state.beforeRun = await countNow(request, state.sessionId)
    const started = await request("POST", `/api/automation-apps/${state.appId}/runs`, {
      sessionId: state.sessionId, requestKey: crypto.randomUUID(), parameters, confirmed: true,
    }, 60_000)
    if (![200, 201].includes(started.status)) throw new Error(`应用运行启动失败 ${started.status}: ${started.text}`)
    state.appRunId = started.body.id
    log("app run", state.appRunId, JSON.stringify(parameters).slice(0, 160))
  }
  save()

  if (!state.appRunFinal) {
    state.appRunFinal = await driveRun(request, state.appRunId, trace)
    state.afterRun = await countNow(request, state.sessionId)
    save()
  }
  if (state.appRunFinal.status !== "succeeded") throw new Error(`应用运行未成功：${state.appRunFinal.status} ${state.appRunFinal.error ?? ""}`)

  const files = {}
  for (const relative of kase.artifacts) {
    const file = await readArtifact(request, state.sessionId, state.appRunId, relative)
    if (file.status !== 200) throw new Error(`产物缺失：${relative}（HTTP ${file.status}）`)
    files[relative] = file.content
  }
  const artifactOk = kase.assertArtifact(files)

  // 可选：换参数重跑一次（如 stats 用另一组数字），验证应用按参数而非死数据执行。
  let secondRun = null
  if (kase.secondRun) {
    if (!state.appRun2Id) {
      let params = Object.fromEntries(state.candidate.parameters.map((p) => [p.key, p.defaultValue]))
      const key = state.candidate.parameters.find((p) => kase.secondRun.pickParam.test(p.key))?.key ?? state.candidate.parameters[0]?.key
      if (key) params = { ...params, [key]: kase.secondRun.value }
      state.secondRunParameters = params
      const started = await request("POST", `/api/automation-apps/${state.appId}/runs`, {
        sessionId: state.sessionId, requestKey: crypto.randomUUID(), parameters: params, confirmed: true,
      }, 60_000)
      if (![200, 201].includes(started.status)) throw new Error(`二次运行启动失败 ${started.status}: ${started.text}`)
      state.appRun2Id = started.body.id
      log("app run #2", state.appRun2Id, JSON.stringify(params).slice(0, 160))
      save()
    }
    if (!state.appRun2Final) {
      state.appRun2Final = await driveRun(request, state.appRun2Id, trace)
      save()
    }
    if (state.appRun2Final.status !== "succeeded") throw new Error(`二次运行未成功：${state.appRun2Final.status}`)
    const files2 = {}
    for (const relative of kase.artifacts) {
      const file = await readArtifact(request, state.sessionId, state.appRun2Id, relative)
      if (file.status !== 200) throw new Error(`二次运行产物缺失：${relative}`)
      files2[relative] = file.content
    }
    secondRun = { appRunId: state.appRun2Id, parameters: state.secondRunParameters, artifacts: files2, ok: kase.secondRun.assertArtifact(files2) }
  }

  const noModelDuringTest = state.afterTest.prompts === state.beforeTest.prompts && state.afterTest.assistants === state.beforeTest.assistants
  const noModelDuringRun = state.afterRun.prompts === state.beforeRun.prompts && state.afterRun.assistants === state.beforeRun.assistants
  // 复杂度门槛：复杂用例必须真的由多条指令构成，不能退化成两三个动作。
  const stageCount = new Set(state.candidate.steps.map((step) => step.businessStage ?? step.title)).size
  const complexity = {
    steps: state.candidate.steps.length,
    stages: stageCount,
    minSteps: kase.minSteps ?? 0,
    minStages: kase.minStages ?? 0,
    ok: state.candidate.steps.length >= (kase.minSteps ?? 0) && stageCount >= (kase.minStages ?? 0),
  }
  const result = {
    case: caseName,
    title: kase.name,
    passed: artifactOk && noModelDuringRun && noModelDuringTest && complexity.ok && (secondRun ? secondRun.ok : true),
    ids: { sessionId: state.sessionId, promptId: state.promptId, draftId: state.draftId, draftTestId: state.draftTestId, appId: state.appId, appRunId: state.appRunId },
    steps: state.candidate.steps.map((s) => `${s.businessStage ?? "-"} | ${s.title} | ${s.operation.type}`),
    complexity,
    parameters: state.candidate.parameters.map((p) => p.key),
    runParameters: state.runParameters,
    draftTest: { status: test.status, decisions: state.draftTestFinal?.decisions ?? [], noModel: noModelDuringTest },
    appRun: { status: state.appRunFinal.status, outputs: (state.appRunFinal.results ?? []).map((r) => (r.output ?? "").slice(0, 200)), noModel: noModelDuringRun },
    artifacts: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.slice(0, 400)])),
    artifactOk,
    secondRun: secondRun ? { appRunId: secondRun.appRunId, parameters: secondRun.parameters, ok: secondRun.ok, artifacts: Object.fromEntries(Object.entries(secondRun.artifacts).map(([k, v]) => [k, v.slice(0, 400)])) } : null,
    verification: state.candidate.verification ?? null,
  }
  writeFileSync(`${DIR}result-${caseName}.json`, JSON.stringify(result, null, 2))
  save()
  log(`用例 ${caseName} ${result.passed ? "通过 ✓" : "失败 ✗"}`, `steps=${complexity.steps}(≥${complexity.minSteps}) stages=${complexity.stages}(≥${complexity.minStages})`, `artifactOk=${artifactOk} noModel(test/run)=${noModelDuringTest}/${noModelDuringRun}`)
  if (!result.passed) process.exit(1)
} finally {
  sseChild?.kill()
}

/** 运行循环：确认类暂停自动放行；修复/结果不确定视为用例失败并停机留证。 */
async function driveRun(request, runId, trace) {
  const decisions = []
  const deadline = Date.now() + 10 * 60_000
  let run = { status: "unknown" }
  while (Date.now() < deadline) {
    await sleep(2500)
    const res = await request("GET", `/api/automation-apps/runs/${runId}`, undefined, 15_000)
    if (!res.ok) throw new Error(`查询运行失败 ${res.status}: ${res.text}`)
    run = res.body
    log(`  status=${run.status} cursor=${run.cursor}`)
    if (run.status === "paused") {
      const reason = run.results[run.cursor]?.pauseReason
      if (reason === "confirmation") {
        const resumed = await request("POST", `/api/automation-apps/runs/${runId}/resume`, { action: "confirm" }, 30_000)
        decisions.push({ cursor: run.cursor, action: "confirm", status: resumed.status })
        continue
      }
      return { status: run.status, error: run.error, results: run.results, decisions, stuckReason: reason }
    }
    if (["succeeded", "failed"].includes(run.status)) return { status: run.status, error: run.error, results: run.results, decisions }
  }
  return { status: "timeout", error: "运行超时", results: run.results ?? [], decisions }
}
