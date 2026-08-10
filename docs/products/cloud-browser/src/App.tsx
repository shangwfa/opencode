import { useCallback, useEffect, useState } from 'react'
import { Globe, MonitorPlay, Plus, RefreshCw, Trash2 } from 'lucide-react'
import VncScreen from './components/VncScreen'
import { Button } from './components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog'
import { Badge } from './components/ui/badge'
import { Separator } from './components/ui/separator'
import { cn } from './lib/utils'

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

function App() {
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Sandbox | null>(null)
  const [deleting, setDeleting] = useState(false)

  const refreshList = useCallback(async () => {
    const res = await fetch('/api/sandboxes')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    setSandboxes((await res.json()) as Sandbox[])
  }, [])

  useEffect(() => {
    refreshList().catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    )
  }, [refreshList])

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
      setSandboxes((prev) => [...prev, sandbox])
      setActiveId(sandbox.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/sandboxes/${pendingDelete.id}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      setSandboxes((prev) => prev.filter((s) => s.id !== pendingDelete.id))
      if (activeId === pendingDelete.id) setActiveId(null)
      setPendingDelete(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-card">
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
          <Button onClick={createSandbox} disabled={creating} className="w-full">
            {creating ? (
              <>
                <RefreshCw className="size-4 animate-spin" />
                创建中...
              </>
            ) : (
              <>
                <Plus />
                新建浏览器
              </>
            )}
          </Button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-4">
          <p className="px-1 text-xs font-medium text-muted-foreground">
            会话列表
          </p>
          {sandboxes.length === 0 ? (
            <Card className="mx-1">
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                暂无会话
              </CardContent>
            </Card>
          ) : (
            sandboxes.map((sandbox) => (
              <Card
                key={sandbox.id}
                size="sm"
                className={cn(
                  'transition-colors',
                  sandbox.id === activeId && 'bg-accent',
                )}
              >
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle className="font-mono text-xs">
                    {sandbox.id.slice(0, 12)}
                  </CardTitle>
                  <Badge variant="secondary" className="gap-1">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    运行中
                  </Badge>
                </CardHeader>
                <CardDescription className="px-4">
                  创建于 {formatTime(sandbox.createdAt)}
                </CardDescription>
                <CardContent className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => setActiveId(sandbox.id)}
                  >
                    <MonitorPlay />
                    连接
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setPendingDelete(sandbox)}
                  >
                    <Trash2 />
                  </Button>
                </CardContent>
              </Card>
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

      <main className="flex flex-1 flex-col overflow-hidden">
        {activeId ? (
          <>
            <div className="flex items-center gap-2 border-b bg-card px-4 py-2">
              <span className="size-2 rounded-full bg-emerald-500" />
              <span className="font-mono text-xs text-muted-foreground">
                {activeId}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => setActiveId(null)}
              >
                关闭
              </Button>
            </div>
            <VncScreen sandboxId={activeId} />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Card className="w-full max-w-sm border-none bg-transparent shadow-none">
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <div className="flex size-14 items-center justify-center rounded-2xl bg-muted">
                  <Globe className="size-7 text-muted-foreground" />
                </div>
                <div>
                  <CardTitle className="text-lg">欢迎使用 Cloud Browser</CardTitle>
                  <CardDescription className="mt-1">
                    点击左侧「新建浏览器」创建一个云端 Chrome 沙箱
                  </CardDescription>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </main>

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除沙箱</DialogTitle>
            <DialogDescription>
              确定要删除沙箱{' '}
              <span className="font-mono text-foreground">
                {pendingDelete?.id.slice(0, 12)}
              </span>{' '}
              吗？该操作会销毁云端浏览器，不可撤销。
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
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default App
