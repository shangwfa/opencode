/**
 * 项目接入状态看板（React + shadcn 版）。
 * 源：xybot-front-opencode-ui src/pages/project-intake/ProjectIntakeStatusBoard.tsx（Solid）
 * 语义 1:1：轮询确认任务（2s 间隔，终态停止）、状态摘要（总数/进行中/成功/失败）、
 * 失败子任务重试、子任务卡片（应用·分支 / GitLab 地址 / 三步进度 / 错误 / 子会话链接）。
 * 数据源：业务接入服务 harness（VITE_BOSS_API_URL）；未配置或不可达时进入错误态。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Check, FolderInput, RefreshCw, TriangleAlert, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { showToast } from "@/ui/components/toast"
import { requirementApiBase } from "@/api/requirement/client"
import {
  fetchProjectIntakeConfirmJob,
  retryProjectIntakeConfirmJob,
  type ProjectIntakeConfirmJobChild,
  type ProjectIntakeConfirmJobPollResponse,
} from "@/api/project-intake/confirmJob"
import {
  childStatusLabel,
  isJobTerminal,
  jobStats,
  jobStatusLabel,
  shouldPoll,
  stepsOf,
  type StepState,
} from "./board-view"

const POLL_INTERVAL_MS = 2_000

export function ProjectIntakeStatusBoard({
  sessionId,
  directory,
  className,
}: {
  sessionId?: string
  directory?: string
  className?: string
}) {
  const [data, setData] = useState<ProjectIntakeConfirmJobPollResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState("")
  const [retrying, setRetrying] = useState(false)
  const inFlight = useRef(false)
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const id = sessionRef.current?.trim()
    if (!id) {
      setData(null)
      setError("")
      setLoading(false)
      setRefreshing(false)
      return
    }
    // 未配置接入服务：直接说明原因，避免后续解析 SPA 回退 HTML 报「响应格式无效」
    if (!requirementApiBase) {
      setData(null)
      setError("需求数据服务未配置：请设置 VITE_BOSS_API_URL 后重启，届时可查看项目创建进度")
      setLoading(false)
      setRefreshing(false)
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    if (opts?.silent) setRefreshing(true)
    else setLoading(true)
    setError("")
    try {
      const next = await fetchProjectIntakeConfirmJob(id)
      if (sessionRef.current?.trim() !== id) return
      setData(next)
    } catch (e) {
      if (sessionRef.current?.trim() !== id) return
      setError(e instanceof Error ? e.message : "查询项目状态失败")
    } finally {
      inFlight.current = false
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  // sessionId 变化即重新拉取
  useEffect(() => {
    void load()
  }, [sessionId, load])

  // 未到终态时每 2s 静默轮询
  useEffect(() => {
    if (loading || refreshing) return
    if (!sessionId?.trim() || !shouldPoll(data, error)) return
    const timer = setTimeout(() => void load({ silent: true }), POLL_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [loading, refreshing, sessionId, data, error, load])

  const stats = jobStats(data)

  const handleRetry = async () => {
    const id = sessionId?.trim()
    if (!id || retrying) return
    setRetrying(true)
    try {
      const next = await retryProjectIntakeConfirmJob(id)
      setData(next)
      await load()
    } catch (e) {
      showToast({
        variant: "error",
        title: "重试失败",
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setRetrying(false)
    }
  }

  return (
    <aside
      data-component="project-intake-status-board"
      className={cn("bg-background flex h-full w-[360px] shrink-0 flex-col border-l", className)}
    >
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
        <div className="min-w-0">
          <p className="text-muted-foreground/70 text-[11px] tracking-wide uppercase">项目状态</p>
          <p className="truncate text-[13px] font-medium">创建子任务流程</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading || refreshing}
          onClick={() => void load()}
          title="刷新项目状态"
          className="text-muted-foreground hover:text-foreground h-7 shrink-0 gap-1.5 rounded-md px-2 text-xs"
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          {refreshing ? "更新中" : "刷新"}
        </Button>
      </div>

      {loading ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
          <RefreshCw className="size-4 animate-spin" />
          读取项目状态…
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !data ? (
        <EmptyState />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className={cn("size-2 rounded-full", dotClass(data.status))} />
                <span className={cn("text-[13px] font-medium", toneClass(data.status))}>
                  {jobStatusLabel[data.status]}
                </span>
              </div>
              {!isJobTerminal(data.status) && (
                <div className="text-muted-foreground flex items-center gap-1 text-xs">
                  <RefreshCw className="size-3 animate-spin" />
                  自动更新
                </div>
              )}
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2">
              <SummaryPill label="总数" value={stats.total} />
              <SummaryPill label="进行中" value={stats.pending} />
              <SummaryPill label="成功" value={stats.success} />
              <SummaryPill label="失败" value={stats.failed} />
            </div>
            {data.error && (
              <p className="bg-muted/60 mt-3 rounded-md px-2 py-1.5 text-xs break-all text-destructive">
                {data.error}
              </p>
            )}
            {data.status === "failed" && stats.failed > 0 && (
              <Button size="sm" variant="secondary" disabled={retrying} onClick={() => void handleRetry()} className="mt-3 w-full">
                {retrying ? "重试中…" : "重试失败子任务"}
              </Button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {data.children.length === 0 ? (
              <p className="text-muted-foreground py-8 text-center text-sm">{emptyChildrenText(data.status)}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {data.children.map((child) => (
                  <ChildCard key={`${child.app_id}:${child.item_seq}`} child={child} directory={directory} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}

function toneClass(status: ProjectIntakeConfirmJobPollResponse["status"]) {
  if (status === "success") return "text-emerald-600 dark:text-emerald-400"
  if (status === "failed") return "text-destructive"
  if (status === "running") return "text-foreground"
  return "text-muted-foreground"
}

function dotClass(status: ProjectIntakeConfirmJobPollResponse["status"]) {
  if (status === "success") return "bg-emerald-500"
  if (status === "failed") return "bg-destructive"
  if (status === "running") return "bg-foreground"
  return "bg-muted-foreground/50"
}

function stepCircleClass(state: StepState) {
  if (state === "done") return "bg-emerald-500 text-white"
  if (state === "current") return "bg-foreground text-background"
  if (state === "failed") return "bg-destructive text-white"
  return "bg-muted text-muted-foreground"
}

function childBorderClass(child: ProjectIntakeConfirmJobChild) {
  if (child.status === "success") return "border-emerald-500/40"
  if (child.status === "failed") return "border-destructive/40"
  return "border-border"
}

function emptyChildrenText(status: ProjectIntakeConfirmJobPollResponse["status"]) {
  if (status === "pending_confirm") return "等待用户确认后生成子任务明细"
  if (status === "queued" || status === "running") return "任务已提交，正在初始化子任务明细"
  return "暂无子任务明细"
}

/** 子任务跳转：本项目需求对话路由 /requirement-chat/:repo/:sessionId */
function requirementChatHref(directory: string | undefined, child: ProjectIntakeConfirmJobChild) {
  if (!directory || !child.sessionId) return undefined
  const repo = child.app_id || child.app_name || "unknown"
  return `/requirement-chat/${encodeURIComponent(repo)}/${encodeURIComponent(child.sessionId)}${
    child.reqId ? `?req=${encodeURIComponent(child.reqId)}` : ""
  }`
}

function SummaryPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-muted/50 rounded-md border px-2 py-1">
      <p className="text-muted-foreground/70 text-[10px]">{label}</p>
      <p className="text-[13px] font-medium tabular-nums">{value}</p>
    </div>
  )
}

function ChildCard({ child, directory }: { child: ProjectIntakeConfirmJobChild; directory?: string }) {
  const href = requirementChatHref(directory, child)
  return (
    <div className={cn("bg-muted/40 rounded-lg border px-3 py-3", childBorderClass(child))}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium">{child.title || "未命名子任务"}</p>
          <p className="text-muted-foreground mt-0.5 truncate text-[11px]">
            {child.app_name || child.app_id || "unknown"} · {child.base_branch || "master"}
          </p>
        </div>
        <span className="bg-background shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {childStatusLabel[child.status]}
        </span>
      </div>

      <p className="text-muted-foreground/80 mt-2 line-clamp-2 text-[11px] break-all">
        {child.target_gitlab || "暂无 GitLab 地址"}
      </p>

      <div className="mt-3 grid grid-cols-3 gap-1">
        {stepsOf(child.status).map((step) => (
          <div key={step.id} className="min-w-0">
            <div
              className={cn("mx-auto flex size-5 items-center justify-center rounded-full", stepCircleClass(step.state))}
              title={step.label}
            >
              {step.state === "done" ? (
                <Check className="size-2.5" />
              ) : step.state === "failed" ? (
                <X className="size-2.5" />
              ) : null}
            </div>
            <p className="text-muted-foreground/80 mt-1 truncate text-center text-[10px]">{step.label}</p>
          </div>
        ))}
      </div>

      {child.error && (
        <p className="bg-background text-destructive mt-3 rounded-md px-2 py-1.5 text-[11px]">{child.error}</p>
      )}

      {child.sessionId && (
        <div className="mt-3 flex items-center justify-between gap-2 border-t pt-2">
          <div className="min-w-0">
            <p className="text-muted-foreground/70 text-[10px]">子任务链接</p>
            <p className="truncate text-[11px] font-medium">{child.sessionId}</p>
          </div>
          {href && (
            <a
              href={href}
              className="text-foreground shrink-0 rounded px-2 py-1 text-[11px] font-medium underline decoration-border underline-offset-2 hover:decoration-foreground"
            >
              打开
            </a>
          )}
        </div>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-10 text-center">
      <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-lg">
        <FolderInput className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-[13px] font-medium">等待确认任务</p>
        <p className="text-muted-foreground text-xs leading-relaxed">
          用户确认创建子 session 后，这里会自动展示项目创建进度。
        </p>
      </div>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-10 text-center">
      <TriangleAlert className="size-5 text-amber-500" />
      <div className="space-y-1">
        <p className="text-[13px] font-medium">状态读取失败</p>
        <p className="text-muted-foreground max-w-xs text-xs leading-relaxed">{message || "查询项目状态失败"}</p>
      </div>
      <Button size="sm" variant="secondary" onClick={onRetry} className="gap-1.5">
        <RefreshCw className="size-3.5" />
        重试
      </Button>
    </div>
  )
}