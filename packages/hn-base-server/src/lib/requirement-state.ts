/**
 * 需求状态机。
 *
 * draft → open → in_progress → pending_publish → done
 *                    ↖──────────┘         ↖──────┘   （允许回退）
 * 任意 → archived（终态）
 *
 * 源项目的状态散落在多处手工改动、pending_publish 无自动流转（见调研），这里收敛为单一规则。
 */

export type RequirementStatus =
  | "draft"
  | "open"
  | "in_progress"
  | "pending_publish"
  | "done"
  | "archived"

export const STATUSES: RequirementStatus[] = [
  "draft",
  "open",
  "in_progress",
  "pending_publish",
  "done",
  "archived",
]

export const STATUS_LABELS: Record<RequirementStatus, string> = {
  draft: "草稿",
  open: "待处理",
  in_progress: "进行中",
  pending_publish: "待发布",
  done: "已完成",
  archived: "已归档",
}

const TRANSITIONS: Record<RequirementStatus, RequirementStatus[]> = {
  draft: ["open", "archived"],
  open: ["in_progress", "archived"],
  in_progress: ["pending_publish", "open", "archived"],
  pending_publish: ["done", "in_progress", "archived"],
  done: ["archived"],
  archived: [],
}

export function isRequirementStatus(value: string): value is RequirementStatus {
  return (STATUSES as string[]).includes(value)
}

export function canTransition(from: RequirementStatus, to: RequirementStatus): boolean {
  if (from === to) return true
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function allowedTransitions(from: RequirementStatus): RequirementStatus[] {
  return TRANSITIONS[from] ?? []
}

/** 状态机非法时抛出可读错误（由路由转 409） */
export function transitionError(from: RequirementStatus, to: RequirementStatus): string | undefined {
  if (canTransition(from, to)) return undefined
  const allowed = allowedTransitions(from)
  if (allowed.length === 0) return `需求已处于终态「${STATUS_LABELS[from]}」，不能再次变更`
  return `不能从「${STATUS_LABELS[from]}」变更为「${STATUS_LABELS[to]}」，允许：${allowed
    .map((s) => STATUS_LABELS[s])
    .join(" / ")}`
}
