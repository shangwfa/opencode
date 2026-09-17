import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Files, Loader2, MonitorPlay, Square } from 'lucide-react'
import type { Agent, Message } from '../lib/api'
import { api } from '../lib/api'
import { MessageList } from './MessageList'
import VncScreen from './VncScreen'
import FilesPanel from './FilesPanel'
import ModelSelector from './ModelSelector'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup, useDefaultLayout } from './ui/resizable'
import { cn } from '../lib/utils'

interface Props {
  agent: Agent
  onAgentUpdated: () => void
  model: { providerID: string; modelID: string } | null
  onModelChange: (model: { providerID: string; modelID: string }) => void
}

type Tab = 'browser' | 'files'

export default function AgentSession({ agent, onAgentUpdated, model, onModelChange }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [running, setRunning] = useState(false)
  const [tab, setTab] = useState<Tab>('browser')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [fileCount, setFileCount] = useState(0)
  const abortedRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const refreshMessages = useCallback(async () => {
    try {
      const list = await api.listMessages(agent.id)
      setMessages(list)
      if (!abortedRef.current) {
        const { busy } = await api.getAgentStatus(agent.id)
        setRunning(busy)
      }
    } catch (err) {
      console.error('fetch messages failed:', err)
    }
  }, [agent.id])

  useEffect(() => {
    refreshMessages()

    const source = new EventSource(`/api/agents/${agent.id}/events`)
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string }
        const type = data.type ?? ''
        if (type.startsWith('message.')) {
          refreshMessages()
        }
        if (type === 'session.idle') {
          setRunning(false)
          abortedRef.current = false
          refreshMessages()
          api
            .listFiles(agent.id)
            .then((files) => setFileCount(files.length))
            .catch(() => {})
        }
        if (type === 'session.status' && !abortedRef.current) {
          setRunning(true)
        }
      } catch {
        // ignore malformed events
      }
    }
    return () => source.close()
  }, [agent.id, refreshMessages])

  useEffect(() => {
    api
      .listFiles(agent.id)
      .then((files) => setFileCount(files.length))
      .catch(() => {})
  }, [agent.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, running])

  async function handleSend() {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    setInput('')
    abortedRef.current = false
    setRunning(true)
    try {
      await api.sendMessage(agent.id, text, model ?? undefined)
      await refreshMessages()
    } catch (err) {
      console.error('send failed:', err)
      setRunning(false)
    } finally {
      setSending(false)
    }
  }

  async function handleAbort() {
    try {
      await api.abortAgent(agent.id)
      abortedRef.current = true
      setRunning(false)
      await refreshMessages()
    } catch (err) {
      console.error('abort failed:', err)
    }
  }

  const layout = useDefaultLayout({ id: `agent-session-${agent.id}` })

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      className="flex-1"
    >
      <ResizablePanel defaultSize="40" minSize="30">
        <div className="flex h-full min-w-0 flex-col">
          <div className="flex items-center gap-2 border-b px-4 py-2.5">
            <h2 className="truncate text-sm font-medium">{agent.title}</h2>
            <Badge variant={running ? 'default' : 'secondary'} className="gap-1">
              {running && <Loader2 className="size-3 animate-spin" />}
              {running ? '执行中' : '已完成'}
            </Badge>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
            <MessageList messages={messages} running={running} />
            <div ref={bottomRef} />
          </div>

          <div className="border-t p-4">
            <div className="rounded-xl border bg-card focus-within:ring-2 focus-within:ring-ring/50">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend()
                }}
                placeholder="继续这个会话..."
                rows={2}
                className="w-full resize-none rounded-t-xl bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
              />
              <div className="flex items-center justify-between px-2 py-1.5">
                <ModelSelector value={model} onChange={onModelChange} />
                {running ? (
                  <Button
                    size="icon-sm"
                    variant="outline"
                    onClick={handleAbort}
                    title="中断执行"
                    className="rounded-full"
                  >
                    <Square />
                  </Button>
                ) : (
                  <Button
                    size="icon-sm"
                    onClick={handleSend}
                    disabled={!input.trim() || sending}
                    className="rounded-full"
                  >
                    {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />

      <ResizablePanel defaultSize="60" minSize="25">
        <div className="flex h-full flex-col border-l">
          <div className="flex items-center gap-1 border-b px-3 py-2">
            <button
              onClick={() => setTab('browser')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                tab === 'browser'
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <MonitorPlay className="size-3.5" />
              Browser
            </button>
            <button
              onClick={() => setTab('files')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                tab === 'files'
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Files className="size-3.5" />
              Files{fileCount > 0 && ` (${fileCount})`}
            </button>
          </div>
          <div className="flex flex-1 overflow-hidden">
            {tab === 'browser' ? (
              <VncScreen
                sandboxId={agent.sandboxId}
                onRebuild={async () => {
                  await api.rebuildBrowser(agent.id)
                  onAgentUpdated()
                }}
              />
            ) : (
              <FilesPanel agentId={agent.id} onCountChange={setFileCount} />
            )}
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
