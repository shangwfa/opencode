import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"

const DEFAULT_SHARE = 52
const MIN_PANE_WIDTH = 320

export function BrowserWorkspaceSplit({ chat, panel, showPanel }: { chat: ReactNode; panel: ReactNode; showPanel: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  const chatID = useId()
  const pointer = useRef<number | null>(null)
  const [requested, setRequested] = useState(DEFAULT_SHARE)
  const [width, setWidth] = useState(0)
  const [dragging, setDragging] = useState(false)
  const minimum = width > 1 ? Math.min(MIN_PANE_WIDTH, (width - 1) / 2) : 0
  const min = width > 1 ? minimum / width * 100 : 0
  const max = width > 1 ? (width - minimum - 1) / width * 100 : 100
  const share = Math.min(max, Math.max(min, requested))

  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => setWidth(element.getBoundingClientRect().width)
    measure()
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [])

  return (
    <div
      ref={container}
      className="cdp-session-layout flex min-h-0 flex-1 flex-col"
      data-resizing={dragging || undefined}
      style={{ "--cdp-chat-share": `${share}%` } as CSSProperties}
    >
      <div id={chatID} className={`cdp-chat-pane min-h-0 min-w-0 flex-1 flex-col ${showPanel ? "hidden xl:flex" : "flex"}`}>{chat}</div>
      <div
        role="separator"
        aria-label="调整聊天与浏览器面板宽度"
        aria-orientation="vertical"
        aria-controls={chatID}
        aria-valuemin={Math.round(min)}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(share)}
        aria-valuetext={`聊天 ${Math.round(share)}%，浏览器 ${100 - Math.round(share)}%`}
        tabIndex={0}
        className="cdp-resize-handle hidden xl:block"
        onDoubleClick={() => setRequested(DEFAULT_SHARE)}
        onPointerDown={(event) => {
          if (event.button !== 0 || pointer.current !== null) return
          event.preventDefault()
          event.currentTarget.focus({ preventScroll: true })
          pointer.current = event.pointerId
          event.currentTarget.setPointerCapture?.(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={(event) => {
          if (pointer.current !== event.pointerId || !container.current) return
          const rect = container.current.getBoundingClientRect()
          if (rect.width <= 1) return
          const rtl = getComputedStyle(container.current).direction === "rtl"
          const position = rtl ? rect.right - event.clientX : event.clientX - rect.left
          setRequested(Math.min(max, Math.max(min, position / rect.width * 100)))
        }}
        onPointerUp={(event) => {
          if (pointer.current !== event.pointerId) return
          pointer.current = null
          setDragging(false)
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => { pointer.current = null; setDragging(false) }}
        onLostPointerCapture={() => { pointer.current = null; setDragging(false) }}
        onKeyDown={(event) => {
          const rtl = container.current && getComputedStyle(container.current).direction === "rtl"
          const delta = (event.key === "ArrowLeft" ? -2 : event.key === "ArrowRight" ? 2 : 0) * (rtl ? -1 : 1)
          if (!delta && event.key !== "Home" && event.key !== "End") return
          event.preventDefault()
          setRequested(event.key === "Home" ? min : event.key === "End" ? max : Math.min(max, Math.max(min, share + delta)))
        }}
      />
      <aside
        className={`cdp-tool-panel min-h-0 min-w-0 flex-1 flex-col ${showPanel ? "flex" : "hidden xl:flex"}`}
        aria-label="浏览器工具面板"
      >{panel}</aside>
    </div>
  )
}
