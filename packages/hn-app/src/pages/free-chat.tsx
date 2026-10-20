/**
 * 自由对话（React 版）。
 * 源：xybot-front-opencode-ui src/pages/free-chat/（FreeChatListPage + FreeChatSessionPage + ChatCore）。
 * - 无 StageBar 的纯会话：发送首条消息时 POST /session 自动创建
 * - 左侧会话列表（GET /session），右侧 timeline + composer；发送/停止复用 REST 管线
 * 高级功能（AgentConfigPanel / 子代理页 / rrweb 回放）见 MIGRATION.md。
 */
import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router"
import { MessageSquareText, PanelLeft, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SessionTimeline } from "@/components/session/session-timeline"
import { FilePreviewDialog } from "@/components/session/file-preview-dialog"
import { useSessionPanelCollapsed } from "@/hooks/use-session-panel"
import { ImageLightbox, type ImagePreviewTarget } from "@/components/session/image-lightbox"
import { Composer } from "@/components/prompt-input/composer"
import { useToast } from "@/components/toast"
import { ServerProvider, useSDK } from "@/context/sdk"
import { DataProvider, useData } from "@/context/data"
import { LocalProvider, useLocal } from "@/context/local"
import { PromptControllerProvider, usePromptController } from "@/context/prompt-store"
import { sendFollowupDraft, abortSession } from "@/components/prompt-input/submit"
import { withDraftText } from "@/components/prompt-input/draft-text"
import { useTurnPhase } from "@/hooks/use-turn-phase"
import { pickFirstModel, useProviderList } from "@/hooks/use-provider-list"
import { sessionSource, usingBaseServer, type ChatSession } from "@/lib/session-source"
import { useSessionBridge } from "@/hooks/use-session-bridge"

type SessionRow = {
  id: string
  title?: string
  time?: { created?: number; updated?: number }
  [key: string]: unknown
}

/** 会话时间：今天/昨天显示相对日，其余 MM-DD（同日会话不再全部显示同一日期） */
function formatDate(ts?: number) {
  if (!ts) return ""
  const d = new Date(ts)
  const now = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000)
  if (diffDays === 0) return "今天"
  if (diffDays === 1) return "昨天"
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * L2 会话列表项（上下文级）：选中用白卡——与 L1 的左指示条语言区分，
 * 靠底色深度（L1 muted/70 > L2 muted/30）而非相同卡片样式来体现层级。
 */
function cnSessionItem(active: boolean) {
  return cn(
    "group flex h-9 w-full items-center rounded-lg px-2.5 text-left transition-colors",
    active
      ? "bg-background text-foreground shadow-xs ring-1 ring-border"
      : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
  )
}

function SessionListPanel({ activeId, collapsed }: { activeId?: string; collapsed?: boolean }) {
  const { directory } = useSDK()
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [creating, setCreating] = useState(false)
  const toast = useToast()

  useEffect(() => {
    void sessionSource()
      .list()
      .then((list) => {
        setSessions(
          (list as SessionRow[]).sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0)),
        )
      })
      .catch(() => {})
  }, [directory, activeId])

  const create = async () => {
    setCreating(true)
    try {
      const created = await sessionSource().create({ directory: directory || undefined })
      if (created?.id) navigate(`/free-chat/session/${created.id}`)
    } catch (err) {
      toast({
        variant: "destructive",
        title: "创建会话失败",
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      className={cn(
        "bg-muted/30 flex shrink-0 flex-col overflow-hidden transition-[width] duration-200 ease-out",
        collapsed ? "w-0 border-r-0" : "w-60",
      )}
      aria-hidden={collapsed}
    >
      {/* 顶部与 L1 的 h-14 对齐，避免两条顶线错位 */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <span className="text-[13px] font-medium">会话</span>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground ml-auto h-7 gap-1 rounded-lg px-2 text-[12px]"
          onClick={() => void create()}
          disabled={creating}
        >
          <Plus className="size-3.5" />
          新建
        </Button>
      </div>
      {/* 原生滚动容器：Radix ScrollArea 的 viewport 是 display:table，宽度会被内容撑开，
          导致 truncate 失效（实测 296px > 列宽 240px） */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-2">
        <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
          {sessions.length === 0 && (
            <div className="text-muted-foreground/70 px-2.5 py-6 text-center text-xs">暂无会话</div>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              title={s.title ?? "未命名会话"}
              className={cnSessionItem(s.id === activeId)}
              onClick={() => navigate(`/free-chat/session/${s.id}`)}
            >
              <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">
                {s.title ?? "未命名会话"}
              </span>
              <span className="text-muted-foreground/70 shrink-0 text-[11px] leading-tight tabular-nums">
                {formatDate(s.time?.created)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function FreeChatCore({
  onTogglePanel,
  panelCollapsed = false,
}: {
  onTogglePanel?: () => void
  panelCollapsed?: boolean
}) {
  const { sessionId } = useParams()
  const { directory } = useSDK()
  const data = useData()
  const local = useLocal()
  const prompt = usePromptController()
  const [previewHref, setPreviewHref] = useState<string | undefined>(undefined)
  const [imageTarget, setImageTarget] = useState<ImagePreviewTarget>(undefined)
  const toast = useToast()

  const sid = sessionId ?? ""
  const messages = data.state.message[sid] ?? []
  const parts = data.state.part
  const status = data.state.session_status[sid] ?? { type: "idle" as const }
  const working = status.type !== "idle"

  useEffect(() => {
    if (sid) void data.loadMessages(sid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid])

  const { providers } = useProviderList()
  const modelRef = local.model.current() ?? pickFirstModel(providers)
  const agent = local.agent.current() ?? "build"

  const turnPhase = useTurnPhase({ working, messages, parts })

  const handleSubmit = async ({ text, clear }: { text: string; clear: () => void }) => {
    let targetSid = sid
    try {
      if (!targetSid) {
        const created: ChatSession = await sessionSource().create({ directory: directory || undefined })
        targetSid = created.id
      }
      if (!modelRef) {
        toast({ title: "缺少模型", description: "请先在下方选择模型" })
        return
      }
      prompt.set(withDraftText(prompt.current(), text))
      const source = sessionSource()
      await sendFollowupDraft({
        client: {
          promptAsync: (sid, body) => source.sendMessage(sid, body),
          command: () => {
            throw new Error("网关模式暂不支持会话命令，请直连或去掉命令前缀")
          },
        },
        data: {
          optimisticAdd: data.optimisticAdd,
          optimisticRemove: data.optimisticRemove,
          setSessionStatus: data.setSessionStatus,
        },
        draft: {
          sessionID: targetSid,
          sessionDirectory: directory || "",
          prompt: prompt.current(),
          context: prompt.context.items(),
          agent,
          model: modelRef,
        },
        optimisticBusy: true,
      })
      clear()
      if (targetSid !== sid) {
        window.location.hash = `#/free-chat/session/${targetSid}`
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "发送失败",
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <Card className="flex min-h-0 flex-1 flex-col border-0 py-0">
      <CardHeader className="h-14 flex-row items-center gap-2 border-b px-4">
        {onTogglePanel && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={panelCollapsed ? "展开会话列表" : "收起会话列表"}
            title={panelCollapsed ? "展开会话列表（⌘B）" : "收起会话列表（⌘B）"}
            onClick={onTogglePanel}
            className="text-muted-foreground hover:text-foreground -ml-1 size-8 shrink-0"
          >
            <PanelLeft className="size-4" />
          </Button>
        )}
        {/* 顶部只保留「toggle + 标题 + 运行态」：图标与 token 数属于噪音 */}
        <CardTitle className="flex items-center gap-2 text-sm">
          自由对话
          {working && <Badge variant="outline">{turnPhase.phaseLabel}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col p-0">
        <ScrollArea className="min-h-0 flex-1">
          <SessionTimeline
            messages={messages}
            parts={parts}
            working={working}
            phaseLabel={turnPhase.phaseLabel}
            onFileLink={setPreviewHref}
            onImagePreview={setImageTarget}
            className="min-h-full"
          />
          <FilePreviewDialog
            href={previewHref}
            directory={directory || undefined}
            sessionId={sid || undefined}
            onOpenChange={(open) => {
              if (!open) setPreviewHref(undefined)
            }}
          />
          <ImageLightbox target={imageTarget} onOpenChange={(open) => !open && setImageTarget(undefined)} />
          {!sid && messages.length === 0 && (
            <div className="flex flex-col items-center gap-2.5 py-20 text-center">
              <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-xl">
                <MessageSquareText className="size-5" />
              </div>
              <p className="text-sm font-medium">开始一段新对话</p>
              <p className="text-muted-foreground text-xs">发送第一条消息时会自动创建会话</p>
            </div>
          )}
        </ScrollArea>
        <Composer
          sessionId={sid || undefined}
          directory={directory || undefined}
          working={working}
          agent={agent}
          onAgentChange={(a) => local.agent.set(a)}
          model={modelRef}
          onModelChange={(m) => local.model.set(m)}
          onAbort={() => {
            const source = sessionSource()
            if (usingBaseServer()) void source.abort(sid)
            else void abortSession(sid, { directory: directory || undefined })
          }}
          onSubmit={handleSubmit}
          prompt={prompt}
        />
      </CardContent>
    </Card>
  )
}

/** 路由入口：/free-chat 与 /free-chat/session/:sessionId 共用 */
export function FreeChatPage() {
  const { dir, sessionId } = useParams()
  const { collapsed: panelCollapsed, toggle: togglePanel } = useSessionPanelCollapsed()

  // 网关模式：事件流与消息加载走 hn-base-server（单会话 SSE + 归属校验）
  const bridge = useSessionBridge(sessionId)

  return (
    <ServerProvider directory={dir}>
      <DataProvider bridge={bridge}>
        <div className="flex h-full">
          {/* 无 p-4：让主区与 L2 贴边、顶部与 L1 对齐，横线才能连成一条 */}
          <SessionListPanel activeId={sessionId} collapsed={panelCollapsed} />
          <div className="flex min-w-0 flex-1 flex-col">
            <FreeChatCore onTogglePanel={togglePanel} panelCollapsed={panelCollapsed} />
          </div>
        </div>
      </DataProvider>
    </ServerProvider>
  )
}
