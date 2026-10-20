/**
 * 状态看板的展示映射（对齐源 ProjectIntakeStatusBoard.tsx 内的 class/label 函数，
 * 从 JSX 中抽出以便单测与复用，不重复实现状态判定）。
 */
import type {
  ProjectIntakeConfirmJobChildStatus,
  ProjectIntakeConfirmJobPollResponse,
  ProjectIntakeConfirmJobStatus,
} from "@/api/project-intake/confirmJob"

export type StepId = "queued" | "preparing" | "success"
export type StepState = "todo" | "current" | "done" | "failed"
export type StepView = { id: StepId; label: string; state: StepState }

const childStatusOrder: Record<ProjectIntakeConfirmJobChildStatus, number> = {
  queued: 0,
  preparing: 1,
  success: 2,
  failed: 2,
}

export const stepLabels: Record<StepId, string> = {
  queued: "等待中",
  preparing: "初始化",
  success: "完成",
}

export const jobStatusLabel: Record<ProjectIntakeConfirmJobStatus, string> = {
  pending_confirm: "等待确认",
  queued: "等待执行",
  running: "创建中",
  success: "已完成",
  failed: "创建失败",
}

export const childStatusLabel: Record<ProjectIntakeConfirmJobChildStatus, string> = {
  queued: "等待中",
  preparing: "初始化中",
  success: "已完成",
  failed: "创建失败",
}

export function isJobTerminal(status: ProjectIntakeConfirmJobStatus): boolean {
  return status === "success" || status === "failed"
}

export function shouldPoll(
  job: ProjectIntakeConfirmJobPollResponse | null,
  error: string,
): boolean {
  if (error.trim()) return false
  if (!job) return true
  return !isJobTerminal(job.status)
}

export function stepsOf(status: ProjectIntakeConfirmJobChildStatus): StepView[] {
  const currentIndex = childStatusOrder[status]
  const failed = status === "failed"
  return (["queued", "preparing", "success"] as const).map((id, index) => {
    let state: StepState = "todo"
    if (failed && index === currentIndex) state = "failed"
    else if (index < currentIndex || status === "success") state = "done"
    else if (index === currentIndex) state = "current"
    return { id, label: stepLabels[id], state }
  })
}

export function jobStats(job: ProjectIntakeConfirmJobPollResponse | null) {
  const children = job?.children ?? []
  const success = children.filter((c) => c.status === "success").length
  const failed = children.filter((c) => c.status === "failed").length
  return { total: children.length, success, failed, pending: children.length - success - failed }
}