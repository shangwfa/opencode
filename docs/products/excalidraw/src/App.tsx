import { useCallback, useEffect, useState } from 'react'
import { useDefaultLayout } from 'react-resizable-panels'
import { api } from '@/lib/api'
import type { Message, ModelOption, SessionRecord } from '@/lib/api'
import Sidebar from '@/components/Sidebar'
import ChatPanel from '@/components/ChatPanel'
import CanvasPanel from '@/components/CanvasPanel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'

export default function App() {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [model, setModel] = useState<ModelOption | null>(null)

  const active = sessions.find((s) => s.id === activeId) ?? null
  const layout = useDefaultLayout({ id: 'excalidraw-layout', panelIds: ['chat', 'canvas'] })

  const refreshSessions = useCallback(() => {
    api.listSessions().then(setSessions).catch(() => {})
  }, [])

  const refreshMessages = useCallback(() => {
    if (!activeId) return
    api.listMessages(activeId).then(setMessages).catch(() => {})
  }, [activeId])

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    refreshMessages()
  }, [refreshMessages])

  // 画布 SSE 里转发的 SaaS 事件 → 刷新消息 / 运行状态
  const handleSaasEvent = useCallback(
    (type: string) => {
      if (type.startsWith('message.')) refreshMessages()
      if (type === 'session.idle') {
        setRunning(false)
        refreshMessages()
      }
      if (type === 'session.error') {
        setRunning(false)
        refreshMessages()
      }
      if (type === 'session.status') setRunning(true)
    },
    [refreshMessages],
  )

  async function handleSend() {
    const text = input.trim()
    if (!text || running) return
    setInput('')
    setRunning(true)
    try {
      if (!active) {
        const session = await api.createSession(text, model ?? undefined)
        setSessions((prev) => [session, ...prev])
        setActiveId(session.id)
        setMessages([])
      } else {
        await api.sendPrompt(active.id, text, model ?? undefined)
        await refreshMessages()
      }
    } catch (err) {
      console.error('send failed:', err)
      setRunning(false)
    }
  }

  async function handleAbort() {
    if (!active) return
    try {
      await api.abortSession(active.id)
      setRunning(false)
    } catch (err) {
      console.error('abort failed:', err)
    }
  }

  async function handleDelete(id: string) {
    await api.deleteSession(id).catch(() => {})
    if (activeId === id) {
      setActiveId(null)
      setMessages([])
    }
    refreshSessions()
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id)
          setRunning(false)
        }}
        onNew={() => {
          setActiveId(null)
          setMessages([])
          setInput('')
        }}
        onDelete={handleDelete}
      />
      {active ? (
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex-1"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
        >
          <ResizablePanel id="chat" defaultSize="35%" minSize="20%" className="min-w-72">
            <ChatPanel
              messages={messages}
              running={running}
              input={input}
              onInputChange={setInput}
              onSend={handleSend}
              onAbort={handleAbort}
              model={model}
              onModelChange={setModel}
              hasSession
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="canvas" defaultSize="65%" minSize="30%">
            <CanvasPanel canvasId={active.canvasId} onSaasEvent={handleSaasEvent} />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <ChatPanel
          messages={messages}
          running={running}
          input={input}
          onInputChange={setInput}
          onSend={handleSend}
          onAbort={handleAbort}
          model={model}
          onModelChange={setModel}
          hasSession={false}
        />
      )}
    </div>
  )
}
