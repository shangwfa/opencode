import { useEffect, useRef, useState } from "react"
import { ArrowUp, Circle, MessageSquare, Square, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MessageList } from "@/components/MessageList"
import type { SessionMessage } from "@/lib/api"

interface ChatPanelProps {
  sessionId: string
  ready: boolean
}

export function ChatPanel({ sessionId, ready }: ChatPanelProps) {
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const followMessages = useRef(true)

  async function refresh() {
    const response = await fetch(`/api/sessions/${sessionId}/messages`)
    if (!response.ok) return
    const data = (await response.json()) as SessionMessage[]
    setMessages(Array.isArray(data) ? data : [])
  }

  useEffect(() => {
    setMessages([])
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => window.clearInterval(timer)
  }, [sessionId])

  useEffect(() => {
    if (followMessages.current) bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, sending])

  async function send() {
    const text = input.trim()
    if (!text || sending || !ready) return
    setInput("")
    setSending(true)
    setError(null)
    followMessages.current = true
    try {
      const response = await fetch(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model: { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" },
        }),
      })
      if (!response.ok) throw new Error(`请求失败（${response.status}）`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  async function abort() {
    await fetch(`/api/sessions/${sessionId}/abort`, { method: "POST" })
    setSending(false)
    await refresh()
  }

  return (
    <section className="flex h-full min-w-0 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card/70 px-5">
        <div className="flex size-8 items-center justify-center rounded-xl bg-foreground text-background"><MessageSquare className="size-4" /></div>
        <div className="min-w-0">
          <div className="flex items-center gap-2"><span className="text-sm font-semibold">Browser Agent</span><span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600">CDP</span></div>
          <p className="text-[11px] text-muted-foreground">通过浏览器完成你的任务</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground"><Circle className={ready ? "size-2 fill-emerald-500 text-emerald-500" : "size-2 fill-muted text-muted-foreground"} />{ready ? "浏览器在线" : "等待浏览器"}</div>
      </header>
      <div
        className="flex-1 overflow-y-auto px-5 py-6"
        onScroll={(event) => {
          const element = event.currentTarget
          followMessages.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
        }}
      >
        {messages.length ? <MessageList messages={messages} running={sending} /> : (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-foreground text-background shadow-lg shadow-foreground/10"><Sparkles className="size-6" /></div>
            <div><p className="text-sm font-semibold">让 Agent 操作浏览器</p><p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">描述目标网站和要完成的动作，Agent 会通过 CDP 实际点击、输入并反馈结果。</p></div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="border-t bg-card/50 p-4">
        {error && <p className="mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
        <div className="rounded-2xl border bg-card shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring/40">
          <textarea
            value={input}
            disabled={!ready || sending}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send() }}
            placeholder={ready ? "继续这个会话..." : "浏览器就绪后才能发送消息"}
            rows={3}
            className="w-full resize-none rounded-t-2xl bg-transparent px-4 py-3 text-sm leading-6 outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
            <span className="text-[10px] text-muted-foreground">⌘↵ 发送 · Agent 将通过 CDP 操作浏览器</span>
            {sending ? <Button size="icon-sm" variant="outline" onClick={() => void abort()} className="rounded-xl" title="中断执行"><Square /></Button> : <Button size="icon-sm" onClick={() => void send()} disabled={!input.trim() || !ready} className="rounded-xl"><ArrowUp /></Button>}
          </div>
        </div>
      </div>
    </section>
  )
}
