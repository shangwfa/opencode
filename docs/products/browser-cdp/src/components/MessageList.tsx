import { useState } from "react"
import { Brain, ChevronDown, ChevronRight, Loader2, Terminal, Wrench } from "lucide-react"
import type { MessagePart, SessionMessage } from "@/lib/api"

function ToolCall({ part }: { part: MessagePart }) {
  const [open, setOpen] = useState(false)
  const state = part.state ?? {}
  const input = state.input ? JSON.stringify(state.input) : ""
  return (
    <div className="rounded-lg border bg-muted/30 text-xs">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {part.tool === "bash" ? <Terminal className="size-3 text-muted-foreground" /> : <Wrench className="size-3 text-muted-foreground" />}
        <span className="font-mono">{part.tool ?? "工具调用"}</span>
        {state.status === "running" && <Loader2 className="size-3 animate-spin" />}
        <span className="ml-auto max-w-[55%] truncate text-muted-foreground">{input}</span>
      </button>
      {open && <pre className="max-h-48 overflow-auto border-t p-3 font-mono whitespace-pre-wrap break-all">{state.output || input || "无参数"}</pre>}
    </div>
  )
}

export function MessageList({ messages, running }: { messages: SessionMessage[]; running: boolean }) {
  return (
    <div className="space-y-5">
      {messages.map((message) => {
        const user = message.info.role === "user"
        return (
          <div key={message.info.id} className={user ? "flex justify-end" : "space-y-2"}>
            {message.parts.map((part, index) => {
              if (part.type === "text" && part.text?.trim()) {
                return user ? (
                  <div key={part.id ?? index} className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm whitespace-pre-wrap">{part.text}</div>
                ) : (
                  <div key={part.id ?? index} className="text-sm leading-relaxed whitespace-pre-wrap">{part.text}</div>
                )
              }
              if (part.type === "reasoning" && part.text?.trim()) {
                return <div key={part.id ?? index} className="flex items-start gap-1.5 text-xs text-muted-foreground"><Brain className="mt-0.5 size-3 shrink-0" /><span>{part.text}</span></div>
              }
              if (part.type === "tool") return <ToolCall key={part.id ?? index} part={part} />
              return null
            })}
          </div>
        )
      })}
      {running && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />AI 正在执行...</div>}
    </div>
  )
}
