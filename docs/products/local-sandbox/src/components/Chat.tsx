import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowUp, MessageSquare, Square } from "lucide-react"
import type { Message } from "../types"
import * as api from "../api"
import { MessageList } from "./MessageList"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

interface ChatProps {
  sessionID: string | null
  sandboxMode: "local" | "remote" | null
  model: api.ModelRef
  onModelChange: (model: api.ModelRef) => void
}

const MODELS: Array<{ label: string; value: api.ModelRef }> = [
  { label: "DeepSeek V4 Flash", value: { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" } },
  { label: "DeepSeek Chat", value: { providerID: "Yd-DeepSeek", modelID: "deepseek-chat" } },
  { label: "GLM 5.1", value: { providerID: "zhipuai", modelID: "glm-5.1" } },
]

export function Chat({ sessionID, sandboxMode, model, onModelChange }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [running, setRunning] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    if (!sessionID) return
    try {
      setMessages(await api.listMessages(sessionID))
    } catch (err) {
      console.error("fetch messages failed:", err)
    }
  }, [sessionID])

  useEffect(() => {
    if (!sessionID) return
    setMessages([])
    setRunning(false)
    refresh()

    const source = api.openEventStream((ev) => {
      const p = ev.properties ?? {}
      const sid = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID
      if (sid && sid !== sessionID) return
      if (ev.type.startsWith("message.")) refresh()
      if (ev.type === "session.idle") {
        setRunning(false)
        refresh()
      }
      if (ev.type === "session.active" || ev.type === "session.status") setRunning(true)
    })
    return () => source.close()
  }, [sessionID, refresh])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, running])

  if (!sessionID) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10">
          <MessageSquare className="size-6 text-primary" />
        </div>
        <h2 className="text-lg font-semibold tracking-tight">本地沙箱测试</h2>
        <p className="max-w-sm text-center text-[13px] text-muted-foreground">
          新建会话开始对话；检测到本地 Agent 时自动绑定，命令将在你的电脑上执行
        </p>
      </div>
    )
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || sending || running) return
    setSending(true)
    setInput("")
    setRunning(true)
    try {
      await api.sendMessage(sessionID!, text, model)
      await refresh()
    } catch (err) {
      console.error("send failed:", err)
      setRunning(false)
    } finally {
      setSending(false)
    }
  }

  async function handleAbort() {
    try {
      await api.abortSession(sessionID!)
      setRunning(false)
    } catch (err) {
      console.error("abort failed:", err)
    }
  }

  const modeLabel =
    sandboxMode === "local"
      ? { text: "本地沙箱", cls: "bg-emerald-500/15 text-emerald-600" }
      : sandboxMode === "remote"
        ? { text: "远程沙箱", cls: "bg-blue-500/15 text-blue-600" }
        : { text: "未绑定", cls: "bg-muted text-muted-foreground" }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-5">
          {messages.length === 0 && (
            <p className="mt-12 text-center text-[13px] text-muted-foreground">
              发送一条消息测试本地沙箱，如「运行 ls 并解释输出」
            </p>
          )}
          <MessageList messages={messages} running={running} sandboxMode={sandboxMode} />
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t bg-background/95 px-4 py-4 backdrop-blur">
        <div className="mx-auto max-w-3xl rounded-2xl border bg-card shadow-sm transition-shadow focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/40">
          <Textarea
            value={input}
            rows={2}
            className="min-h-0 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            placeholder={
              sandboxMode === "local"
                ? "本地沙箱模式：命令将在你的电脑上执行"
                : sandboxMode === "remote"
                  ? "远程沙箱模式：命令将在云端容器中执行"
                  : "输入消息..."
            }
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend()
            }}
          />
          <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
            <div className="flex items-center gap-2">
              <select
                value={`${model.providerID}/${model.modelID}`}
                onChange={(e) => {
                  const found = MODELS.find((m) => `${m.value.providerID}/${m.value.modelID}` === e.target.value)
                  if (found) onModelChange(found.value)
                }}
                className="rounded-md bg-transparent px-1.5 py-1 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground"
                title="选择模型"
              >
                {MODELS.map((m) => (
                  <option key={`${m.value.providerID}/${m.value.modelID}`} value={`${m.value.providerID}/${m.value.modelID}`}>
                    {m.label}
                  </option>
                ))}
              </select>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${modeLabel.cls}`}>
                {modeLabel.text}
              </span>
            </div>
            {running ? (
              <Button size="icon-sm" variant="outline" onClick={handleAbort} title="中断执行" className="rounded-full">
                <Square className="size-3" />
              </Button>
            ) : (
              <Button
                size="icon-sm"
                onClick={handleSend}
                disabled={!input.trim() || sending}
                className="rounded-full"
                title="发送 (⌘+Enter)"
              >
                <ArrowUp className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
