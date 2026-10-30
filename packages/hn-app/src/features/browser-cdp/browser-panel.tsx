import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { ArrowLeft, ArrowRight, Plus, RefreshCw, X, Maximize2, Monitor, Keyboard } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { normalizeBrowserUrl } from "@/lib/browser"
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
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/20" aria-label="沙箱浏览器">
      <div className="flex min-h-10 items-center gap-1 overflow-x-auto border-b px-2">
        {viewer.targets.map((tab) => (
          <div
            key={tab.id}
            className={`flex min-w-24 max-w-44 shrink-0 items-center rounded-t-md ${tab.id === viewer.target ? "bg-background" : "text-muted-foreground"}`}
          >
            <button
              className="min-w-0 flex-1 truncate px-2 py-2 text-xs"
              onClick={() => viewer.setTarget(tab.id)}
              title={tab.url}
            >
              {tab.title || "新标签页"}
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              aria-label="关闭标签页"
              onClick={() => void action(() => viewer.closeTab(tab.id))}
            >
              <X className="size-3" />
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="新建标签页"
          onClick={() => void action(() => viewer.openTab("https://example.com"))}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      <form
        className="flex items-center gap-1 border-b bg-background p-2"
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
          className="size-7 shrink-0"
          aria-label="后退"
          disabled={viewer.history.currentIndex <= 0}
          onClick={() =>
            void viewer.command("Page.navigateToHistoryEntry", {
              entryId: viewer.history.entries[viewer.history.currentIndex - 1]?.id,
            })
          }
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="前进"
          disabled={viewer.history.currentIndex >= viewer.history.entries.length - 1}
          onClick={() =>
            void viewer.command("Page.navigateToHistoryEntry", {
              entryId: viewer.history.entries[viewer.history.currentIndex + 1]?.id,
            })
          }
        >
          <ArrowRight className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="刷新页面"
          onClick={() => void viewer.command("Page.reload")}
        >
          <RefreshCw className="size-3.5" />
        </Button>
        <Input
          aria-label="浏览器地址"
          className="h-8 min-w-0 text-xs"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="https://example.com"
        />
        <Button
          type="button"
          variant={control ? "secondary" : "ghost"}
          size="icon"
          className="size-8 shrink-0"
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
          <Keyboard className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="全屏浏览器"
          onClick={() => void container.current?.requestFullscreen().catch(() => {})}
        >
          <Maximize2 className="size-3.5" />
        </Button>
      </form>
      <div className="flex items-center justify-between px-3 py-1 text-[11px] text-muted-foreground">
        <span>
          {viewer.status === "live" ? "实时画面" : viewer.status === "connecting" ? "正在连接…" : "浏览器未连接"}
        </span>
        <span>{control ? "接管中 · AI 已暂停" : "观察模式 · AI 操作实时可见"}</span>
      </div>
      {(inputError || viewer.error) && (
        <div role="alert" className="flex items-center gap-2 border-b p-2 text-xs text-destructive">
          <span className="min-w-0 flex-1 break-words">{inputError || viewer.error}</span>
          <Button variant="outline" size="sm" onClick={viewer.restart}>
            重连
          </Button>
        </div>
      )}
      <div
        ref={container}
        tabIndex={control ? 0 : -1}
        role="region"
        aria-label="浏览器画面，接管后可点击和输入"
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/50 outline-offset-[-2px]"
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
            className={`max-h-full max-w-full select-none object-contain ${control ? "cursor-crosshair" : "cursor-default"}`}
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
            <Monitor className="size-8" />
            <p>{viewer.status === "empty" ? "输入地址以打开标签页" : "等待浏览器画面…"}</p>
          </div>
        )}
      </div>
    </section>
  )
}
