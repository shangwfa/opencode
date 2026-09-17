import { useCallback, useEffect, useState } from "react"
import { ArrowUp, Loader2, MonitorPlay, Sparkles } from "lucide-react"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { SessionSidebar } from "@/components/SessionSidebar"
import { BrowserView } from "@/components/BrowserView"
import { ChatPanel } from "@/components/ChatPanel"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import type { SessionEntry, SessionStatus } from "@/lib/api"

interface Config {
  image: string
  saasBaseUrl: string
}

export default function App() {
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [currentSid, setCurrentSid] = useState<string>("")
  const [newSession, setNewSession] = useState(false)
  const [status, setStatus] = useState<SessionStatus | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [image, setImage] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const api = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } })
    const body = await res.json()
    if (!res.ok) throw new Error(String((body as { error?: string }).error ?? res.status))
    return body as T
  }, [])

  const loadSessions = useCallback(async () => {
    setSessions(await api<SessionEntry[]>("/api/sessions"))
  }, [api])

  const loadStatus = useCallback(
    async (sid: string) => {
      if (!sid) return undefined
      try {
        setStatus(await api<SessionStatus>(`/api/sessions/${sid}/status`))
      } catch {
        setStatus(null)
      }
    },
    [api],
  )

  useEffect(() => {
    void (async () => {
      const cfg = await api<Config>("/api/config")
      setConfig(cfg)
      setImage(cfg.image)
      await loadSessions()
    })().catch((err) => setMessage(`初始化失败: ${String(err)}`))
  }, [api, loadSessions])

  useEffect(() => {
    if (!currentSid) return undefined
    void loadStatus(currentSid)
    const timer = setInterval(() => void loadStatus(currentSid), 5000)
    return () => clearInterval(timer)
  }, [currentSid, loadStatus])

  useEffect(() => {
    const timer = setInterval(() => void loadSessions(), 10_000)
    return () => clearInterval(timer)
  }, [loadSessions])

  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label)
      setMessage(null)
      try {
        await fn()
      } catch (err) {
        setMessage(`${label}失败: ${String(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [],
  )

  const createSession = (prompt: string, imageOverride?: string) =>
    run("创建会话", async () => {
      const created = await api<{ sessionId: string; ready: boolean; error: string | null }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ image: imageOverride ?? undefined }),
      })
      await loadSessions()
      setCurrentSid(created.sessionId)
      setNewSession(false)
      setMessage(created.ready ? "会话就绪，浏览器已启动" : `会话已创建但未就绪: ${created.error ?? "unknown"}`)
      if (prompt.trim() && created.ready) {
        await api(`/api/sessions/${created.sessionId}/messages`, {
          method: "POST",
          body: JSON.stringify({ text: prompt.trim(), model: { providerID: "opencode", modelID: "nemotron-3.5-lightning-free" } }),
        })
      }
    })

  const startBrowser = () =>
    run("启动浏览器", async () => {
      const result = await api<{ ready: boolean }>(`/api/sessions/${currentSid}/browser/start`, { method: "POST" })
      await loadStatus(currentSid)
      setMessage(result.ready ? "浏览器已启动" : "浏览器启动命令已执行，但 CDP 未就绪")
    })

  const stopBrowser = () =>
    run("停止浏览器", async () => {
      await api(`/api/sessions/${currentSid}/browser/stop`, { method: "POST" })
      await loadStatus(currentSid)
    })

  const killSandbox = () =>
    run("销毁沙箱", async () => {
      await api(`/api/sessions/${currentSid}/sandbox`, { method: "DELETE" })
      await loadStatus(currentSid)
      setMessage("沙箱已销毁（keepAlive 仍生效，可用「启动浏览器」重新 boot）")
    })

  const ready = status?.ready ?? false

  return (
    <div className="h-screen bg-background text-foreground">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="18" minSize="14" maxSize="32">
          <SessionSidebar
            sessions={sessions}
            currentSid={currentSid}
            config={config}
            image={image}
            onImageChange={setImage}
            busy={busy}
            message={message}
            ready={ready}
            onClearMessage={() => setMessage(null)}
            onSelect={setCurrentSid}
             onCreate={() => {
               setCurrentSid("")
               setNewSession(true)
               setMessage(null)
             }}
            onStart={startBrowser}
            onStop={stopBrowser}
            onKill={killSandbox}
          />
        </ResizablePanel>
        <ResizableHandle withHandle />

          <ResizablePanel defaultSize="82" minSize="55">
           {newSession ? (
             <NewSessionHome submitting={busy === "创建会话"} onSubmit={(prompt) => void createSession(prompt)} />
           ) : <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize="38" minSize="28">
              {currentSid ? <ChatPanel key={currentSid} sessionId={currentSid} ready={ready} /> : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">创建或选择一个会话开始聊天</div>
              )}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="62" minSize="35">
              <main className="flex h-full min-w-0 flex-col overflow-hidden">
                {currentSid && ready ? <BrowserView key={currentSid} sessionId={currentSid} /> : (
                  <div className="flex flex-1 items-center justify-center">
                    <Card className="border-none shadow-none"><CardContent className="flex flex-col items-center gap-3 py-12 text-center"><div className="flex size-14 items-center justify-center rounded-2xl bg-muted"><MonitorPlay className="size-7 text-muted-foreground" /></div><p className="max-w-xs text-sm text-muted-foreground">{currentSid ? "CDP 未就绪：点击「启动浏览器」。" : "创建或选择一个会话，查看浏览器预览。"}</p></CardContent></Card>
                  </div>
                )}
              </main>
            </ResizablePanel>
           </ResizablePanelGroup>}
         </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

function NewSessionHome(props: { submitting: boolean; onSubmit: (prompt: string) => void }) {
  const [prompt, setPrompt] = useState("")

  const submit = () => {
    if (prompt.trim() && !props.submitting) props.onSubmit(prompt)
  }

  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center px-8">
      <div className="w-full max-w-2xl space-y-8">
        <div className="flex items-center justify-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <MonitorPlay className="size-5" />
          </div>
          <h1 className="font-heading text-2xl font-semibold">Browser CDP Agent</h1>
        </div>
        <div className="rounded-2xl border bg-card shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring/50">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit()
            }}
            placeholder="描述你的需求，Agent 将打开浏览器执行..."
            rows={4}
            disabled={props.submitting}
            className="w-full resize-none rounded-t-2xl bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Sparkles className="size-3.5" />⌘↵ 发送</span>
            <Button size="icon" onClick={submit} disabled={!prompt.trim() || props.submitting} className="rounded-full">
              {props.submitting ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            </Button>
          </div>
        </div>
        <p className="text-center text-xs text-muted-foreground">例如：打开影刀官网，整理主要产品和功能</p>
      </div>
    </div>
  )
}
