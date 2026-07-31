import { MessageSquarePlus, Search, Sparkles, Trash2 } from "lucide-react"
import type { Session } from "../api"

interface SessionsSidebarProps {
  sessions: Session[]
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

export function SessionsSidebar({
  sessions,
  currentId,
  onSelect,
  onNew,
  onDelete,
}: SessionsSidebarProps) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-gray-200/70 bg-white">
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-violet-500">
          <Sparkles className="h-4 w-4 text-white" />
        </div>
        <span className="text-[15px] font-semibold text-gray-900">Skills Test</span>
      </div>

      {/* New Chat */}
      <div className="px-3 pb-3">
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-xl bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          <MessageSquarePlus className="h-4 w-4" />
          新会话
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg bg-gray-100 px-2.5 py-1.5 text-sm text-gray-400">
          <Search className="h-3.5 w-3.5" />
          <span>搜索会话</span>
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        <p className="px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
          最近会话
        </p>
        <div className="space-y-0.5">
          {sessions.map((s) => {
            const active = s.id === currentId
            return (
              <div
                key={s.id}
                className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 transition-colors ${
                  active ? "bg-blue-50 text-blue-700" : "text-gray-600 hover:bg-gray-100"
                }`}
                onClick={() => onSelect(s.id)}
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  {s.title || "Untitled"}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(s.id)
                  }}
                  className="hidden shrink-0 rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-red-500 group-hover:block"
                  title="删除会话"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      </div>

      <div className="border-t border-gray-100 px-4 py-3 text-[11px] text-gray-400">
        localhost:14096
      </div>
    </aside>
  )
}
