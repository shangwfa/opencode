import { useEffect, useRef, useState } from "react"
import { ArrowUp, MessageSquare, Square } from "lucide-react"
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
  const bottomRef = useRef<HTMLDivElement>(null)

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
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, sending])

  async function send() {
    const text = input.trim()
    if (!text || sending || !ready) return
    setInput("")
    setSending(true)
    try {
      await fetch(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
      await refresh()
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
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <MessageSquare className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Chat</span>
        <span className="text-xs text-muted-foreground">与浏览器 Agent 对话</span>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {messages.length ? <MessageList messages={messages} running={sending} /> : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-muted"><MessageSquare className="size-5 text-muted-foreground" /></div>
            <p className="text-sm font-medium">让 Agent 操作浏览器</p>
            <p className="max-w-xs text-xs text-muted-foreground">描述要访问的网站或要完成的任务，执行结果会显示在这里。</p>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="border-t p-3">
        <div className="rounded-xl border bg-card focus-within:ring-2 focus-within:ring-ring/50">
          <textarea
            value={input}
            disabled={!ready || sending}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send() }}
            placeholder={ready ? "继续这个会话..." : "浏览器就绪后才能发送消息"}
            rows={3}
            className="w-full resize-none rounded-t-xl bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-[11px] text-muted-foreground">⌘+Enter 发送</span>
            {sending ? <Button size="icon-sm" variant="outline" onClick={() => void abort()} className="rounded-full" title="中断执行"><Square /></Button> : <Button size="icon-sm" onClick={() => void send()} disabled={!input.trim() || !ready} className="rounded-full"><ArrowUp /></Button>}
          </div>
        </div>
      </div>
    </section>
  )
}
