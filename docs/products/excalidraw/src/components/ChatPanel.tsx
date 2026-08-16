import { useEffect, useRef } from 'react'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'
import { ArrowUp, Square, Terminal } from 'lucide-react'
import type { Message } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import ModelSelector from './ModelSelector'
import type { ModelOption } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Props {
  messages: Message[]
  running: boolean
  input: string
  onInputChange: (v: string) => void
  onSend: () => void
  onAbort: () => void
  model: ModelOption | null
  onModelChange: (m: ModelOption) => void
  hasSession: boolean
}

function ToolLine({ part }: { part: Message['parts'][number] }) {
  const cmd = String(part.state?.input?.command ?? part.state?.input?.cmd ?? '')
  const shown = cmd.replace(/\s*--noproxy '\*'\s*/g, ' ').slice(0, 120)
  const status = part.state?.status ?? 'running'
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 font-mono text-xs text-muted-foreground',
        status === 'error' && 'border-destructive/50 text-destructive',
      )}
    >
      <Terminal className="size-3 shrink-0" />
      <span className="truncate">{shown || `${part.tool ?? 'tool'} ${part.state?.title ?? ''}`}</span>
    </div>
  )
}

function MessageItem({ message }: { message: Message }) {
  const isUser = message.info.role === 'user'
  const text = message.parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n\n')
  const tools = message.parts.filter((p) => p.type === 'tool' || p.type === 'step')

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground whitespace-pre-wrap">
          {text}
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      {tools.map((part, i) => (
        <ToolLine key={part.id ?? i} part={part} />
      ))}
      {text && (
        <div className="prose prose-sm max-w-none text-sm [&_p]:leading-relaxed">
          <Streamdown>{text}</Streamdown>
        </div>
      )}
    </div>
  )
}

export default function ChatPanel({
  messages,
  running,
  input,
  onInputChange,
  onSend,
  onAbort,
  model,
  onModelChange,
  hasSession,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef('')

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, running])

  draftRef.current = input

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <div className="flex h-full min-w-80 flex-1 flex-col border-r bg-background">
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <div className="text-3xl">✏️</div>
            <p className="text-sm">描述你想要的图表，AI 会实时绘制到右侧画布</p>
            <p className="text-xs">例如：生成一个用户管理端流程图</p>
          </div>
        )}
        {messages.map((m) => (
          <MessageItem key={m.info.id} message={m} />
        ))}
        {running && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-primary" />
            AI 正在思考…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t p-3">
        <div className="flex items-end gap-2 rounded-lg border p-2 focus-within:ring-2 focus-within:ring-ring/50">
          <Textarea
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={hasSession ? '描述修改要求…' : '描述你想要的图表…'}
            className="max-h-40 min-h-9 resize-none border-0 p-0 focus-visible:ring-0 dark:bg-transparent"
            rows={1}
          />
          {running ? (
            <Button size="icon-sm" variant="outline" onClick={onAbort} title="停止">
              <Square className="size-3.5" />
            </Button>
          ) : (
            <Button size="icon-sm" disabled={!input.trim()} onClick={onSend} title="发送">
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Enter 发送 / Shift+Enter 换行</span>
          <ModelSelector model={model} onModelChange={onModelChange} />
        </div>
      </div>
    </div>
  )
}
