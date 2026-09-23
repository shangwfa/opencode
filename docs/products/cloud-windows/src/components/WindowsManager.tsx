import { useCallback, useEffect, useState } from 'react'
import { MonitorPlay, Plus, RefreshCw, Trash2 } from 'lucide-react'
import WindowsScreen from './WindowsScreen'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Card, CardContent } from './ui/card'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup, useDefaultLayout } from './ui/resizable'
import { cn } from '../lib/utils'

interface Sandbox {
  id: string
  createdAt: string
  status: string
}

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

export default function WindowsManager() {
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const res = await fetch('/api/sandboxes')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    setSandboxes((await res.json()) as Sandbox[])
  }, [])

  useEffect(() => {
    refresh().catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    )
  }, [refresh])

  async function createSandbox() {
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/sandboxes', { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const sandbox = (await res.json()) as Sandbox
      setSandboxes((prev) => [sandbox, ...prev])
      setActiveId(sandbox.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  async function deleteSandbox(id: string) {
    setError(null)
    try {
      const res = await fetch(`/api/sandboxes/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      setSandboxes((prev) => prev.filter((s) => s.id !== id))
      if (activeId === id) setActiveId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const layout = useDefaultLayout({ id: 'windows-manager-layout' })

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      className="flex-1"
    >
      <ResizablePanel defaultSize="22" minSize="15" maxSize="40">
        <div className="flex h-full flex-col border-r">
        <div className="p-3">
          <Button
            variant="outline"
            onClick={createSandbox}
            disabled={creating}
            className="w-full"
          >
            {creating ? (
              <>
                <RefreshCw className="size-4 animate-spin" />
                创建中...
              </>
            ) : (
              <>
                <Plus />
                新建 Windows
              </>
            )}
          </Button>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-3">
          {sandboxes.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">暂无 Windows 沙箱</p>
          ) : (
            sandboxes.map((sandbox) => (
              <div
                key={sandbox.id}
                className={cn(
                  'group rounded-lg border p-2.5 transition-colors',
                  sandbox.id === activeId && 'bg-accent',
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs">{sandbox.id.slice(0, 12)}</span>
                  <Badge variant="secondary" className="gap-1">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    运行中
                  </Badge>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {formatTime(sandbox.createdAt)}
                </p>
                <div className="mt-2 flex gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 flex-1 text-xs"
                    onClick={() => setActiveId(sandbox.id)}
                  >
                    连接
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => deleteSandbox(sandbox.id)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
        {error && (
          <div className="border-t p-3">
            <p className="break-words rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          </div>
        )}
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />

      <ResizablePanel defaultSize="78">
        <div className="flex h-full flex-col overflow-hidden">
          {activeId ? (
            <WindowsScreen sandboxId={activeId} />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <Card className="border-none shadow-none">
                <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                  <div className="flex size-14 items-center justify-center rounded-2xl bg-muted">
                    <MonitorPlay className="size-7 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    创建或选择一个 Windows 沙箱，通过 noVNC 操控 Windows 桌面
                  </p>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
