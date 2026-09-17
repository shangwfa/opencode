import { useRef, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Loader2,
  MonitorPlay,
  Plus,
  RefreshCw,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCdpViewer } from "@/useCdpViewer"
import { cn } from "@/lib/utils"

const BTN_NAME = ["left", "middle", "right"] as const

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function BrowserView({ sessionId }: { sessionId: string }) {
  const v = useCdpViewer(sessionId)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const lastClick = useRef({ t: 0, x: 0, y: 0, count: 0 })
  const mouseButtons = useRef(0)
  const [addressDraft, setAddressDraft] = useState<string | null>(null)

  const pageXY = (e: { clientX: number; clientY: number }) => {
    const img = imgRef.current
    if (!img || !v.frame) return { x: 0, y: 0 }
    const rect = img.getBoundingClientRect()
    return {
      x: Math.round(((e.clientX - rect.left) * v.frame.width) / rect.width),
      y: Math.round(((e.clientY - rect.top) * v.frame.height) / rect.height),
    }
  }

  const modifiers = (e: React.MouseEvent | React.WheelEvent) =>
    (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const { x, y } = pageXY(e)
    const now = performance.now()
    const near = Math.hypot(e.clientX - lastClick.current.x, e.clientY - lastClick.current.y) < 8
    const clickCount = now - lastClick.current.t < 400 && near ? lastClick.current.count + 1 : 1
    lastClick.current = { t: now, x: e.clientX, y: e.clientY, count: clickCount }
    mouseButtons.current |= 1 << e.button
    v.dispatchMouse("mousePressed", x, y, {
      button: BTN_NAME[e.button] ?? "left",
      buttons: mouseButtons.current,
      clickCount,
      modifiers: modifiers(e),
    })
  }

  const handleMouseUp = (e: React.MouseEvent) => {
    const { x, y } = pageXY(e)
    mouseButtons.current &= ~(1 << e.button)
    v.dispatchMouse("mouseReleased", x, y, {
      button: BTN_NAME[e.button] ?? "left",
      buttons: mouseButtons.current,
      clickCount: lastClick.current.count || 1,
      modifiers: modifiers(e),
    })
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    const { x, y } = pageXY(e)
    v.dispatchMouse("mouseMoved", x, y, { buttons: e.buttons, modifiers: modifiers(e) })
  }

  const handleWheel = (e: React.WheelEvent) => {
    const { x, y } = pageXY(e)
    v.dispatchMouse("mouseWheel", x, y, { deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiers(e) })
  }

  const printable = (e: KeyboardEvent) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return
    e.preventDefault()
    const native = e.nativeEvent
    if (printable(native)) v.dispatchKey("keyDown", native, { text: native.key })
    else if (native.key === "Enter") v.dispatchKey("keyDown", native, { text: "\r" })
    else v.dispatchKey("rawKeyDown", native)
  }

  const handleKeyUp = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return
    e.preventDefault()
    v.dispatchKey("keyUp", e.nativeEvent)
  }

  const live = v.status === "live"

  return (
    <div className="flex min-h-0 flex-1 flex-col" tabIndex={0} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp}>
      {/* 标签条 */}
      <div className="flex flex-none items-center gap-1 overflow-x-auto border-b bg-card px-2 py-1.5">
        {v.targets.map((t) => {
          const active = t.id === v.currentId
          return (
            <button
              key={t.id}
              onClick={() => v.switchTarget(t.id)}
              className={cn(
                "group flex max-w-44 shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors",
                active ? "border-primary/40 bg-accent font-medium" : "border-transparent text-muted-foreground hover:bg-accent/50",
              )}
              title={t.url}
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", active ? "bg-emerald-500" : "bg-zinc-500")} />
              <span className="truncate">{(t.title || hostOf(t.url) || "无标题").slice(0, 28)}</span>
              <X
                className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation()
                  void v.closeTab(t.id)
                }}
              />
            </button>
          )
        })}
        <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => void v.newTab()}>
          <Plus className="size-4" />
        </Button>
      </div>

      {/* 导航工具栏 */}
      <div className="flex flex-none items-center gap-1.5 border-b bg-card px-2 py-1.5">
        <Button variant="ghost" size="icon" className="size-8" disabled={!live || !v.canGoBack} onClick={() => void v.goBack()} title="后退">
          <ArrowLeft className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" disabled={!live || !v.canGoForward} onClick={() => void v.goForward()} title="前进">
          <ArrowRight className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" disabled={!live} onClick={v.reload} title="刷新">
          <RefreshCw className="size-4" />
        </Button>
        <form
          className="flex min-w-0 flex-1 items-center"
          onSubmit={(e) => {
            e.preventDefault()
            if (addressDraft?.trim()) v.navigate(addressDraft.trim())
            setAddressDraft(null)
          }}
        >
          <Input
            className="h-8 text-xs"
            placeholder="输入 URL 导航"
            value={addressDraft ?? v.currentUrl}
            onChange={(e) => setAddressDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
        </form>
        <Button variant="ghost" size="icon" className="size-8" disabled={!live} onClick={() => void v.screenshot()} title="截图下载">
          <Camera className="size-4" />
        </Button>
      </div>

      {v.error && <div className="flex-none bg-destructive/10 px-3 py-1 text-xs text-destructive">{v.error}</div>}

      {/* 画面 */}
      <main className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
        {v.frame ? (
          <img
            ref={imgRef}
            src={v.frame.dataUrl}
            alt="browser frame"
            draggable={false}
            style={{ width: "auto", height: "auto", maxWidth: "100%", maxHeight: "100%" }}
            className="block select-none"
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseMove={handleMouseMove}
            onWheel={handleWheel}
            onContextMenu={(e) => e.preventDefault()}
          />
        ) : (
          <div className="flex flex-col items-center gap-3 text-zinc-600">
            {v.status === "connecting" ? (
              <Loader2 className="size-8 animate-spin" />
            ) : (
              <MonitorPlay className="size-10" />
            )}
            <p className="text-sm">{v.status === "connecting" ? "正在连接沙箱浏览器…" : "等待画面…"}</p>
          </div>
        )}
        {v.status === "down" && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/90">
            <div className="flex flex-col items-center gap-3">
              <MonitorPlay className="size-10 text-destructive" />
              <p className="text-sm text-muted-foreground">连接已断开，正在自动重连…</p>
            </div>
          </div>
        )}
      </main>

      {/* 状态栏 */}
      <div className="flex flex-none items-center gap-3 border-t bg-card px-3 py-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className={cn("size-2 rounded-full", live ? "bg-emerald-500" : v.status === "down" ? "bg-red-500" : "bg-amber-500")} />
          {live ? "已连接" : v.status === "down" ? "已断开" : "连接中"}
        </span>
        {v.frame && (
          <span>
            {v.frame.width}×{v.frame.height}
          </span>
        )}
        <span className="ml-auto">{v.fps} 帧/10s</span>
      </div>
    </div>
  )
}
