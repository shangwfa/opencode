import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import type { SessionInfo } from "../types"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface SidebarProps {
  sessions: SessionInfo[]
  activeSessionID: string | null
  localBound: Set<string>
  creating: boolean
  onSelect: (session: SessionInfo) => void
  onCreate: () => void
  onDelete: (sessionID: string) => void
}

export function Sidebar({
  sessions,
  activeSessionID,
  localBound,
  creating,
  onSelect,
  onCreate,
  onDelete,
}: SidebarProps) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <Button onClick={onCreate} disabled={creating} variant="outline" className="w-full justify-start">
        {creating ? (
          <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : (
          <Plus className="size-3.5" />
        )}
        新建会话
      </Button>

      <p className="px-1 text-[11px] font-medium text-muted-foreground">
        会话历史（{sessions.length}）
      </p>

      <div className="flex-1 space-y-0.5 overflow-y-auto">
        {sessions.length === 0 && (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">暂无会话</p>
        )}
        {sessions.map((s) => {
          const active = s.id === activeSessionID
          const confirming = confirmDelete === s.id
          return (
            <div
              key={s.id}
              onClick={() => onSelect(s)}
              className={cn(
                "group relative cursor-pointer rounded-lg px-3 py-2 transition-colors",
                active ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              {active && (
                <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" />
              )}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] leading-5">{s.title}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {new Date(s.timeUpdated || s.timeCreated).toLocaleDateString(undefined, {
                      month: "2-digit",
                      day: "2-digit",
                    })}{" "}
                    {new Date(s.timeUpdated || s.timeCreated).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {localBound.has(s.id) && (
                    <span className="rounded-full bg-emerald-500/15 px-1.5 py-px text-[10px] font-medium text-emerald-600">
                      本地
                    </span>
                  )}
                  {confirming ? (
                    <span className="flex items-center gap-1 text-[11px]">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onDelete(s.id)
                          setConfirmDelete(null)
                        }}
                        className="rounded px-1 py-0.5 text-destructive hover:bg-destructive/10"
                      >
                        确认
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmDelete(null)
                        }}
                        className="rounded px-1 py-0.5 text-muted-foreground hover:bg-accent"
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirmDelete(s.id)
                      }}
                      className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
