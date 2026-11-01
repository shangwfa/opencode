import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { baseFetch } from "./base-api"

export type AutomationApp = A.App
export type AutomationRun = A.Run
export type AutomationDefinition = A.Definition
export type AutomationStep = A.Step
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
  save: (definition: A.Definition) => request<A.App>(root, "POST", definition),
  run: (id: string, body: { sessionId: string; requestKey: string; parameters: Record<string, string> }) =>
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

export const runStatusLabel: Record<A.Run["status"], string> = {
  queued: "等待执行",
  running: "正在执行",
  paused: "等待你处理",
  repairing: "正在生成修复方案",
  succeeded: "已完成",
  failed: "已结束",
}
