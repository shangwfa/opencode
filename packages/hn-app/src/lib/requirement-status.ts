/** 需求状态 → 文案与色点（列表/工作台共用，避免各写一份） */
export const REQUIREMENT_STATUS: Record<string, { label: string; dot: string }> = {
  draft: { label: "草稿", dot: "bg-muted-foreground/40" },
  open: { label: "待处理", dot: "bg-blue-500" },
  in_progress: { label: "进行中", dot: "bg-amber-500" },
  pending_publish: { label: "待发布", dot: "bg-violet-500" },
  done: { label: "已完成", dot: "bg-emerald-500" },
  archived: { label: "已归档", dot: "bg-muted-foreground/40" },
}

export function requirementStatus(status: string): { label: string; dot: string } {
  return REQUIREMENT_STATUS[status] ?? { label: status, dot: "bg-muted-foreground/40" }
}
