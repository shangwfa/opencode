import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { baseFetch } from "./base-api"

export type AutomationApp = A.App
export type AutomationRun = A.Run
export type AutomationDefinition = A.Definition
export type AutomationStep = A.Step
export type AutomationDraft = A.Draft
export type DraftResult = { status: "generating" } | { status: "ready"; draft: A.Draft }
export type DistillResult =
  | { status: "published"; appId: string; runId: string; reusedRun?: boolean }
  | { status: "already_published"; appId: string }
  | { status: "testing"; draftId: string; version: number; runId: string }
const root = "/api/automation-apps"
const app = (id: string) => `${root}/${encodeURIComponent(id)}`
const run = (id: string) => `${root}/runs/${encodeURIComponent(id)}`
function request<T>(path: string, method = "GET", body?: unknown) {
  return baseFetch<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
export const automationApi = {
  list: () => request<{ items: A.App[] }>(root),
  detail: (id: string) => request<{ app: A.App; runs: A.Run[] }>(app(id)),
  draft: (sessionId: string) => request<{ definition: A.Definition }>(`${root}/draft`, "POST", { sessionId }),
  /** 发起可观察的草稿生成：返回临时生成会话与 promptId，前端订阅其 SSE 实时看进度。 */
  draftStart: (sessionId: string) =>
    request<{ sessionId: string; promptId: string; sourceSessionId: string }>(`${root}/draft/start`, "POST", { sessionId }),
  /**
   * 请求平台「沉淀应用」：平台自己走完整流程（定位草稿 → 草稿测试 → 门槛校验 → 发布）。
   * 不满足条件时返回原因，而不是假装成功。
   */
  distill: (sessionId: string, body: { draftId?: string } = {}) =>
    request<DistillResult>(`${root}/${encodeURIComponent(sessionId)}/distill`, "POST", body),
  /** 轮询一次可观察生成结果；未完成为 generating，完成即已落库为 draft。 */
  draftResult: (job: { sessionId: string; promptId: string }, sourceSessionId: string) =>
    request<DraftResult>(`${root}/draft/result`, "POST", { job, sourceSessionId }),
  createDraft: (sessionId: string, definition: A.Definition) => request<A.Draft>(`${root}/drafts`, "POST", { sessionId, definition }),
  fromLegacy: (appId: string, runId: string) => request<A.Draft>(`${root}/drafts/from-legacy`, "POST", { appId, runId }),
  draftDetail: (id: string) => request<A.Draft>(`${root}/drafts/${encodeURIComponent(id)}`),
  drafts: (sessionId: string) => request<{ items: A.Draft[] }>(`${root}/drafts?sessionId=${encodeURIComponent(sessionId)}`),
  importDraft: (sessionId: string, generationKey?: string) => request<A.Draft>(`${root}/drafts/import`, "POST", { sessionId, ...(generationKey ? { generationKey } : {}) }),
  draftRuns: (id: string) => request<{ items: A.Run[] }>(`${root}/drafts/${encodeURIComponent(id)}/runs`),
  testDraft: (id: string, body: { version: number; requestKey: string; parameters: Record<string, string> }) => request<A.Run>(`${root}/drafts/${encodeURIComponent(id)}/runs`, "POST", body),
  applyDraftRepair: (id: string, version: number, runId: string) => request<A.Draft>(`${root}/drafts/${encodeURIComponent(id)}/apply-repair`, "POST", { version, runId }),
  publishDraft: (id: string, version: number, runId: string) => request<A.App>(`${root}/drafts/${encodeURIComponent(id)}/publish`, "POST", { version, runId }),
  save: (definition: A.Definition) => request<A.App>(root, "POST", definition),
  run: (id: string, body: { sessionId: string; requestKey: string; parameters: Record<string, string>; confirmed?: boolean }) =>
    request<A.Run>(`${app(id)}/runs`, "POST", body),
  status: (id: string) => request<A.Run>(run(id)),
  resume: (id: string, action: "confirm" | "retry" | "skip" | "stop") =>
    request<A.Run>(`${run(id)}/resume`, "POST", { action }),
  applyRepair: (id: string) => request<{ applied: boolean }>(`${run(id)}/apply-repair`, "POST"),
  repair: (id: string) => request<A.Run>(`${run(id)}/repair`, "POST"),
}

export function operationLabel(step: A.Step) {
  return step.operation.type === "browser" ? "网页操作" : "文件与数据处理"
}

export function businessStages(steps: ReadonlyArray<A.Step>) {
  const stages: Array<{ title: string; entries: Array<{ step: A.Step; index: number }> }> = []
  steps.forEach((step, index) => {
    const previous = stages.at(-1)
    if (step.businessStage && previous && steps[index - 1]?.businessStage === step.businessStage) {
      previous.entries.push({ step, index })
    } else {
      stages.push({ title: step.businessStage ?? step.title, entries: [{ step, index }] })
    }
  })
  return stages
}

/**
 * 已发布应用运行结束后的修复保存提示。
 * 修复经重跑验证成功会自动保存；含跳过步骤则不保存并说明原因；其余不提示。
 */
export function repairSaveNotice(run: A.Run | null): "saved" | "skipped" | null {
  if (!run || run.status !== "succeeded") return null
  if (run.repairApplied) return "saved"
  // 有修复尝试（无论最终是否验证成功）但含跳过步骤：修复未经完整重跑验证，不会保存。
  if (run.results.some((result) => result.repairedOperation) && run.results.some((result) => result.skipped)) return "skipped"
  return null
}

/** cursor 是当前步骤；未来步骤不得因历史/占位结果误显示为暂停。 */
export function stepDisplayStatus(run: A.Run | null, index: number) {
  if (!run) return "待执行"
  if (index > run.cursor) return "待执行"
  const result = run.results[index]
  if (result?.status === "succeeded") return "已完成"
  if (index < run.cursor) return "待执行"
  if (run.status === "repairing") return "修复中"
  if (run.status === "paused" && result?.status === "paused") return "已暂停"
  if (run.status === "running") return "执行中"
  return "待执行"
}

export const runStatusLabel: Record<A.Run["status"], string> = {
  queued: "等待执行",
  running: "正在执行",
  paused: "等待你处理",
  repairing: "正在生成修复方案",
  succeeded: "已完成",
  failed: "已结束",
}
