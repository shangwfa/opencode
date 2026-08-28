import { useRef } from "react"
import { useCdpViewer } from "@/useCdpViewer"
import { Toolbar } from "./Toolbar"
import { Screen } from "./Screen"

const BTN_NAME = ["left", "middle", "right"] as const

export function Viewer({ sessionId }: { sessionId: string }) {
  const v = useCdpViewer(sessionId)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const lastClick = useRef({ t: 0, x: 0, y: 0, count: 0 })
  const mouseButtons = useRef(0)

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

  return (
    <div className="flex min-h-0 flex-1 flex-col" tabIndex={0} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp}>
      <Toolbar
        targets={v.targets}
        currentId={v.currentId}
        status={v.status}
        currentUrl={v.currentUrl}
        fps={v.fps}
        onSwitch={v.switchTarget}
        onRefresh={v.refreshTargets}
        onNewTab={v.newTab}
        onCloseTab={() => v.currentId && v.closeTab(v.currentId)}
        onNavigate={v.navigate}
      />
      {v.error && <div className="flex-none bg-red-950 px-3 py-1 text-xs text-red-300">{v.error}</div>}
      <Screen
        frame={v.frame}
        imgRef={imgRef}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseMove={handleMouseMove}
        onWheel={handleWheel}
      />
    </div>
  )
}
