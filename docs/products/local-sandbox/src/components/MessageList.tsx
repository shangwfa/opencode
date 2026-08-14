import { useState, type ReactNode } from "react"
import {
  FileText,
  Terminal,
  Pencil,
  Globe,
  Search,
  Wrench,
  ChevronDown,
  ChevronRight,
  Loader2,
  Sparkles,
} from "lucide-react"
import { Streamdown } from "streamdown"
import remarkBreaks from "remark-breaks"
import type { Message, MessagePart } from "../types"
import { Spinner } from "./ui"

const statusColor: Record<string, string> = {
  pending: "#faad14",
  running: "#ef4444",
  completed: "#22c55e",
  error: "#ef4444",
}

function toolIcon(tool: string) {
  const size = 13
  switch (tool) {
    case "read":
    case "write":
    case "edit":
      return tool === "edit" ? <Pencil size={size} /> : <FileText size={size} />
    case "bash":
      return <Terminal size={size} />
    case "glob":
    case "grep":
      return <Search size={size} />
    case "webfetch":
      return <Globe size={size} />
    default:
      return <Wrench size={size} />
  }
}

// 按工具类型提取展示用的关键参数，避免整段 JSON 刷屏
function summarizeInput(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "read":
    case "write":
    case "edit":
    case "apply_patch":
      return String(input["filePath"] ?? input["path"] ?? "")
    case "bash":
      return String(input["command"] ?? "")
    case "glob":
      return String(input["pattern"] ?? input["path"] ?? "")
    case "grep":
      return `${input["pattern"] ?? ""} ${input["path"] ?? ""}`.trim()
    case "webfetch":
      return String(input["url"] ?? "")
    default: {
      const first = Object.entries(input)[0]
      if (!first) return ""
      const v = typeof first[1] === "string" ? first[1] : JSON.stringify(first[1])
      return v.length > 100 ? v.slice(0, 100) + "…" : v
    }
  }
}

function ToolCall({ part }: { part: MessagePart }) {
  const [open, setOpen] = useState(false)
  const state = part.state ?? {}
  const status = state.status ?? "pending"
  const tool = part.tool ?? "tool"
  const summary = summarizeInput(tool, state.input ?? {})

  return (
    <div
      className={
        "overflow-hidden rounded-lg border text-xs " +
        (status === "error" ? "border-red-200 bg-red-50/50" : "border-border bg-muted/30")
      }
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex h-8 w-full items-center gap-2 px-2.5 text-left transition-colors hover:bg-muted/50"
      >
        {open ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
        <span className="text-muted-foreground">{toolIcon(tool)}</span>
        <span className="font-mono font-semibold">{tool}</span>
        {status === "running" ? (
          <Loader2 className="size-3 animate-spin text-red-500" />
        ) : (
          <span className="size-1.5 rounded-full" style={{ background: statusColor[status] ?? "#999" }} />
        )}
        <span className="ml-auto max-w-[60%] truncate font-mono text-muted-foreground">
          {state.title ?? summary}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {Object.keys(state.input ?? {}).length > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-medium text-muted-foreground">输入</p>
              <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap break-all">
                {tool === "bash"
                  ? String((state.input ?? {})["command"] ?? "")
                  : JSON.stringify(state.input, null, 2)}
              </pre>
            </div>
          )}
          {state.output && (
            <div>
              <p className="mb-1 text-[10px] font-medium text-muted-foreground">输出</p>
              <pre className="max-h-60 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap break-all">
                {state.output.slice(0, 3000)}
              </pre>
            </div>
          )}
          {state.error && (
            <div>
              <p className="mb-1 text-[10px] font-medium text-red-500">错误</p>
              <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap break-all text-red-500">
                {String(state.error).slice(0, 2000)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Reasoning({ text, durationMs }: { text: string; durationMs?: number }) {
  const [open, setOpen] = useState(false)
  const seconds = durationMs != null ? Math.max(1, Math.round(durationMs / 1000)) : null
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-full bg-muted/70 px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Sparkles className="size-3" />
        深度思考{seconds != null ? `（用时 ${seconds} 秒）` : ""}
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
      </button>
      {open && (
        <div className="mt-2 whitespace-pre-wrap rounded-lg border-l-2 border-muted-foreground/20 bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  )
}

const markdownComponents = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: "#dc2626" }}>
      {children}
    </a>
  ),
}

function MessageItem({ message }: { message: Message }) {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("")
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-sm whitespace-pre-wrap">
          {text}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {message.parts.map((part, i) => {
        if (part.type === "text" && part.text?.trim()) {
          return (
            <div key={part.id ?? i} className="assistant-markdown">
              <Streamdown
                remarkPlugins={[remarkBreaks]}
                linkSafety={{ enabled: false }}
                controls={false}
                components={markdownComponents}
              >
                {part.text}
              </Streamdown>
            </div>
          )
        }
        if (part.type === "reasoning" && part.text?.trim()) {
          const t = message.info.time
          const durationMs = t?.created != null && t.completed != null ? t.completed - t.created : undefined
          return <Reasoning key={part.id ?? i} text={part.text} durationMs={durationMs} />
        }
        if (part.type === "tool") {
          return <ToolCall key={part.id ?? i} part={part} />
        }
        return null
      })}
    </div>
  )
}

export function MessageList({
  messages,
  running,
  sandboxMode,
}: {
  messages: Message[]
  running: boolean
  sandboxMode: "local" | "remote" | null
}) {
  return (
    <div className="space-y-5">
      {messages.map((m) => (
        <MessageItem key={m.info.id} message={m} />
      ))}
      {running && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          AI 正在执行
          {sandboxMode === "local" && (
            <span className="text-[11px] text-emerald-600">（在你的电脑上）</span>
          )}
        </div>
      )}
    </div>
  )
}
