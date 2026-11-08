import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { ArrowLeft, ArrowRight, Keyboard, Lock, Maximize2, Monitor, Plus, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { normalizeBrowserUrl } from "@/lib/browser"
import { cn } from "@/lib/utils"
import { useCdpViewer } from "./use-cdp-viewer"

export function browserCoordinates(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  width: number,
  height: number,
) {
  return {
    x: Math.max(0, Math.min(width - 1, Math.round(((clientX - rect.left) * width) / rect.width))),
    y: Math.max(0, Math.min(height - 1, Math.round(((clientY - rect.top) * height) / rect.height))),
  }
}

export function BrowserPanel({
  sessionId,
  working = false,
  onTakeover,
}: {
  sessionId: string
  working?: boolean
  onTakeover?: () => Promise<unknown>
}) {
  const viewer = useCdpViewer(sessionId)
  const [address, setAddress] = useState("")
  const [inputError, setInputError] = useState("")
  const [control, setControl] = useState(false)
  const [takingOver, setTakingOver] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const keyboard = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const dragging = useRef(false)
  const moving = useRef(false)
  const queue = useRef(Promise.resolve())
  const send = (method: string, params: Record<string, unknown>) => {
    // 保持 press/release、键盘输入顺序；不在进程内保存跨请求连接（多 pod 无亲和）。
    queue.current = queue.current
      .then(async () => {
        await viewer.command(method, params)
      })
      .catch(() => {})
  }
  useEffect(() => setAddress(viewer.url), [viewer.url])
  useEffect(() => {
    if (working) setControl(false)
  }, [working])

  const pointer = (event: PointerEvent<HTMLImageElement>, type: string) => {
    if (!control || !image.current) return
    event.preventDefault()
    keyboard.current?.focus({ preventScroll: true })
    dragging.current = type === "mousePressed"
    const point = browserCoordinates(
      event.clientX,
      event.clientY,
      image.current.getBoundingClientRect(),
      viewer.frame?.metadata?.deviceWidth ?? image.current.naturalWidth,
      viewer.frame?.metadata?.deviceHeight ?? image.current.naturalHeight,
    )
    send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
      clickCount: 1,
    })
  }
  const key = (event: KeyboardEvent<HTMLDivElement>, type: string) => {
    if (!control || composing.current || event.nativeEvent.isComposing || event.key === "Tab") return
    // 保留本地粘贴默认动作，由 onPaste 将剪贴板文本送到远端输入框。
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return
    event.preventDefault()
    send("Input.dispatchKeyEvent", {
      type,
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.keyCode,
      modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0),
      ...(type === "keyDown" && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
        ? { text: event.key }
        : {}),
    })
  }
  const action = async (fn: () => Promise<unknown>) => {
    try {
      setInputError("")
      await fn()
    } catch (cause) {
      setInputError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const statusLabel = control
    ? "接管中 · AI 已暂停"
    : working
      ? "AI 操作中"
      : viewer.status === "unavailable"
        ? "无浏览器"
        : viewer.status === "connecting"
          ? "正在连接"
          : "实时观察"
  const statusTone = control ? "bg-primary" : working ? "bg-emerald-500" : "bg-muted-foreground/40"
  const secure = viewer.url.startsWith("https://")

  return (
    <section className="cdp-browser flex min-h-0 min-w-0 flex-1 flex-col" aria-label="沙箱浏览器">
      <div className="cdp-browser-tabs flex items-center gap-1 overflow-x-auto px-3 pt-3 pb-2" aria-label="标签页">
        {viewer.targets.map((tab) => {
          const active = tab.id === viewer.target
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex h-8 min-w-28 max-w-48 shrink-0 items-center rounded-lg pr-1 text-xs transition-colors",
                active
                  ? "bg-card text-foreground shadow-xs ring-1 ring-border"
                  : "text-muted-foreground hover:bg-card/70 hover:text-foreground",
              )}
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate px-2.5 text-left"
                title={tab.url}
                aria-current={active ? "page" : undefined}
                onClick={() => viewer.setTarget(tab.id)}
              >
                {tab.title || "新标签页"}
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0 opacity-50 group-hover:opacity-100"
                aria-label="关闭标签页"
                onClick={() => void action(() => viewer.closeTab(tab.id))}
              >
                <X className="size-3" />
              </Button>
            </div>
          )
        })}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-lg text-muted-foreground"
          aria-label="新建标签页"
          onClick={() => void action(() => viewer.openTab("https://example.com"))}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      <form
        className="flex items-center gap-1.5 px-3 pb-2"
        onSubmit={(e) => {
          e.preventDefault()
          void action(async () => {
            const url = normalizeBrowserUrl(address)
            if (viewer.target) await viewer.command("Page.navigate", { url })
            else await viewer.openTab(url)
          })
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full text-muted-foreground"
          aria-label="后退"
          disabled={viewer.history.currentIndex <= 0}
          onClick={() =>
            void viewer.command("Page.navigateToHistoryEntry", {
              entryId: viewer.history.entries[viewer.history.currentIndex - 1]?.id,
            })
          }
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full text-muted-foreground"
          aria-label="前进"
          disabled={viewer.history.currentIndex >= viewer.history.entries.length - 1}
          onClick={() =>
            void viewer.command("Page.navigateToHistoryEntry", {
              entryId: viewer.history.entries[viewer.history.currentIndex + 1]?.id,
            })
          }
        >
          <ArrowRight className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full text-muted-foreground"
          aria-label="刷新页面"
          onClick={() => void viewer.command("Page.reload")}
        >
          <RefreshCw className="size-3.5" />
        </Button>
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-muted/70 px-3 transition-colors focus-within:bg-card focus-within:ring-1 focus-within:ring-ring/30">
          {secure && <Lock className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
          <Input
            aria-label="浏览器地址"
            className="h-7 min-w-0 flex-1 border-0 bg-transparent px-0 text-[13px] shadow-none focus-visible:ring-0"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="输入网址或搜索"
          />
        </label>
        <Button
          type="button"
          variant={control ? "default" : "outline"}
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-full px-3 text-xs"
          aria-label={control ? "退出接管" : "接管浏览器"}
          title={control ? "退出接管" : "接管浏览器"}
          aria-pressed={control}
          disabled={takingOver}
          onClick={() =>
            void action(async () => {
              setTakingOver(true)
              try {
                if (!control) await onTakeover?.()
                setControl((value) => !value)
              } finally {
                setTakingOver(false)
              }
            })
          }
        >
          <Keyboard className="size-3.5" />
          {control ? "退出接管" : "接管"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full text-muted-foreground"
          aria-label="全屏浏览器"
          onClick={() => void container.current?.requestFullscreen().catch(() => {})}
        >
          <Maximize2 className="size-3.5" />
        </Button>
      </form>
      {viewer.status === "connecting" && <div className="mx-3 mb-2 h-0.5 animate-pulse rounded-full bg-primary/50" aria-hidden />}
      {viewer.status === "unavailable" && (
        <div className="mx-3 mb-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          本会话没有浏览器环境。通过接口或脚本创建的任务只使用沙箱工作区，不启动浏览器；需要操作网页请从「开始任务」新建任务。
        </div>
      )}
      {viewer.status !== "unavailable" && (inputError || viewer.error) && (
        <div role="alert" className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          <span className="min-w-0 flex-1 break-words">{inputError || viewer.error}</span>
          <Button variant="outline" size="sm" onClick={viewer.restart}>
            重连
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
        <div
          ref={container}
          tabIndex={control ? 0 : -1}
          role="region"
          aria-label="浏览器画面，接管后可点击和输入"
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border bg-card shadow-xs outline-offset-[-2px]"
          onKeyDown={(e) => key(e, "keyDown")}
          onKeyUp={(e) => key(e, "keyUp")}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={(e) => {
            composing.current = false
            if (control && e.data) send("Input.insertText", { text: e.data })
            if (keyboard.current) keyboard.current.value = ""
          }}
          onPaste={(e) => {
            if (control) {
              e.preventDefault()
              send("Input.insertText", { text: e.clipboardData.getData("text/plain") })
            }
          }}
        >
          <textarea
            ref={keyboard}
            tabIndex={control ? 0 : -1}
            disabled={!control}
            aria-label="浏览器远程键盘输入"
            className="sr-only"
            onBlur={(e) => {
              e.currentTarget.value = ""
            }}
          />
          {viewer.frame ? (
            <img
              ref={image}
              src={`data:image/jpeg;base64,${viewer.frame.data}`}
              alt="沙箱浏览器实时画面"
              draggable={false}
              className={`h-full w-full select-none object-contain ${control ? "cursor-crosshair" : "cursor-default"}`}
              onPointerDown={(e) => {
                if (control) e.currentTarget.setPointerCapture(e.pointerId)
                pointer(e, "mousePressed")
              }}
              onPointerUp={(e) => pointer(e, "mouseReleased")}
              onContextMenu={(e) => e.preventDefault()}
              onPointerMove={(e) => {
                if (!control || !image.current || moving.current) return
                moving.current = true
                const point = browserCoordinates(
                  e.clientX,
                  e.clientY,
                  image.current.getBoundingClientRect(),
                  viewer.frame?.metadata?.deviceWidth ?? image.current.naturalWidth,
                  viewer.frame?.metadata?.deviceHeight ?? image.current.naturalHeight,
                )
                const pressed = dragging.current
                queue.current = queue.current
                  .then(async () => {
                    await viewer.command("Input.dispatchMouseEvent", {
                      type: "mouseMoved",
                      ...point,
                      button: pressed ? "left" : "none",
                      buttons: pressed ? 1 : 0,
                    })
                  })
                  .catch(() => {})
                  .finally(() => {
                    moving.current = false
                  })
              }}
              onWheel={(e) => {
                if (!control || !image.current) return
                const point = browserCoordinates(
                  e.clientX,
                  e.clientY,
                  image.current.getBoundingClientRect(),
                  viewer.frame?.metadata?.deviceWidth ?? image.current.naturalWidth,
                  viewer.frame?.metadata?.deviceHeight ?? image.current.naturalHeight,
                )
                send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: e.deltaX, deltaY: e.deltaY })
              }}
            />
          ) : (
            <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
              <Monitor className="size-8" strokeWidth={1.5} />
              <p>
                {viewer.status === "unavailable"
                  ? "本会话未启动浏览器"
                  : viewer.status === "empty"
                    ? "输入地址以打开标签页"
                    : "等待浏览器画面…"}
              </p>
            </div>
          )}
          <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-card/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow-xs backdrop-blur">
            <span className={cn("size-1.5 rounded-full", statusTone)} aria-hidden />
            {statusLabel}
          </div>
        </div>
      </div>
    </section>
  )
}
