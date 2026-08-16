import { Plus, Trash2 } from 'lucide-react'
import type { SessionRecord } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface Props {
  sessions: SessionRecord[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

export default function Sidebar({ sessions, activeId, onSelect, onNew, onDelete }: Props) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-muted/30">
      <div className="p-3">
        <Button className="w-full justify-start gap-2" onClick={onNew}>
          <Plus className="size-4" />
          新建会话
        </Button>
      </div>
      <div className="flex items-center justify-between px-4 pb-1 pt-2">
        <span className="text-xs font-medium text-muted-foreground">会话历史</span>
        <span className="text-xs text-muted-foreground">{sessions.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            还没有会话，输入需求开始第一张图
          </p>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={cn(
              'group mb-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent',
              activeId === s.id && 'bg-accent',
            )}
            onClick={() => onSelect(s.id)}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate">{s.title}</div>
              <div className="text-xs text-muted-foreground">
                {new Date(s.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
            <button
              className="opacity-0 transition-opacity group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(s.id)
              }}
            >
              <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
            </button>
          </div>
        ))}
      </div>
    </aside>
  )
}
