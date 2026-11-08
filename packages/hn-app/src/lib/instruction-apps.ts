import type { AutomationInstruction as I } from "@opencode/schema/automation-instruction"
import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { baseFetch } from "./base-api"

export type InstructionDefinition = I.Definition
export type InstructionDraft = I.Draft
export type InstructionApp = I.App
export type InstructionRun = I.Run
export type Parameter = A.Parameter

const root = "/api/instruction-apps"
const draft = (id: string) => `${root}/drafts/${encodeURIComponent(id)}`
const app = (id: string) => `${root}/apps/${encodeURIComponent(id)}`
const run = (id: string) => `${root}/runs/${encodeURIComponent(id)}`

function request<T>(path: string, method = "GET", body?: unknown) {
  return baseFetch<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

export const instructionApi = {
  drafts: (sessionId: string) => request<{ items: I.Draft[] }>(`${root}/drafts?sessionId=${encodeURIComponent(sessionId)}`),
  generate: (sessionId: string, generationKey?: string) => request<{ definition: I.Definition; draft: I.Draft }>(`${root}/drafts/generate`, "POST", { sessionId, ...(generationKey ? { generationKey } : {}) }),
  updateDraft: (id: string, body: { version: number; definition: I.Definition }) =>
    request<I.Draft>(draft(id), "PUT", body),
  draftRuns: (id: string) => request<{ items: I.Run[] }>(`${draft(id)}/runs`),
  testDraft: (id: string, body: { version: number; requestKey: string; parameters: Record<string, string>; confirmed?: boolean }) =>
    request<I.Run>(`${draft(id)}/runs`, "POST", body),
  publish: (id: string, version: number, runId: string) =>
    request<I.App>(`${draft(id)}/publish`, "POST", { version, runId }),
  apps: () => request<{ items: I.App[] }>(`${root}/apps`),
  app: (id: string) => request<I.App>(app(id)),
  appRuns: (id: string) => request<{ items: I.Run[] }>(`${app(id)}/runs`),
  runApp: (id: string, body: { sessionId: string; requestKey: string; parameters: Record<string, string>; confirmed?: boolean }) =>
    request<I.Run>(`${app(id)}/runs`, "POST", body),
  status: (id: string) => request<I.Run>(run(id)),
  runMessages: (id: string) => request<{ data: Array<Record<string, unknown>> }>(`${run(id)}/messages`),
  resume: (id: string, action: "retry" | "stop") => request<I.Run>(`${run(id)}/resume`, "POST", { action }),
}

export const instructionStatusLabel: Record<I.Run["status"], string> = {
  queued: "等待执行",
  running: "执行中",
  regenerating: "执行失败，正在重新生成应用",
  paused: "已暂停",
  succeeded: "执行成功",
  failed: "执行失败",
}
