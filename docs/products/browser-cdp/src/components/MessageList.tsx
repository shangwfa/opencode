import { useState } from "react"
import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Loader2,
  Terminal,
  UserRound,
  Wrench,
} from "lucide-react"
import { Streamdown } from "streamdown"
import type { MessagePart, SessionMessage } from "@/lib/api"

function formatTime(timestamp?: number) {
  if (!timestamp) return ""
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
}

function toolLabel(tool?: string) {
  if (tool === "bash") return "执行浏览器命令"
  if (tool === "skill") return "加载浏览器能力"
  return tool || "工具调用"
}

function ToolCall({ part }: { part: MessagePart }) {
  const [open, setOpen] = useState(false)
  const state = part.state ?? {}
  const input = state.input ? JSON.stringify(state.input, null, 2) : "无参数"
  const status = state.status ?? "pending"
  const failed = status === "error"

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-muted/35 text-xs shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-10 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-accent/60"
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
          {part.tool === "bash" ? <Terminal className="size-3" /> : <Wrench className="size-3" />}
        </span>
        {open ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
        <span className="font-medium">{toolLabel(part.tool)}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{part.tool}</span>
        <span className="ml-auto">
          {status === "running" && <Loader2 className="size-3.5 animate-spin text-blue-500" />}
          {status === "completed" && <Check className="size-3.5 text-emerald-600" />}
          {failed && <AlertCircle className="size-3.5 text-destructive" />}
          {status === "pending" && <CircleDashed className="size-3.5 text-muted-foreground" />}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border/60 px-3 py-3">
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">输入</p>
            <pre className="max-h-40 overflow-auto rounded-lg bg-background/80 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">{input}</pre>
          </div>
          {state.output && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">输出</p>
              <pre className="max-h-56 overflow-auto rounded-lg bg-background/80 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">{state.output.slice(0, 5000)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex items-center gap-1.5 hover:text-foreground">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span>思考过程</span>
      </button>
      {open && <p className="mt-2 border-l-2 border-border pl-3 leading-relaxed whitespace-pre-wrap">{text}</p>}
    </div>
  )
}

function AssistantMessage({ message }: { message: SessionMessage }) {
  return (
    <article className="space-y-2.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="flex size-6 items-center justify-center rounded-lg bg-foreground text-background"><Bot className="size-3.5" /></span>
        <span className="font-medium text-foreground">浏览器 Agent</span>
        <span>{formatTime(message.info.time?.created)}</span>
      </div>
      <div className="space-y-2 pl-8">
        {message.parts.map((part, index) => {
          if (part.type === "text" && part.text?.trim()) {
            return (
              <Streamdown
                key={part.id ?? index}
                linkSafety={{ enabled: false }}
                className="text-sm leading-7 [&>*+*]:mt-3 [&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_button[data-streamdown=link]]:font-medium [&_button[data-streamdown=link]]:text-primary [&_button[data-streamdown=link]]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-zinc-950 [&_pre]:p-3 [&_pre]:text-zinc-100 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_table]:my-3 [&_table]:w-full [&_th]:border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:px-2 [&_td]:py-1"
              >
                {part.text}
              </Streamdown>
            )
          }
          if (part.type === "reasoning" && part.text?.trim()) return <Reasoning key={part.id ?? index} text={part.text} />
          if (part.type === "tool") return <ToolCall key={part.id ?? index} part={part} />
          return null
        })}
      </div>
    </article>
  )
}

export function MessageList({ messages, running }: { messages: SessionMessage[]; running: boolean }) {
  return (
    <div className="space-y-7">
      {messages.map((message) => {
        if (message.info.role === "user") {
          const text = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("")
          return (
            <article key={message.info.id} className="flex justify-end gap-2">
              <div className="max-w-[88%] space-y-1 text-right">
                <p className="text-[10px] text-muted-foreground">你 · {formatTime(message.info.time?.created)}</p>
                <div className="rounded-2xl rounded-tr-md bg-foreground px-4 py-2.5 text-left text-sm leading-6 text-background shadow-sm whitespace-pre-wrap">{text}</div>
              </div>
              <span className="mt-4 flex size-6 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground"><UserRound className="size-3.5" /></span>
            </article>
          )
        }
        return <AssistantMessage key={message.info.id} message={message} />
      })}
      {running && (
        <div className="flex items-center gap-2 pl-8 text-xs text-muted-foreground">
          <span className="flex size-6 items-center justify-center rounded-lg bg-foreground text-background"><Loader2 className="size-3.5 animate-spin" /></span>
          Agent 正在操作浏览器...
        </div>
      )}
    </div>
  )
}
