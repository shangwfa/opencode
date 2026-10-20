/**
 * 设置类页面共用的小组件（Git 服务连接 / 应用 等复用）。
 * 避免每个页面各写一份 Field、ProviderLogo、提示条与空态。
 */
import { GitBranch, Github } from "lucide-react"
import { cn } from "@/lib/utils"

/** 表单字段：label + 可选 hint + 控件 */
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium">{label}</span>
        {hint && <span className="text-muted-foreground/70 text-[11px]">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

export type GitProviderType = "gitlab" | "github"

/** Git 服务品牌图标（GitHub 黑 / GitLab 橙；不引入额外品牌包） */
export function ProviderLogo({ type, size = "md" }: { type: GitProviderType; size?: "sm" | "md" }) {
  const box = size === "md" ? "size-9 rounded-lg" : "size-7 rounded-md"
  if (type === "github") {
    return (
      <span className={cn("flex shrink-0 items-center justify-center bg-zinc-950 text-white", box)}>
        <Github className={size === "md" ? "size-4" : "size-3.5"} />
      </span>
    )
  }
  return (
    <span className={cn("flex shrink-0 items-center justify-center bg-orange-500 text-white", box)}>
      <GitBranch className={size === "md" ? "size-4" : "size-3.5"} strokeWidth={2.1} />
    </span>
  )
}

/** 提示条：warn 用于未配置/需注意，info 用于说明 */
export function AlertNotice({
  tone = "info",
  icon,
  children,
}: {
  tone?: "warn" | "info"
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2.5 text-[12px] leading-relaxed",
        tone === "warn"
          ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : "bg-muted text-muted-foreground",
      )}
    >
      <span className="mt-px shrink-0">{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** 页面级空态（图标 + 标题 + 说明 + 操作） */
export function EmptyBlock({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
      <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-lg">
        {icon}
      </div>
      <div className="space-y-1">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

/** 页面级状态块（加载/错误） */
export function StatusBlock({
  loading,
  message,
  action,
}: {
  loading?: boolean
  message: string
  action?: React.ReactNode
}) {
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 py-16 text-sm">
      {loading ? <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
      <span className="text-center">{message}</span>
      {action}
    </div>
  )
}
