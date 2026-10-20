/**
 * 全局需求列表：展示我可见的全部需求（跨应用），支持搜索、创建需求并进入会话。
 *
 * - 点击需求：有主会话时打开（所属应用 → 工作台内嵌会话；无应用 → 需求对话）
 * - 创建需求：填标题/描述/可选应用 → 创建需求 + 会话 → 跳到对应会话
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router"
import {
  AlertCircle,
  ChevronRight,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/toast"
import { BaseApiError, hnApi, type HnApp, type HnRequirement } from "@/lib/base-api"
import { usingBaseServer } from "@/lib/session-source"
import { requirementStatus } from "@/lib/requirement-status"
import { cn } from "@/lib/utils"

function formatDate(ts?: number): string {
  if (!ts) return ""
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 打开需求对应的会话 */
function useOpenRequirement() {
  const navigate = useNavigate()
  return useCallback(
    (item: HnRequirement) => {
      if (!item.sessionId) return
      if (item.appId) {
        navigate(`/apps/${encodeURIComponent(item.appId)}?session=${encodeURIComponent(item.sessionId)}`)
      } else {
        navigate(`/requirement-chat/-/${encodeURIComponent(item.sessionId)}`)
      }
    },
    [navigate],
  )
}

export function RequirementsPage() {
  const enabled = usingBaseServer()
  const toast = useToast()
  const openRequirement = useOpenRequirement()

  const [items, setItems] = useState<HnRequirement[]>([])
  const [apps, setApps] = useState<HnApp[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [debounced, setDebounced] = useState("")
  const [createOpen, setCreateOpen] = useState(false)

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 280)
    return () => clearTimeout(timer)
  }, [query])

  const load = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setError("")
    try {
      const res = await hnApi.requirements({ q: debounced || undefined, limit: 200 })
      setItems(res.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [enabled, debounced])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!enabled) return
    void hnApi
      .apps()
      .then((res) => setApps(res.items ?? []))
      .catch(() => setApps([]))
  }, [enabled])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-10">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[22px] leading-tight font-semibold tracking-tight">需求</h1>
            <p className="text-muted-foreground mt-1.5 text-sm">全部需求与关联会话，点开即可继续开发</p>
          </div>
          <Button onClick={() => setCreateOpen(true)} disabled={!enabled} className="gap-1.5">
            <Plus className="size-4" />
            创建需求
          </Button>
        </header>

        {enabled && (
          <div className="relative mb-4">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索需求标题或 ID…"
              className="h-9 pl-9"
            />
            {loading && query !== debounced && (
              <Loader2 className="text-muted-foreground absolute top-1/2 right-3 size-3.5 -translate-y-1/2 animate-spin" />
            )}
          </div>
        )}

        {!enabled ? (
          <div className="bg-amber-500/10 text-amber-700 dark:text-amber-400 flex items-start gap-2 rounded-lg px-3 py-2.5 text-[12px] leading-relaxed">
            <AlertCircle className="mt-px size-4 shrink-0" />
            <span>
              未启用网关模式（<code className="text-[11px]">VITE_HN_BASE_URL</code>），需求列表依赖 hn-base-server。
            </span>
          </div>
        ) : loading && items.length === 0 ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-20 text-sm">
            <Loader2 className="size-4 animate-spin" /> 读取需求…
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <AlertCircle className="size-5 text-amber-500" />
            <p className="text-muted-foreground text-sm">{error}</p>
            <Button size="sm" variant="secondary" onClick={() => void load()} className="gap-1.5">
              <RefreshCw className="size-3.5" /> 重试
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
            <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-lg">
              <FileText className="size-5" />
            </div>
            <div className="space-y-1">
              <p className="text-[13px] font-medium">{debounced ? "没有匹配的需求" : "还没有需求"}</p>
              <p className="text-muted-foreground text-xs">
                {debounced ? "换个关键词试试" : "创建一个需求，直接进入会话开始开发"}
              </p>
            </div>
            {!debounced && (
              <Button size="sm" onClick={() => setCreateOpen(true)} className="mt-1 gap-1.5">
                <Plus className="size-3.5" /> 创建需求
              </Button>
            )}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            {items.map((item, index) => {
              const meta = requirementStatus(item.status)
              const clickable = Boolean(item.sessionId)
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={!clickable}
                  onClick={() => openRequirement(item)}
                  className={cn(
                    "hover:bg-muted/40 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors disabled:cursor-default disabled:opacity-70",
                    index > 0 && "border-t",
                  )}
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", meta.dot)} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium">{item.title || "未命名需求"}</span>
                      {item.kind === "bugfix" && (
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          Bugfix
                        </Badge>
                      )}
                      {!item.sessionId && (
                        <Badge variant="outline" className="text-muted-foreground shrink-0 text-[10px]">
                          无会话
                        </Badge>
                      )}
                    </span>
                    <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-[11px]">
                      <span>{meta.label}</span>
                      {item.appName && <span>· {item.appName}</span>}
                      <span>· {formatDate(item.timeUpdated)}</span>
                    </span>
                  </span>
                  {clickable && <ChevronRight className="text-muted-foreground/60 size-3.5 shrink-0" />}
                </button>
              )
            })}
          </div>
        )}

        <CreateRequirementDialog
          open={createOpen}
          apps={apps}
          onOpenChange={setCreateOpen}
          onCreated={async (target) => {
            setCreateOpen(false)
            await load()
            if (target) {
              toast({ title: "需求已创建", description: "正在进入会话" })
              if (target.appId) {
                window.location.hash = `#/apps/${encodeURIComponent(target.appId)}?session=${encodeURIComponent(target.sessionId)}`
              } else {
                window.location.hash = `#/requirement-chat/-/${encodeURIComponent(target.sessionId)}`
              }
            }
          }}
        />
      </div>
    </div>
  )
}

type CreatedTarget = { appId?: string; sessionId: string }

function CreateRequirementDialog({
  open,
  apps,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  apps: HnApp[]
  onOpenChange: (open: boolean) => void
  onCreated: (target?: CreatedTarget) => Promise<void> | void
}) {
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [appId, setAppId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const selectedApp = useMemo(() => apps.find((x) => x.appId === appId), [apps, appId])

  const reset = () => {
    setTitle("")
    setDescription("")
    setAppId("")
    setError("")
    setBusy(false)
  }

  const submit = async () => {
    const value = title.trim()
    if (!value || busy) return
    setBusy(true)
    setError("")
    try {
      const prepared = await hnApi.prepareRequirement({
        title: value,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(appId ? { appId } : {}),
        ...(selectedApp?.gitProviderInstanceId ? { gitProviderId: selectedApp.gitProviderInstanceId } : {}),
        ...(selectedApp?.repoUrl ? { repoUrl: selectedApp.repoUrl } : {}),
        ...(selectedApp?.defaultBranch ? { baseBranch: selectedApp.defaultBranch } : {}),
        ...(selectedApp?.defaultBranch ? { workBranch: selectedApp.defaultBranch } : {}),
        directory: "/workspace",
      })
      const target: CreatedTarget = { sessionId: prepared.sessionId, ...(appId ? { appId } : {}) }
      reset()
      await onCreated(target)
    } catch (err) {
      setError(err instanceof BaseApiError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>创建需求</DialogTitle>
          <DialogDescription>创建后会立即建立会话，直接进入开发。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <span className="text-[13px] font-medium">需求标题</span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：台账支持导出 CSV"
              className="h-9"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] font-medium">描述</span>
              <span className="text-muted-foreground/70 text-[11px]">可选</span>
            </div>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="背景、目标、验收标准…"
              className="min-h-[88px] resize-none text-[13px]"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] font-medium">所属应用</span>
              <span className="text-muted-foreground/70 text-[11px]">可选</span>
            </div>
            <select
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              className="border-input bg-background focus-visible:border-foreground/25 h-9 w-full rounded-lg border px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
            >
              <option value="">不关联应用</option>
              {apps.map((app) => (
                <option key={app.appId} value={app.appId}>
                  {app.name}（{app.appId}）
                </option>
              ))}
            </select>
            <p className="text-muted-foreground/70 text-[11px]">
              {selectedApp?.repoUrl ? `将关联仓库 ${selectedApp.repoUrl}` : "不关联应用时进入独立的需求对话"}
            </p>
          </div>

          {error && (
            <p
              role="alert"
              className="border-destructive/25 bg-destructive/[0.08] text-destructive rounded-lg border px-3 py-2 text-[12px] leading-relaxed break-all"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={!title.trim() || busy} className="gap-1.5">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            {busy ? "创建中…" : "创建并进入会话"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
