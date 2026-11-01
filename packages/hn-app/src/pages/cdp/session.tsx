import { useEffect, useMemo, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router"
import { File, Folder, FolderUp, Monitor, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ServerProvider } from "@/context/sdk"
import { DataProvider, useData, type DataBridge } from "@/context/data"
import { usePromptController } from "@/context/prompt-store"
import { withDraftText } from "@/components/prompt-input/draft-text"
import { FilePreviewDialog } from "@/components/session/file-preview-dialog"
import { FreeChatCore } from "@/pages/free-chat"
import { BrowserPanel } from "@/features/browser-cdp/browser-panel"
import { BrowserWorkspaceSplit } from "@/features/browser-cdp/workspace-split"
import { SaveAppDialog } from "@/features/automation/save-app-dialog"
import { sessionSource } from "@/lib/session-source"
import { browserApi } from "@/lib/browser"
import { baseFetch } from "@/lib/base-api"
import { BrowserNavigationToggle, useBrowserWorkspace } from "./layout"

type FirstTask = {
  prompt: string
  model: { providerID: string; modelID: string }
}

/**
 * 首页带过来的首条消息。StrictMode 下 effect 会「运行→清理→再运行」，
 * 组件也可能因路由 replace 重挂；用模块级存储保证消息不丢、且只发一次。
 */
const firstTasks = new Map<string, FirstTask>()
const sentFirstTasks = new Set<string>()

function FirstPrompt({ sessionId, connected }: { sessionId: string; connected: boolean }) {
  const { state } = useLocation()
  const task = (state as FirstTask | null) ?? firstTasks.get(sessionId) ?? null
  const navigate = useNavigate()
  const data = useData()
  const prompt = usePromptController()
  const [error, setError] = useState("")
  const [preparing, setPreparing] = useState(false)
  useEffect(() => {
    if (!task?.prompt) return
    firstTasks.set(sessionId, task)
    if (!connected || sentFirstTasks.has(sessionId)) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const send = () => {
      if (stopped || sentFirstTasks.has(sessionId)) return
      // 先占位再发送：重挂后的第二次 effect 不能再发一遍。
      sentFirstTasks.add(sessionId)
      // 清掉路由临时数据，刷新/返回不重复发起真实浏览器操作。
      navigate(`/cdp/session/${sessionId}`, { replace: true, state: null })
      firstTasks.delete(sessionId)
      data.setSessionStatus(sessionId, { type: "busy" })
      void sessionSource()
        .sendMessage(sessionId, { parts: [{ type: "text", text: task.prompt }], model: task.model })
        .catch((cause) => {
          if (stopped) return
          sentFirstTasks.delete(sessionId)
          firstTasks.set(sessionId, task)
          setError(cause instanceof Error ? cause.message : String(cause))
          prompt.set(withDraftText(prompt.current(), task.prompt))
          data.setSessionStatus(sessionId, { type: "idle" })
        })
        .finally(() => void data.loadMessages(sessionId))
    }
    // 云端模板自举安装可能数分钟：服务端先返回 preparing，这里轮询到就绪再发首条消息。
    const poll = async () => {
      try {
        const status = await browserApi.status(sessionId)
        if (stopped) return
        if (status.status === "ready") {
          setPreparing(false)
          send()
          return
        }
        if (status.status === "failed") {
          setPreparing(false)
          prompt.set(withDraftText(prompt.current(), task.prompt))
          setError(status.error ?? "浏览器准备失败，请在该会话点「重连」后重试。")
          return
        }
        setPreparing(true)
        timer = setTimeout(poll, 3000)
      } catch (cause) {
        if (stopped) return
        setPreparing(false)
        prompt.set(withDraftText(prompt.current(), task.prompt))
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [connected, task, sessionId, navigate, data, prompt])
  if (error)
    return (
      <p role="alert" className="border-b px-4 py-3 text-xs text-destructive">
        {error} 任务已保留在输入框，可手动重试。
      </p>
    )
  if (preparing)
    return (
      <p role="status" className="border-b px-4 py-3 text-xs text-muted-foreground">
        正在准备浏览器（云端模板首次安装可能几分钟）…
      </p>
    )
  return null
}

function WorkFiles({ sessionId }: { sessionId: string }) {
  const [path, setPath] = useState("")
  const [items, setItems] = useState<Array<{ path: string; name: string; type: string }>>([])
  const [error, setError] = useState("")
  const [href, setHref] = useState<string>()
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let disposed = false
    void baseFetch<{ items: typeof items }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/fs?path=${encodeURIComponent(path)}`,
    )
      .then((result) => {
        if (!disposed) {
          setItems(result.items)
          setError("")
        }
      })
      .catch((cause) => {
        if (!disposed) setError(String(cause))
      })
    return () => {
      disposed = true
    }
  }, [sessionId, path, revision])
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mb-3 flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="上级目录"
          disabled={!path}
          onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
        >
          <FolderUp className="size-4" />
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">/workspace/{path}</span>
        <Button variant="ghost" size="icon" aria-label="刷新文件" onClick={() => setRevision((n) => n + 1)}>
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {items.map((item) => (
        <button
          key={item.path}
          className="flex w-full items-center gap-2 rounded-md p-2 text-left text-xs hover:bg-muted"
          onClick={() => {
            const relative = item.path.replace(/^\/workspace\/?/, "")
            if (item.type === "directory") setPath(relative)
            else setHref(`/workspace/${relative}`)
          }}
        >
          {item.type === "directory" ? <Folder className="size-4" /> : <File className="size-4" />}
          <span className="truncate">{item.name || item.path.split("/").at(-1)}</span>
        </button>
      ))}
      {!items.length && !error && <p className="p-6 text-center text-xs text-muted-foreground">目录为空</p>}
      <FilePreviewDialog
        href={href}
        sessionId={sessionId}
        directory="/workspace"
        onOpenChange={(open) => {
          if (!open) setHref(undefined)
        }}
      />
    </div>
  )
}

function SessionContent({ sessionId, connected }: { sessionId: string; connected: boolean }) {
  const [tab, setTab] = useState<"browser" | "files">("browser")
  const [publish, setPublish] = useState(false)
  const [mobilePanel, setMobilePanel] = useState(false)
  const data = useData()
  const { sessions, navigationCollapsed, toggleNavigation } = useBrowserWorkspace()
  const title = sessions.find((session) => session.id === sessionId)?.title ?? "浏览器任务"
  return (
    <>
      <FirstPrompt sessionId={sessionId} connected={connected} />
      <BrowserWorkspaceSplit
        showPanel={mobilePanel}
        chat={
          <FreeChatCore
            title={title}
            onTogglePanel={toggleNavigation}
            panelCollapsed={navigationCollapsed}
            headerActions={
              <>
              <Button variant="outline" size="sm" className="ml-auto text-xs" onClick={() => setPublish(true)}>
                任务确认无误？创建应用
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto size-8 xl:hidden"
                aria-label="显示浏览器面板"
                onClick={() => setMobilePanel(true)}
              >
                <Monitor className="size-4" />
              </Button>
              </>
            }
          />
        }
        panel={<>
          <div className="cdp-tool-tabs flex shrink-0 items-center gap-1 border-b px-3">
            <div className="xl:hidden"><BrowserNavigationToggle /></div>
            <Button
              size="sm"
              variant={tab === "browser" ? "secondary" : "ghost"}
              className="gap-2 text-xs"
              aria-pressed={tab === "browser"}
              onClick={() => setTab("browser")}
            >
              <Monitor className="size-3.5" />
              浏览器
            </Button>
            <Button
              size="sm"
              variant={tab === "files" ? "secondary" : "ghost"}
              className="gap-2 text-xs"
              aria-pressed={tab === "files"}
              onClick={() => setTab("files")}
            >
              <Folder className="size-3.5" />
              文件
            </Button>
            <Button size="sm" variant="ghost" className="text-xs xl:hidden" onClick={() => setMobilePanel(false)}>
              聊天
            </Button>
          </div>
          {/* 切换文件面板不销毁 viewer；保留选中标签与实时连接。 */}
          <div className={tab === "browser" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <BrowserPanel
              sessionId={sessionId}
              working={(data.state.session_status[sessionId]?.type ?? "idle") !== "idle"}
              onTakeover={() => sessionSource().abort(sessionId)}
            />
          </div>
          {tab === "files" && <WorkFiles sessionId={sessionId} />}
        </>}
      />
      <SaveAppDialog open={publish} onOpenChange={setPublish} sessionId={sessionId} />
    </>
  )
}

export function CdpSession() {
  const { sessionId = "" } = useParams()
  const [connectedId, setConnectedId] = useState("")
  const bridge = useMemo<DataBridge>(() => {
    const source = sessionSource()
    return {
      subscribe: (onEvent, onEnd) =>
        source.subscribe(
          sessionId,
          (event) => {
            if (event.type === "server.connected") setConnectedId(sessionId)
            onEvent(event)
          },
          () => {
            setConnectedId("")
            onEnd?.()
          },
        ),
      loadMessages: (sid) => source.messages(sid) as ReturnType<NonNullable<DataBridge["loadMessages"]>>,
    }
  }, [sessionId])
  return (
    <ServerProvider directory="/workspace">
      <DataProvider key={sessionId} bridge={bridge}>
        <SessionContent key={sessionId} sessionId={sessionId} connected={connectedId === sessionId} />
      </DataProvider>
    </ServerProvider>
  )
}
