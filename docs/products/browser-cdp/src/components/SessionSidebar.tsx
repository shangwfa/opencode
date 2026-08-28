import { useState } from "react"
import { Loader2, MonitorPlay, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { Config, SessionEntry } from "@/lib/api"

interface SessionSidebarProps {
  sessions: SessionEntry[]
  currentSid: string
  config: Config | null
  image: string
  onImageChange: (v: string) => void
  busy: string | null
  message: string | null
  ready: boolean
  onClearMessage: () => void
  onSelect: (sid: string) => void
  onCreate: () => void
  onStart: () => void
  onStop: () => void
  onKill: () => void
}

const formatTime = (ts: number | null) => {
  if (!ts) return ""
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

const shortImage = (image?: string) => image?.split("/").pop() ?? ""

export function SessionSidebar(props: SessionSidebarProps) {
  const [pendingDelete, setPendingDelete] = useState(false)

  const current = props.sessions.find((s) => s.id === props.currentSid) ?? null

  return (
    <aside className="flex h-full flex-col border-r bg-card">
      <div className="flex items-center gap-3 p-4">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <MonitorPlay className="size-5" />
        </div>
        <div>
          <h1 className="font-heading text-base font-medium">Browser CDP</h1>
          <p className="text-xs text-muted-foreground">{props.config?.saasBaseUrl.replace(/^https?:\/\//, "") ?? "沙箱浏览器"}</p>
        </div>
      </div>
      <Separator />

      <div className="space-y-2 p-3">
        <Button className="w-full" onClick={props.onCreate} disabled={props.busy !== null}>
          {props.busy === "创建会话" ? <Loader2 className="animate-spin" /> : <Plus />}
          新建会话
        </Button>
        <Input
          className="h-7 text-xs"
          value={props.image}
          onChange={(e) => props.onImageChange(e.target.value)}
          placeholder={props.config?.image}
          title="沙箱镜像"
        />
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-3">
        <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">Sessions</p>
        {props.sessions.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">暂无会话</p>
        ) : (
          props.sessions.map((session) => {
            const active = session.id === props.currentSid
            return (
              <div
                key={session.id}
                className={cn(
                  "group rounded-lg border p-2.5 transition-colors",
                  active ? "border-primary/40 bg-accent" : "hover:bg-accent/50",
                )}
              >
                <button onClick={() => props.onSelect(session.id)} className="w-full text-left">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm">{session.title || session.id}</span>
                    {shortImage(session.sandbox?.image) === shortImage(props.config?.image) && (
                      <Badge variant="secondary" className="shrink-0 gap-1 px-1.5 text-[10px]">
                        <span className="size-1.5 rounded-full bg-emerald-500" />
                        CDP
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">{formatTime(session.timeUpdated)}</p>
                </button>
              </div>
            )
          })
        )}
      </div>

      {props.message && (
        <div className="px-3 pb-2">
          <p className="break-words rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            {props.message}
            <button className="float-right ml-1 text-muted-foreground hover:text-foreground" onClick={props.onClearMessage}>
              ×
            </button>
          </p>
        </div>
      )}

      {props.currentSid && (
        <div className="border-t p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span className="truncate font-mono">{props.currentSid}</span>
            <span className={cn("shrink-0", props.ready ? "text-emerald-500" : "text-zinc-500")}>
              {props.ready ? "CDP 就绪" : "未就绪"}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={props.busy !== null}
              onClick={props.onStart}
            >
              {props.busy === "启动浏览器" ? <Loader2 className="animate-spin" /> : null}
              启动
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={props.busy !== null}
              onClick={props.onStop}
            >
              停止
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground hover:text-destructive"
              disabled={props.busy !== null}
              onClick={() => setPendingDelete(true)}
            >
              <Trash2 className="size-3" />
              销毁
            </Button>
          </div>
        </div>
      )}

      <Dialog open={pendingDelete} onOpenChange={setPendingDelete}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>销毁沙箱</DialogTitle>
            <DialogDescription>
              确定销毁会话「{current?.title || props.currentSid}」的沙箱吗？浏览器与其中数据将被清除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setPendingDelete(false)
                props.onKill()
              }}
            >
              确认销毁
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}
