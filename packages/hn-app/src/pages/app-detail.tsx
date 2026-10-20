/**
 * 应用工作台（布局参考控制台：左侧会话历史 + 主区「一句话完成需求开发」输入框）。
 * 设置（概览 / Git 仓库 / 删除）放在第二个 Tab，避免与工作流混在一起。
 *
 * 从应用列表进入时新开标签页；提交需求后创建「需求 + 会话」并跳转需求对话。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import {
  AlertCircle,
  Boxes,
  Check,
  ExternalLink,
  GitBranch,
  Loader2,
  MessageSquarePlus,
  PanelLeft,
  RefreshCw,
  Send,
  Settings,
  Sparkles,
  ChevronDown,
  LayoutGrid,
  Plug,
  Trash2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SessionTimeline } from "@/components/session/session-timeline"
import { Composer } from "@/components/prompt-input/composer"
import { sendFollowupDraft } from "@/components/prompt-input/submit"
import { withDraftText } from "@/components/prompt-input/draft-text"
import { ServerProvider } from "@/context/sdk"
import { DataProvider, useData } from "@/context/data"
import { PromptControllerProvider, usePromptController } from "@/context/prompt-store"
import { useSessionBridge } from "@/hooks/use-session-bridge"
import { useTurnPhase } from "@/hooks/use-turn-phase"
import { TooltipProvider } from "@/components/ui/tooltip"
import { UserMenu } from "@/components/user-menu"
import { AlertNotice } from "@/components/settings/settings-ui"
import { useToast } from "@/components/toast"
import { LocalProvider, useLocal } from "@/context/local"
import { pickFirstModel, useProviderList } from "@/hooks/use-provider-list"
import { hnApi, type HnApp, type HnGitBranch } from "@/lib/base-api"
import { sessionSource, usingBaseServer } from "@/lib/session-source"
import { cn } from "@/lib/utils"
import { requirementStatus } from "@/lib/requirement-status"
import { selectAppRequirements, type AppRequirement } from "@/lib/app-requirements"
import { AppRequirements } from "@/components/app-requirements"
import { AppHarness } from "@/components/app-harness"

function formatDate(ts?: number): string {
  if (!ts) return "—"
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function repoPathOf(repoUrl: string): string {
  try {
    return new URL(repoUrl).pathname.replace(/^\/+/, "").replace(/\.git$/, "")
  } catch {
    return repoUrl.replace(/^[a-z]+:\/\/[^/]+\//i, "").replace(/\.git$/, "")
  }
}

function StatusBadge({ status }: { status: HnApp["status"] }) {
  if (status === "ready") {
    return (
      <Badge variant="outline" className="gap-1 text-[10px]">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        已就绪
      </Badge>
    )
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="border-destructive/30 text-destructive gap-1 text-[10px]">
        <AlertCircle className="size-2.5" />
        初始化失败
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-muted-foreground gap-1 text-[10px]">
      <Loader2 className="size-2.5 animate-spin" />
      初始化中
    </Badge>
  )
}

export function AppDetailPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const sessionId = searchParams.get("session") ?? undefined
  const bridge = useSessionBridge(sessionId)

  const setSessionId = useCallback(
    (id?: string) => {
      const next = new URLSearchParams(searchParams)
      if (id) next.set("session", id)
      else next.delete("session")
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  return (
    <ServerProvider directory="/workspace">
      <DataProvider bridge={bridge}>
        <PromptControllerProvider>
          <LocalProvider>
            <AppWorkbench sessionId={sessionId} setSessionId={setSessionId} />
          </LocalProvider>
        </PromptControllerProvider>
      </DataProvider>
    </ServerProvider>
  )
}

function AppWorkbench({
  sessionId,
  setSessionId,
}: {
  sessionId?: string
  setSessionId: (id?: string) => void
}) {
  const { appId = "" } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const local = useLocal()
  const { providers } = useProviderList()
  const enabled = usingBaseServer()

  const [app, setApp] = useState<HnApp | null>(null)
  const [requirements, setRequirements] = useState<AppRequirement[]>([])
  const [branches, setBranches] = useState<HnGitBranch[]>([])
  const [gitConnections, setGitConnections] = useState<{ id: string; displayName: string; status: string }[]>([])
  const [gitConnectionId, setGitConnectionId] = useState("")
  const [savingGitConnection, setSavingGitConnection] = useState(false)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState("")
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [tab, setTab] = useState("workspace")
  const recentRequirements = useMemo(() => selectAppRequirements(requirements, "", 10), [requirements])
  const openNewRequirement = () => {
    setTab("workspace")
    setSessionId(undefined)
    setText("")
    setPendingPrompt(null)
    setTimeout(() => document.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 0)
  }
  const [panelCollapsed, setPanelCollapsed] = useState(
    () => localStorage.getItem("hn_app_panel_collapsed") === "1",
  )

  useEffect(() => {
    localStorage.setItem("hn_app_panel_collapsed", panelCollapsed ? "1" : "0")
  }, [panelCollapsed])

  // ⌘B / Ctrl+B 收起展开（输入框内不拦截）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "b") return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return
      event.preventDefault()
      setPanelCollapsed((value) => !value)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const savedModel = local.model.current()
  const modelRef = savedModel && providers?.all.some((provider) => provider.id === savedModel.providerID && provider.models[savedModel.modelID]) ? savedModel : pickFirstModel(providers)
  const [selectedBranch, setSelectedBranch] = useState("")
  const [branchOpen, setBranchOpen] = useState(false)
  const [newBranchOpen, setNewBranchOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState("")
  const [branchBusy, setBranchBusy] = useState(false)
  const [composerFocused, setComposerFocused] = useState(false)
  /** 创建需求后待自动发送的需求原文（编排完成后由会话面板提交给 agent） */
  const [pendingPrompt, setPendingPrompt] = useState<{ sessionId: string; text: string } | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const branch = selectedBranch || app?.defaultBranch || "main"

  useEffect(() => {
    if (tab !== "settings") return
    void hnApi.gitProviders().then((res) => setGitConnections(res.items ?? [])).catch((error) => {
      toast({ variant: "destructive", title: "读取 Git 服务失败", description: error instanceof Error ? error.message : String(error) })
    })
  }, [tab])

  const saveGitConnection = async () => {
    if (!app || !gitConnectionId || savingGitConnection) return
    setSavingGitConnection(true)
    try {
      const updated = await hnApi.updateAppGitProvider(app.appId, gitConnectionId)
      setApp(updated)
      setGitConnectionId("")
      toast({ title: "Git 服务已更新", description: "仓库、需求和会话保持不变" })
    } catch (error) {
      toast({ variant: "destructive", title: "切换 Git 服务失败", description: error instanceof Error ? error.message : String(error) })
    } finally {
      setSavingGitConnection(false)
    }
  }

  const load = useCallback(async () => {
    if (!enabled || !appId) return
    setLoading(true)
    setError("")
    try {
      const [appData, requirementData] = await Promise.all([
        hnApi.app(appId),
        hnApi.appRequirements(appId),
      ])
      setApp(appData)
      setRequirements(requirementData.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [enabled, appId])

  useEffect(() => {
    void load()
  }, [load])

  // 分支：来自 Git provider 授权
  useEffect(() => {
    if (!app?.gitProviderInstanceId || !app.repoUrl) return
    const repo = repoPathOf(app.repoUrl)
    if (!repo.includes("/")) return
    void hnApi
      .gitBranches(app.gitProviderInstanceId, repo)
      .then((res) => {
        setBranches(res.items ?? [])
        setSelectedBranch((prev) => prev || app.defaultBranch || res.items?.[0]?.name || "main")
      })
      .catch(() => setBranches([]))
  }, [app?.gitProviderInstanceId, app?.repoUrl])

  const modelOptions = useMemo(() => {
    const out: Array<{ value: string; label: string }> = []
    for (const provider of providers?.all ?? []) {
      if (providers?.connected && !providers.connected.includes(provider.id)) continue
      for (const model of Object.values(provider.models ?? {})) {
        out.push({ value: `${provider.id}/${model.id}`, label: `${provider.name ?? provider.id} · ${model.name ?? model.id}` })
      }
    }
    return out.slice(0, 50)
  }, [providers])

  /** 把模板标题插入到光标处 */
  const insertTemplate = (label: string) => {
    const el = composerRef.current
    const snippet = `## ${label}\n`
    if (!el) {
      setText((prev) => prev + snippet)
      return
    }
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    const next = text.slice(0, start) + snippet + text.slice(end)
    setText(next)
    requestAnimationFrame(() => {
      el.focus()
      el.selectionStart = el.selectionEnd = start + snippet.length
    })
  }

  // textarea 随内容增高（上限 200px）
  useEffect(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const createBranch = async () => {
    const name = newBranchName.trim()
    if (!name || !app?.gitProviderInstanceId || !app.repoUrl || branchBusy) return
    setBranchBusy(true)
    try {
      await hnApi.createGitBranch(app.gitProviderInstanceId, {
        repo: repoPathOf(app.repoUrl),
        name,
        from: branch,
      })
      const res = await hnApi.gitBranches(app.gitProviderInstanceId, repoPathOf(app.repoUrl))
      setBranches(res.items ?? [])
      setSelectedBranch(name)
      setNewBranchOpen(false)
      setNewBranchName("")
      setBranchOpen(false)
      toast({ title: "分支已创建", description: `${name}（基于 ${branch}）` })
    } catch (err) {
      toast({
        variant: "destructive",
        title: "创建分支失败",
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBranchBusy(false)
    }
  }

  const submit = async () => {
    const content = text.trim()
    if (!content || sending || !app) return
    if (!modelRef) {
      toast({ title: "缺少模型", description: "请先选择模型" })
      return
    }
    setSending(true)
    try {
      const prepared = await hnApi.prepareRequirement({
        title: content.slice(0, 120),
        appId: app.appId,
        ...(app.gitProviderInstanceId ? { gitProviderId: app.gitProviderInstanceId } : {}),
        ...(app.repoUrl ? { repoUrl: app.repoUrl } : {}),
        baseBranch: app.defaultBranch || "main",
        workBranch: branch,
        directory: "/workspace",
      })
      setText("")
      setTab("workspace")
      setSessionId(prepared.sessionId)
      // 需求创建成功后立即让 agent 开始开发：会话面板挂载后自动发送这段需求
      setPendingPrompt(prepared.prepareError ? null : { sessionId: prepared.sessionId, text: content })
      if (prepared.prepareError) {
        toast({
          variant: "destructive",
          title: "仓库准备失败",
          description: `${prepared.prepareError}（已暂停自动执行，请先修复工作区准备问题）`,
        })
      }
      // 刷新会话历史
      void hnApi.appRequirements(app.appId).then((res) => setRequirements(res.items ?? [])).catch(() => {})
    } catch (err) {
      toast({
        variant: "destructive",
        title: "创建需求失败",
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setSending(false)
    }
  }

  const remove = async () => {
    if (!app || deleting) return
    setDeleting(true)
    try {
      await hnApi.deleteApp(app.appId)
      toast({ title: "应用已删除", description: app.name })
      navigate("/apps", { replace: true })
    } catch (err) {
      toast({
        variant: "destructive",
        title: "删除失败",
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDeleting(false)
    }
  }

  if (!enabled) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-8 py-10">
          <AlertNotice tone="warn" icon={<AlertCircle className="size-4" />}>
            未启用网关模式（<code className="text-[11px]">VITE_HN_BASE_URL</code>），应用工作台不可用。
          </AlertNotice>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" /> 读取应用…
      </div>
    )
  }

  if (error || !app) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertCircle className="size-5 text-amber-500" />
        <p className="text-muted-foreground text-sm">{error || "应用不存在"}</p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => void load()} className="gap-1.5">
            <RefreshCw className="size-3.5" /> 重试
          </Button>
          <Link to="/apps">
            <Button size="sm" variant="ghost">
              返回应用列表
            </Button>
          </Link>
        </div>
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="bg-background flex h-dvh overflow-hidden">
      {/* 独立侧栏：应用菜单（不复用 L1 图标栏） */}
      <aside
        aria-hidden={panelCollapsed}
        className={cn(
          "bg-muted/30 flex shrink-0 flex-col overflow-hidden border-r transition-[width] duration-200 ease-out",
          panelCollapsed ? "w-0 border-r-0" : "w-60",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
          <span className="bg-foreground text-background flex size-6 shrink-0 items-center justify-center rounded-md">
            <Boxes className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{app.name}</span>
          <StatusBadge status={app.status} />
        </div>

        <div className="p-2">
          <Button
            size="sm"
            onClick={openNewRequirement}
            className="w-full gap-1.5"
          >
            <MessageSquarePlus className="size-3.5" />
            新对话
          </Button>
        </div>

        <div className="text-muted-foreground/70 px-3 pb-1 text-[11px] font-medium tracking-wide uppercase">
          管理
        </div>
        <nav className="flex flex-col gap-0.5 px-2 pb-2">
          <SidebarLink icon={<LayoutGrid className="size-3.5" />} label="需求管理" active={tab === "requirements"} onClick={() => setTab("requirements")} />
          <SidebarLink icon={<Plug className="size-3.5" />} label="Harness 管理" onClick={() => setTab("harness")} />
          <SidebarLink
            icon={<Settings className="size-3.5" />}
            label="应用设置"
            active={tab === "settings"}
            onClick={() => setTab("settings")}
          />
        </nav>

        <div className="text-muted-foreground/70 border-t px-3 pb-1 pt-2 text-[11px] font-medium tracking-wide uppercase">
          最近需求
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="最近 10 个需求">
          {requirements.length === 0 ? (
            <p className="text-muted-foreground/70 px-2 py-4 text-[11px]">还没有需求</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {recentRequirements.map((item) => {
                const meta = requirementStatus(item.status)
                const active = tab === "workspace" && Boolean(item.sessionId) && item.sessionId === sessionId
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={!item.sessionId}
                    onClick={() => {
                      if (!item.sessionId) return
                      setTab("workspace")
                      setSessionId(item.sessionId)
                    }}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors disabled:cursor-default",
                      active
                        ? "bg-background text-foreground shadow-xs ring-1 ring-border"
                        : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                    )}
                    title={`${item.title}（${meta.label}）`}
                  >
                    <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", meta.dot)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px]">{item.title || "未命名需求"}</span>
                      <span className="text-muted-foreground/60 mt-0.5 flex items-center gap-1 text-[10px]">
                        <span>{meta.label}</span>
                        {item.kind && <span>· {item.kind === "bugfix" ? "Bugfix" : "常规"}</span>}
                        {!item.sessionId && <span>· 无会话</span>}
                      </span>
                    </span>
                    <span className="shrink-0 pt-0.5 text-[10px] tabular-nums">{formatDate(item.timeUpdated)}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <UserMenu layout="horizontal" />
      </aside>

      {/* 右侧：工作台 / 设置 */}
      <main className="bg-background flex min-w-0 flex-1 flex-col">
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                aria-label={panelCollapsed ? "展开菜单" : "收起菜单"}
                title={panelCollapsed ? "展开菜单（⌘B）" : "收起菜单（⌘B）"}
                onClick={() => setPanelCollapsed((value) => !value)}
                className="text-muted-foreground hover:text-foreground -ml-1 size-8 shrink-0"
              >
                <PanelLeft className="size-4" />
              </Button>
              <TabsList className="h-8">
              <TabsTrigger value="workspace" className="text-[12px]">
                工作台
              </TabsTrigger>
               <TabsTrigger value="requirements" className="text-[12px]">需求管理</TabsTrigger>
               <TabsTrigger value="harness" className="text-[12px]">Harness 管理</TabsTrigger>
              <TabsTrigger value="settings" className="text-[12px]">
                设置
              </TabsTrigger>
              </TabsList>
            </div>
            {app.repoUrl && (
              <a href={app.repoUrl} target="_blank" rel="noreferrer">
                <Button variant="ghost" size="sm" className="text-muted-foreground gap-1.5 text-[12px]">
                  <ExternalLink className="size-3.5" />
                  打开仓库
                </Button>
              </a>
            )}
          </div>

          <TabsContent value="requirements" className="min-h-0 flex-1 overflow-y-auto">
            <AppRequirements items={requirements} onCreate={openNewRequirement} onOpen={(id) => { setTab("workspace"); setSessionId(id) }} />
          </TabsContent>
          <TabsContent value="harness" className="min-h-0 flex-1 overflow-y-auto">
            <AppHarness appId={app.appId} />
          </TabsContent>
          <TabsContent value="workspace" className="flex min-h-0 flex-1 flex-col">
            {sessionId ? (
              <SessionPane
                sessionId={sessionId}
                title={requirements.find((x) => x.sessionId === sessionId)?.title}
                initialPrompt={pendingPrompt?.sessionId === sessionId ? pendingPrompt.text : undefined}
                onInitialPromptSent={() => setPendingPrompt(null)}
                onNew={() => {
                  setSessionId(undefined)
                  setText("")
                  setPendingPrompt(null)
                }}
              />
            ) : (
              <>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
              <div className="w-full max-w-2xl">
                <div className="mb-8 text-center">
                  <span className="text-muted-foreground/80 mb-3 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] tracking-wide">
                    <Sparkles className="size-2.5" />
                    新需求
                  </span>
                  <h2 className="text-[24px] leading-tight font-semibold tracking-tight">一句话完成需求开发</h2>
                  <p className="text-muted-foreground mt-2 text-[13px]">
                    {app.name} · <span className="font-mono">{branch}</span> · 提交后自动创建需求与会话
                  </p>
                </div>

                <div
                  className={cn(
                    "bg-background overflow-hidden rounded-2xl border transition-[box-shadow,border-color] duration-150",
                    composerFocused
                      ? "border-foreground/25 ring-2 ring-foreground/[0.04] shadow-[0_10px_32px_-16px_rgba(0,0,0,0.24)]"
                      : "shadow-xs hover:border-foreground/15",
                  )}
                >
                  <textarea
                    ref={composerRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onFocus={() => setComposerFocused(true)}
                    onBlur={() => setComposerFocused(false)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        void submit()
                      }
                      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                        e.preventDefault()
                        void submit()
                      }
                    }}
                    rows={3}
                    placeholder="描述需求目标、功能与验收标准…"
                    className="placeholder:text-muted-foreground/50 block min-h-[96px] w-full resize-none bg-transparent px-4 pt-4 text-[13.5px] leading-relaxed outline-none"
                  />

                  <div className="flex items-center gap-2 border-t px-2.5 py-2">
                    <div className="flex min-w-0 items-center gap-0.5">
                      {["需求目标", "功能描述", "验收标准"].map((label) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => insertTemplate(label)}
                          className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md px-2 py-1 text-[11px] transition-colors"
                          title={`插入「${label}」模板`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    <div className="ml-auto flex shrink-0 items-center gap-1.5">
                      <select
                        value={modelRef ? `${modelRef.providerID}/${modelRef.modelID}` : ""}
                        onChange={(e) => {
                          const [providerID, modelID] = e.target.value.split("/")
                          if (providerID && modelID) local.model.set({ providerID, modelID })
                        }}
                        className="text-muted-foreground hover:text-foreground h-7 max-w-[180px] cursor-pointer rounded-md border bg-background px-2 text-[11px] outline-none"
                        aria-label="模型"
                      >
                        {!modelRef && <option value="">选择模型</option>}
                        {modelOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>

                      <Popover open={branchOpen} onOpenChange={setBranchOpen}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            disabled={!app.repoUrl || !app.gitProviderInstanceId}
                            className="text-muted-foreground hover:text-foreground flex h-7 max-w-[160px] items-center gap-1 rounded-md border bg-background px-2 text-[11px] disabled:cursor-not-allowed disabled:opacity-45"
                            title="选择或创建分支"
                          >
                            <GitBranch className="size-3 shrink-0" />
                            <span className="truncate font-mono">{branch}</span>
                            <ChevronDown className="size-3 shrink-0 opacity-60" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-64 p-1">
                          <div className="max-h-56 overflow-y-auto">
                            {branches.length === 0 ? (
                              <p className="text-muted-foreground px-2 py-3 text-center text-[11px]">暂无分支</p>
                            ) : (
                              branches.map((item) => (
                                <button
                                  key={item.name}
                                  type="button"
                                  onClick={() => {
                                    setSelectedBranch(item.name)
                                    setBranchOpen(false)
                                  }}
                                  className={cn(
                                    "hover:bg-muted flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px]",
                                    item.name === branch && "bg-muted font-medium",
                                  )}
                                >
                                  <GitBranch className="text-muted-foreground size-3 shrink-0" />
                                  <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>
                                  {item.isDefault && (
                                    <span className="text-muted-foreground/70 text-[10px]">默认</span>
                                  )}
                                </button>
                              ))
                            )}
                          </div>

                          <div className="mt-1 border-t pt-1">
                            {newBranchOpen ? (
                              <div className="flex items-center gap-1 p-1">
                                <Input
                                  value={newBranchName}
                                  onChange={(e) => setNewBranchName(e.target.value)}
                                  placeholder="feature/xxx"
                                  className="h-7 flex-1 font-mono text-[11px]"
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault()
                                      void createBranch()
                                    }
                                  }}
                                />
                                <Button
                                  size="sm"
                                  onClick={() => void createBranch()}
                                  disabled={!newBranchName.trim() || branchBusy}
                                  className="h-7 shrink-0 px-2 text-[11px]"
                                >
                                  {branchBusy ? <Loader2 className="size-3 animate-spin" /> : "创建"}
                                </Button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setNewBranchOpen(true)}
                                className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 rounded-sm px-2 py-1.5 text-left text-[12px]"
                              >
                                <span className="text-[13px] leading-none">+</span>
                                新建分支（基于 {branch}）
                              </button>
                            )}
                          </div>
                        </PopoverContent>
                      </Popover>

                      <Button
                        size="icon"
                        onClick={() => void submit()}
                        disabled={!text.trim() || sending}
                        aria-label="发送"
                        title="发送（Enter）"
                        className={cn(
                          "size-7 rounded-md transition-colors",
                          text.trim()
                            ? "bg-foreground text-background hover:bg-foreground/90"
                            : "border bg-background text-muted-foreground/45",
                        )}
                      >
                        {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                      </Button>
                    </div>
                  </div>
                </div>

                <p className="text-muted-foreground/50 mt-3 text-center text-[11px]">
                  Enter 发送 · Shift + Enter 换行
                </p>
              </div>
            </div>
              </>
            )}
          </TabsContent>

          <TabsContent value="settings" className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-6 py-6">
              <section className="mb-5 overflow-hidden rounded-xl border">
                <div className="border-b px-4 py-3">
                  <h3 className="text-[13px] font-semibold">概览</h3>
                </div>
                <dl className="divide-y">
                  <Row label="应用 ID" value={app.appId} mono />
                  <Row label="域名" value={app.domain || "—"} />
                  <Row label="类型" value={app.type === "frontend" ? "前端应用" : app.type} />
                  <Row label="技术栈" value={app.techStack} mono />
                  <Row label="默认分支" value={app.defaultBranch} mono />
                  <Row label="创建时间" value={new Date(app.timeCreated).toLocaleString("zh-CN", { hour12: false })} />
                </dl>
              </section>

              <section className="mb-5 overflow-hidden rounded-xl border">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
                    <GitBranch className="size-3.5" /> Git 仓库
                  </h3>
                  {branches.length > 0 && (
                    <span className="text-muted-foreground text-[11px]">{branches.length} 个分支</span>
                  )}
                </div>
                <div className="space-y-3 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <label htmlFor="app-git-service" className="text-muted-foreground shrink-0 text-[12px]">Git 服务</label>
                    <select id="app-git-service" value={gitConnectionId || app.gitProviderInstanceId || ""} onChange={(event) => setGitConnectionId(event.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2 text-[12px]">
                      {!gitConnections.some((item) => item.id === app.gitProviderInstanceId) && <option value={app.gitProviderInstanceId || ""}>原连接不可用，请选择新授权</option>}
                      {gitConnections.map((item) => <option key={item.id} value={item.id} disabled={item.status !== "active"}>{item.displayName}{item.status !== "active" ? "（凭据失效）" : ""}</option>)}
                    </select>
                    <Button size="sm" disabled={!gitConnectionId || gitConnectionId === app.gitProviderInstanceId || savingGitConnection} onClick={() => void saveGitConnection()}>{savingGitConnection ? "保存中…" : "保存"}</Button>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground text-[12px]">仓库地址</span>
                    {app.repoUrl ? (
                      <a
                        href={app.repoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-foreground min-w-0 truncate font-mono text-[12px] underline-offset-4 hover:underline"
                      >
                        {repoPathOf(app.repoUrl)}
                      </a>
                    ) : (
                      <span className="text-muted-foreground text-[12px]">—</span>
                    )}
                  </div>
                  {branches.length === 0 ? (
                    <p className="text-muted-foreground text-[12px]">暂无分支信息</p>
                  ) : (
                    <div className="space-y-1">
                      {branches.map((item) => (
                        <div key={item.name} className="flex items-center gap-2 text-[12px]">
                          <GitBranch className="text-muted-foreground size-3 shrink-0" />
                          <span className="truncate font-mono">{item.name}</span>
                          {item.isDefault && (
                            <Badge variant="outline" className="shrink-0 text-[10px]">
                              默认
                            </Badge>
                          )}
                          {item.lastCommit?.shortId && (
                            <span className="text-muted-foreground/70 ml-auto shrink-0 font-mono text-[10px]">
                              {item.lastCommit.shortId}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <section className="border-destructive/25 overflow-hidden rounded-xl border">
                <div className="border-destructive/20 bg-destructive/[0.04] border-b px-4 py-3">
                  <h3 className="text-destructive text-[13px] font-semibold">危险操作</h3>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <p className="text-muted-foreground text-[12px]">
                    删除应用会移除归属关系；Git 仓库本身不会被删除。
                  </p>
                  <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)} className="gap-1.5">
                    <Trash2 className="size-3.5" />
                    删除应用
                  </Button>
                </div>
              </section>
            </div>
          </TabsContent>
        </Tabs>

        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>删除「{app.name}」？</DialogTitle>
              <DialogDescription>
                仅删除应用记录与归属关系，不会删除 Git 仓库或代码。此操作不可撤销。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
                取消
              </Button>
              <Button variant="destructive" onClick={() => void remove()} disabled={deleting} className="gap-1.5">
                {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>
      </div>
    </TooltipProvider>
  )
}

/** 工作台内嵌会话视图（不复用需求对话页） */
function SessionPane({
  sessionId,
  title,
  initialPrompt,
  onInitialPromptSent,
  onNew,
}: {
  sessionId: string
  title?: string
  /** 创建需求后自动发送的原文（只发送一次） */
  initialPrompt?: string
  onInitialPromptSent?: () => void
  onNew: () => void
}) {
  const data = useData()
  const local = useLocal()
  const prompt = usePromptController()
  const { providers } = useProviderList()
  const toast = useToast()

  // 数据层已过滤系统编排消息（msg_prepare_*），这里保持原样消费
  const messages = data.state.message[sessionId] ?? []
  const parts = data.state.part
  const status = data.state.session_status[sessionId] ?? { type: "idle" as const }
  const working = status.type !== "idle"
  const savedModel = local.model.current()
  const modelRef = savedModel && providers?.all.some((provider) => provider.id === savedModel.providerID && provider.models[savedModel.modelID]) ? savedModel : pickFirstModel(providers)
  const agent = "build"
  const turnPhase = useTurnPhase({ working, messages, parts })
  const executionError = data.state.session_error[sessionId]

  useEffect(() => {
    void data.loadMessages(sessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const handleSubmit = async ({ text, clear }: { text: string; clear: () => void }) => {
    if (!modelRef) {
      toast({ title: "缺少模型", description: "请先选择模型" })
      return
    }
    prompt.set(withDraftText(prompt.current(), text))
    try {
      const source = sessionSource()
      await sendFollowupDraft({
        client: {
          promptAsync: (sid, body) => source.sendMessage(sid, body),
          command: () => {
            throw new Error("工作台暂不支持会话命令")
          },
        },
        data: {
          optimisticAdd: data.optimisticAdd,
          optimisticRemove: data.optimisticRemove,
          setSessionStatus: data.setSessionStatus,
        },
        draft: {
          sessionID: sessionId,
          sessionDirectory: "/workspace",
          prompt: prompt.current(),
          context: prompt.context.items(),
          agent,
          model: modelRef,
        },
        optimisticBusy: true,
      })
      clear()
    } catch (err) {
      toast({
        variant: "destructive",
        title: "发送失败",
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 创建需求后自动开始执行：等模型就绪后发送一次需求原文
  const sentInitialRef = useRef<string | null>(null)
  useEffect(() => {
    if (!initialPrompt || !modelRef) return
    if (sentInitialRef.current === sessionId) return
    sentInitialRef.current = sessionId
    prompt.reset()
    void handleSubmit({ text: initialPrompt, clear: () => prompt.reset() }).finally(() => {
      onInitialPromptSent?.()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt, modelRef, sessionId])

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{title || "会话"}</span>
        {working && <Badge variant="outline">{turnPhase.phaseLabel}</Badge>}
        <Button variant="ghost" size="sm" onClick={onNew} className="text-muted-foreground h-7 text-[11px]">
          新对话
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {executionError != null && <div role="alert" className="mx-4 mt-4 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">执行失败：{typeof executionError === "object" && "message" in executionError ? String(executionError.message) : String(executionError)}</div>}
        <SessionTimeline
          messages={messages}
          parts={parts}
          working={working}
          phaseLabel={turnPhase.phaseLabel}
          className="min-h-full"
        />
      </ScrollArea>

      <Composer
        sessionId={sessionId}
        directory="/workspace"
        working={working}
        agent={agent}
        onAgentChange={() => undefined}
        model={modelRef}
        onModelChange={(m) => local.model.set(m)}
        onAbort={() => void sessionSource().abort(sessionId)}
        onSubmit={handleSubmit}
        prompt={prompt}
      />
    </>
  )
}

/** 侧栏菜单项（工作台独立菜单） */
function SidebarLink({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] transition-colors",
        active
          ? "bg-background text-foreground shadow-xs ring-1 ring-border"
          : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <dt className="text-muted-foreground shrink-0 text-[12px]">{label}</dt>
      <dd className={cn("min-w-0 truncate text-[12px]", mono && "font-mono")}>{value}</dd>
    </div>
  )
}
