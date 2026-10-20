/**
 * 数字滚动动画（源项目 src/ui/components/animated-number）。
 * 用 requestAnimationFrame + easeOutCubic 让数字从旧值过渡到新值；
 * prefers-reduced-motion 或数值未变化时直接渲染终值，避免无意义动画。
 */
import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

export function AnimatedNumber({
  value,
  className,
  format,
}: {
  value: number
  className?: string
  format?: (n: number) => string
}) {
  const [display, setDisplay] = useState(value)
  const fromRef = useRef(value)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const from = fromRef.current
    const to = value
    if (from === to) return
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      fromRef.current = to
      setDisplay(to)
      return
    }
    const started = performance.now()
    const duration = 380
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      const next = Math.round(from + (to - from) * eased)
      setDisplay(next)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = to
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      fromRef.current = to
    }
  }, [value])

  return <span className={cn("tabular-nums", className)}>{format ? format(display) : display}</span>
}