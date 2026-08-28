import { useEffect, useRef, useState, type RefObject } from "react"
import type { Frame } from "@/useCdpViewer"

interface ScreenProps {
  frame: Frame | null
  imgRef: RefObject<HTMLImageElement | null>
  onMouseDown: (e: React.MouseEvent) => void
  onMouseUp: (e: React.MouseEvent) => void
  onMouseMove: (e: React.MouseEvent) => void
  onWheel: (e: React.WheelEvent) => void
}

// 画面展示：img 尺寸 = 帧等比缩放结果（无黑边），事件坐标映射无需处理 letterbox
export function Screen({ frame, imgRef, onMouseDown, onMouseUp, onMouseMove, onWheel }: ScreenProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const fit = () => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      setBox({ w: rect.width, h: rect.height })
    }
    fit()
    window.addEventListener("resize", fit)
    return () => window.removeEventListener("resize", fit)
  }, [])

  let style: React.CSSProperties = {}
  if (frame && box.w && box.h) {
    const scale = Math.min(box.w / frame.width, box.h / frame.height)
    style = { width: Math.max(1, Math.floor(frame.width * scale)), height: Math.max(1, Math.floor(frame.height * scale)) }
  }

  return (
    <main ref={containerRef} className="flex min-h-0 flex-1 items-center justify-center bg-black">
      {frame ? (
        <img
          ref={imgRef}
          src={frame.dataUrl}
          alt="browser frame"
          draggable={false}
          style={style}
          className="block select-none"
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onMouseMove={onMouseMove}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        />
      ) : (
        <div className="text-sm text-zinc-600">等待画面…</div>
      )}
    </main>
  )
}
