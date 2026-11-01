/**
 * 自由对话（React 版）。
 * 源：xybot-front-opencode-ui src/pages/free-chat/（FreeChatListPage + FreeChatSessionPage + ChatCore）。
 * - 无 StageBar 的纯会话：发送首条消息时 POST /session 自动创建
 * - 左侧会话列表（GET /session），右侧 timeline + composer；发送/停止复用 REST 管线
 * 高级功能（AgentConfigPanel / 子代理页 / rrweb 回放）见 MIGRATION.md。
 */
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react"
import { useNavigate, useParams } from "react-router"
import { PanelLeft, Plus, Layers3, X } from "lucide-react"
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
import { ContextDialog, LazySessionInsights } from "@/components/context-insights/entry"
import { readPreferences } from "@/components/context-insights/model"
import { SessionForms } from "@/features/session/forms"
import { groupSessions, type SessionRow } from "@/features/session/session-groups"

function SessionListPanel({ activeId, collapsed, onSelect }: { activeId?: string; collapsed?: boolean; onSelect?: () => void }) {
  const { directory } = useSDK()
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [creating, setCreating] = useState(false)
  const toast = useToast()

  useEffect(() => {
    void sessionSource()
      .list()
      .then((list) => setSessions(list as SessionRow[]))
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
    <aside
      className={cn(
        "chat-sessions bg-muted/30 flex shrink-0 flex-col overflow-hidden transition-[width] duration-200 ease-out",
        collapsed ? "w-0 border-r-0" : "w-60",
      )}
      aria-hidden={collapsed}
      inert={collapsed}
      aria-label="会话列表"
    >
      <div className="chat-sessions-header">
        <button type="button" className="chat-sessions-close" aria-label="关闭会话列表" onClick={onSelect}><X className="size-4" /></button>
        <div className="chat-workspace-label"><span className="chat-ai-mark" aria-hidden />OpenCode<span>工作空间</span></div>
        <h2>会话</h2>
        <Button
          variant="secondary"
          size="sm"
          className="chat-new-session"
          onClick={() => void create()}
          disabled={creating}
        >
          <Plus className="size-3.5" />
          {creating ? "正在创建…" : "新建对话"}
        </Button>
      </div>
      {/* 原生滚动容器：Radix ScrollArea 的 viewport 是 display:table，宽度会被内容撑开，
          导致 truncate 失效（实测 296px > 列宽 240px） */}
      <div className="chat-session-list min-h-0 min-w-0 flex-1 overflow-y-auto px-2.5">
        {sessions.length === 0 && (
          <div className="text-muted-foreground/70 px-2.5 py-6 text-center text-xs">暂无会话</div>
        )}
        {groupSessions(sessions).map((group) => (
          <section key={group.label} aria-label={group.label} className="chat-session-group">
            <h3 className="chat-list-label">{group.label}</h3>
            <div className="flex min-w-0 flex-col gap-0.5">
              {group.sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  title={s.title ?? "未命名会话"}
                  aria-current={s.id === activeId ? "page" : undefined}
                  className="chat-session-item flex min-w-0 w-full items-center text-left transition-colors"
                  onClick={() => {
                    navigate(`/free-chat/session/${s.id}`)
                    if (window.matchMedia("(max-width: 767px)").matches) onSelect?.()
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">{s.title ?? "未命名会话"}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </aside>
  )
}

export function FreeChatCore({
  onTogglePanel,
  panelCollapsed = false,
  title = "自由对话",
  headerActions,
}: {
  onTogglePanel?: () => void
  panelCollapsed?: boolean
  title?: string
  headerActions?: ReactNode
}) {
  const { sessionId } = useParams()
  const { directory } = useSDK()
  const data = useData()
  const local = useLocal()
  const prompt = usePromptController()
  const [previewHref, setPreviewHref] = useState<string | undefined>(undefined)
  const [imageTarget, setImageTarget] = useState<ImagePreviewTarget>(undefined)
  const [contextOpen, setContextOpen] = useState(false)
  const [contextDock, setContextDock] = useState(false)
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
  // 本地保存的选择可能指向已下线的 provider/模型（换配置、换环境后常见）：
  // 只有它在当前可用列表里才采用，否则回退到第一个可用模型，避免发一个必然失败的请求。
  const stored = local.model.current()
  // 列表未加载完成时不要先信任缓存的选择：那会用一个可能已失效的模型发出请求。
  const storedUsable = stored !== undefined && providers !== null &&
    providers.all.find((item) => item.id === stored.providerID)?.models[stored.modelID] !== undefined
  const modelRef = storedUsable ? stored : pickFirstModel(providers)
  const agent = local.agent.current() ?? "build"

  const turnPhase = useTurnPhase({ working, messages, parts })

  const handleSubmit = async ({ text, clear }: { text: string; clear: () => void }) => {
    if (text.trim() === "/context") {
      if (sid) { setContextOpen(true); clear() }
      else toast({ title: "请先创建会话" })
      return
    }
    // 斜杠命令：V2 的 /api/command 提供目录，/api/session/:id/command 执行。
    const slash = /^\/([A-Za-z0-9._-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (slash) {
      if (!sid) {
        toast({ title: "请先创建会话" })
        return
      }
      try {
        const { commandList, sessionCommand } = await import("@/lib/rest")
        const commands = (await commandList({ directory: directory || undefined })).data ?? []
        if (commands.some((command) => command.name === slash[1])) {
          await sessionCommand(sid, { name: slash[1], arguments: slash[2] ?? "" }, { directory: directory || undefined })
          clear()
          return
        }
      } catch (err) {
        toast({ variant: "destructive", title: "命令执行失败", description: String(err) })
        return
      }
    }
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
    <Card className="chat-conversation flex min-h-0 flex-1 flex-col gap-0 border-0 py-0">
      <CardHeader className="chat-conversation-header h-14 flex-row items-center gap-2 border-b px-4">
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
        <CardTitle className="chat-conversation-title flex min-w-0 flex-1 items-center gap-2 text-sm">
          <span className="chat-header-mark chat-ai-mark" aria-hidden />
          <span className="min-w-0 truncate" title={title}>{title}</span>
          {working && <Badge variant="outline">{turnPhase.phaseLabel}</Badge>}
        </CardTitle>
        {headerActions}
        {sid && <Button size="sm" variant="ghost" className="chat-context-button ml-auto shrink-0 gap-1.5 text-xs" onClick={() => {
          // Wide screens dock the panel; narrow ones must use the dialog. The placement preference
          // only narrows that choice, it never forces a dock that cannot fit.
          const wide = window.matchMedia("(min-width: 1024px)").matches
          if (wide && readPreferences().placement === "dock") setContextDock((old) => !old)
          else setContextOpen(true)
        }}><Layers3 className="size-3.5" />上下文</Button>}
      </CardHeader>
      <CardContent className="flex min-h-0 min-w-0 flex-1 flex-row p-0">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ScrollArea className="chat-timeline-scroll min-h-0 flex-1">
          <SessionTimeline
            sessionId={sid || undefined}
            directory={directory || undefined}
            messages={messages}
            parts={parts}
            working={working}
            phaseLabel={turnPhase.phaseLabel}
            executionError={data.state.session_error[sid]}
            onFileLink={setPreviewHref}
            onImagePreview={setImageTarget}
            className="min-h-full"
          >
            {messages.length === 0 && !working && (
              <div className="chat-empty-state">
                <span className="chat-empty-mark chat-ai-mark" aria-hidden />
                <h1>今天，想完成什么？</h1>
              </div>
            )}
            {sid && (
              <SessionForms
                key={sid}
                sessionId={sid}
                active={working}
                load={sessionSource().forms}
                reply={sessionSource().reply}
              />
            )}
          </SessionTimeline>
          <FilePreviewDialog
            href={previewHref}
            directory={directory || undefined}
            sessionId={sid || undefined}
            onOpenChange={(open) => {
              if (!open) setPreviewHref(undefined)
            }}
          />
          <ImageLightbox target={imageTarget} onOpenChange={(open) => !open && setImageTarget(undefined)} />
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
        </div>
        {contextDock && sid && <aside aria-label="上下文面板" className="hidden min-w-80 w-[48%] max-w-3xl shrink-0 overflow-y-auto border-l p-3 lg:block"><div className="mb-2 text-right"><Button size="sm" variant="ghost" onClick={() => setContextDock(false)}>关闭</Button></div><Suspense fallback={<p role="status">…</p>}><LazySessionInsights key={sid} sessionID={sid} embedded /></Suspense></aside>}
      </CardContent>
      {sid && <ContextDialog sessionID={sid} open={contextOpen} onOpenChange={setContextOpen} />}
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
        <div className="chat-workspace relative flex h-full">
          {/* 无 p-4：让主区与 L2 贴边、顶部与 L1 对齐，横线才能连成一条 */}
          {!panelCollapsed && <button type="button" className="chat-sidebar-backdrop" aria-label="关闭会话列表遮罩" onClick={togglePanel} />}
          <SessionListPanel activeId={sessionId} collapsed={panelCollapsed} onSelect={togglePanel} />
          <div className="flex min-w-0 flex-1 flex-col">
            <FreeChatCore onTogglePanel={togglePanel} panelCollapsed={panelCollapsed} />
          </div>
        </div>
      </DataProvider>
    </ServerProvider>
  )
}
