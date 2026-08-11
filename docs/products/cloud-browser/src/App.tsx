import { useCallback, useEffect, useState } from 'react'
import { Globe, MonitorPlay, Plus, Trash2 } from 'lucide-react'
import type { Agent } from './lib/api'
import { api, getSavedModel } from './lib/api'
import AgentHome from './components/AgentHome'
import AgentSession from './components/AgentSession'
import BrowserManager from './components/BrowserManager'
import { Button } from './components/ui/button'
import { Separator } from './components/ui/separator'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup, useDefaultLayout } from './components/ui/resizable'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog'
import { cn } from './lib/utils'

type View = 'home' | 'agent' | 'browsers'

const formatTime = (iso: string) => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function App() {
  const [view, setView] = useState<View>('home')
  const [agents, setAgents] = useState<Agent[]>([])
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Agent | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [model, setModel] = useState<{ providerID: string; modelID: string } | null>(
    () => getSavedModel(),
  )

  const refreshAgents = useCallback(async () => {
    try {
      setAgents(await api.listAgents())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    refreshAgents()
  }, [refreshAgents])

  useEffect(() => {
    if (model) return
    api
      .listModels()
      .then(({ current }) => setModel(current))
      .catch(() => {})
  }, [model])

  async function handleCreateAgent(prompt: string, mode?: 'playwright' | 'agent-browser') {
    setError(null)
    try {
      const agent = await api.createAgent(prompt, model ?? undefined, mode)
      await refreshAgents()
      setActiveAgentId(agent.id)
      setView('agent')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    setError(null)
    try {
      await api.deleteAgent(pendingDelete.id)
      setAgents((prev) => prev.filter((a) => a.id !== pendingDelete.id))
      if (activeAgentId === pendingDelete.id) {
        setActiveAgentId(null)
        setView('home')
      }
      setPendingDelete(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  const activeAgent = agents.find((a) => a.id === activeAgentId) ?? null
  const layout = useDefaultLayout({ id: 'cloud-browser-layout' })

  return (
    <div className="h-screen bg-background text-foreground">
      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <ResizablePanel defaultSize="16" minSize="12" maxSize="30">
          <aside className="flex h-full flex-col border-r bg-card">
        <div className="flex items-center gap-3 p-4">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Globe className="size-5" />
          </div>
          <div>
            <h1 className="font-heading text-base font-medium">Cloud Browser</h1>
            <p className="text-xs text-muted-foreground">云端浏览器</p>
          </div>
        </div>
        <Separator />

        <div className="p-4">
          <Button
            className="w-full"
            onClick={() => {
              setActiveAgentId(null)
              setView('home')
            }}
          >
            <Plus />
            New Agent
          </Button>
        </div>

        <nav className="px-4 pb-2">
          <button
            onClick={() => setView('browsers')}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
              view === 'browsers'
                ? 'bg-accent font-medium'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <MonitorPlay className="size-4" />
            Browsers
          </button>
        </nav>

        <div className="flex-1 space-y-1 overflow-y-auto px-4 pb-4">
          <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">History</p>
          {agents.length === 0 ? (
            <p className="px-1 py-4 text-center text-xs text-muted-foreground">暂无会话</p>
          ) : (
            agents.map((agent) => (
              <div
                key={agent.id}
                className={cn(
                  'group flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors',
                  agent.id === activeAgentId && view === 'agent'
                    ? 'bg-accent'
                    : 'hover:bg-accent/50',
                )}
              >
                <button
                  onClick={() => {
                    setActiveAgentId(agent.id)
                    setView('agent')
                  }}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-sm">{agent.title}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatTime(agent.createdAt)}
                  </p>
                </button>
                <button
                  onClick={() => setPendingDelete(agent)}
                  className="hidden rounded p-1 text-muted-foreground hover:text-destructive group-hover:block"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        {error && (
          <div className="border-t p-4">
            <p className="break-words rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          </div>
        )}
          </aside>
        </ResizablePanel>
        <ResizableHandle withHandle />

        <ResizablePanel defaultSize="84">
          <main className="flex h-full min-w-0 flex-col overflow-hidden">
            {view === 'home' && (
              <AgentHome
                onSubmit={handleCreateAgent}
                model={model}
                onModelChange={setModel}
              />
            )}
            {view === 'agent' && activeAgent && (
              <AgentSession
                key={activeAgent.id}
                agent={activeAgent}
                onAgentUpdated={refreshAgents}
                model={model}
                onModelChange={setModel}
              />
            )}
            {view === 'browsers' && <BrowserManager />}
          </main>
        </ResizablePanel>
      </ResizablePanelGroup>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除会话</DialogTitle>
            <DialogDescription>
              确定要删除会话「{pendingDelete?.title}」吗？关联的云端浏览器也会被销毁。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default App
