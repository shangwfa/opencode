import { useState } from 'react'
import { Brain, ChevronDown, ChevronRight, Loader2, Terminal, Wrench } from 'lucide-react'
import type { Message, MessagePart } from '../lib/api'

function ToolCall({ part }: { part: MessagePart }) {
  const [open, setOpen] = useState(false)
  const state = part.state ?? {}
  const status = state.status ?? 'pending'
  const command =
    typeof state.input?.command === 'string'
      ? state.input.command
      : JSON.stringify(state.input ?? {})

  return (
    <div className="rounded-lg border bg-muted/30 text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {part.tool === 'bash' ? (
          <Terminal className="size-3 text-muted-foreground" />
        ) : (
          <Wrench className="size-3 text-muted-foreground" />
        )}
        <span className="font-mono">{part.tool}</span>
        {status === 'running' && <Loader2 className="size-3 animate-spin text-blue-500" />}
        {status === 'completed' && (
          <span className="size-1.5 rounded-full bg-emerald-500" />
        )}
        {status === 'error' && <span className="size-1.5 rounded-full bg-red-500" />}
        <span className="ml-auto max-w-[50%] truncate text-muted-foreground">{command}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          <div>
            <p className="mb-1 font-medium text-muted-foreground">输入</p>
            <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap break-all">
              {command}
            </pre>
          </div>
          {state.output && (
            <div>
              <p className="mb-1 font-medium text-muted-foreground">输出</p>
              <pre className="max-h-60 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap break-all">
                {state.output.slice(0, 3000)}
              </pre>
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
    <div className="text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
      >
        <Brain className="size-3" />
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        思考过程
      </button>
      {open && (
        <p className="mt-1 border-l-2 pl-3 text-muted-foreground whitespace-pre-wrap">
          {text}
        </p>
      )}
    </div>
  )
}

function MessageItem({ message }: { message: Message }) {
  const isUser = message.info.role === 'user'

  if (isUser) {
    const text = message.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('')
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm">
          {text}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {message.parts.map((part, i) => {
        if (part.type === 'text' && part.text?.trim()) {
          return (
            <p key={part.id ?? i} className="text-sm leading-relaxed whitespace-pre-wrap">
              {part.text}
            </p>
          )
        }
        if (part.type === 'reasoning' && part.text?.trim()) {
          return <Reasoning key={part.id ?? i} text={part.text} />
        }
        if (part.type === 'tool') {
          return <ToolCall key={part.id ?? i} part={part} />
        }
        return null
      })}
    </div>
  )
}

export function MessageList({ messages, running }: { messages: Message[]; running: boolean }) {
  return (
    <div className="space-y-5">
      {messages.map((message) => (
        <MessageItem key={message.info.id} message={message} />
      ))}
      {running && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          AI 正在执行...
        </div>
      )}
    </div>
  )
}
