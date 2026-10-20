import { useMemo, useState } from "react"
import { ChevronRight, FileText, Plus, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { requirementStatus } from "@/lib/requirement-status"
import { selectAppRequirements, type AppRequirement } from "@/lib/app-requirements"
import { cn } from "@/lib/utils"

export function AppRequirements({ items, onCreate, onOpen }: {
  items: AppRequirement[]
  onCreate: () => void
  onOpen: (sessionId: string) => void
}) {
  const [query, setQuery] = useState("")
  const filtered = useMemo(() => selectAppRequirements(items, query), [items, query])
  return (
    <section className="mx-auto w-full max-w-4xl px-6 py-6" aria-label="当前应用的需求管理">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">需求管理</h1>
          <p className="text-muted-foreground mt-1.5 text-[13px]">当前应用的全部需求 · {items.length} 个</p>
        </div>
        <Button onClick={onCreate} className="gap-1.5"><Plus className="size-4" />创建需求</Button>
      </header>
      <div className="relative mb-4">
        <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2" />
        <Input aria-label="搜索当前应用需求" placeholder="搜索需求标题或 ID…" value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 pl-9" />
      </div>
      <p role="status" className="text-muted-foreground mb-3 text-[12px]">{query.trim() ? `找到 ${filtered.length} 个需求` : `共 ${filtered.length} 个需求`}</p>
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <FileText className="text-muted-foreground mx-auto mb-3 size-5" />
          <p className="text-[13px] font-medium">{query.trim() ? "没有匹配的需求" : "还没有需求"}</p>
          <p className="text-muted-foreground mt-1 text-xs">{query.trim() ? "换个关键词试试" : "创建需求后，在新对话中描述开发目标"}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border" aria-label="全部需求">
          {filtered.map((item, index) => {
            const status = requirementStatus(item.status)
            return (
              <button key={item.id} type="button" disabled={!item.sessionId} onClick={() => item.sessionId && onOpen(item.sessionId)}
                className={cn("hover:bg-muted/40 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors disabled:cursor-default", index > 0 && "border-t")}>
                <span className={cn("size-1.5 shrink-0 rounded-full", status.dot)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{item.title || "未命名需求"}</span>
                  <span className="text-muted-foreground mt-1 block text-[11px]">{status.label}{!item.sessionId && " · 无会话"}</span>
                </span>
                <time className="text-muted-foreground shrink-0 text-[11px] tabular-nums" dateTime={new Date(item.timeUpdated).toISOString()}>{new Date(item.timeUpdated).toLocaleDateString("zh-CN")}</time>
                {item.sessionId && <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />}
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
