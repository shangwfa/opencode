import { Link } from "react-router"
import { ArrowUpRight, History, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { browserApi } from "@/lib/browser"
import { useBrowserWorkspace } from "./layout"

export function CdpHistory() {
  const { sessions, refresh } = useBrowserWorkspace()
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const remove = async (id: string) => {
    if (!window.confirm("删除该任务并销毁关联沙箱？此操作不可撤销。")) return
    setBusy(id)
    setError("")
    try {
      await browserApi.remove(id)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy("")
    }
  }
  const filtered = sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()))
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5 md:p-8">
      <header className="mb-7 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">历史任务</h1>
          <p className="mt-2 text-sm text-muted-foreground">回到之前的浏览器工作区，继续未完成的任务。</p>
        </div>
        <Button asChild size="sm" className="gap-2">
          <Link to="/cdp">
            <Plus className="size-4" />
            新任务
          </Link>
        </Button>
      </header>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-5 max-w-sm"
        placeholder="搜索任务…"
        aria-label="搜索浏览器历史任务"
      />
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="divide-y rounded-xl border">
        {filtered.map((session) => (
          <div key={session.id} className="group flex items-center gap-4 px-4 py-4">
            <History className="hidden size-4 shrink-0 text-muted-foreground sm:block" />
            <Link className="min-w-0 flex-1" to={`/cdp/session/${session.id}`}>
              <span className="block truncate text-sm font-medium">{session.title}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {new Date(session.timeCreated).toLocaleString()}
              </span>
            </Link>
            <Button variant="ghost" size="icon" aria-label="打开任务" asChild>
              <Link to={`/cdp/session/${session.id}`}>
                <ArrowUpRight className="size-4" />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={!!busy}
              aria-label={`删除任务 ${session.title}`}
              onClick={() => void remove(session.id)}
            >
              <Trash2 className="size-4 text-muted-foreground" />
            </Button>
          </div>
        ))}
        {!filtered.length && (
          <p className="p-10 text-center text-sm text-muted-foreground">
            {query ? "没有匹配的任务" : "还没有浏览器任务"}
          </p>
        )}
      </div>
    </div>
  )
}
