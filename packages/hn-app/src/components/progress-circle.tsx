/**
 * 百分比圆环（源项目 src/ui/components/progress-circle）。
 * 纯 SVG：轨道 + 进度弧（stroke-dasharray 控制），percentage 0-100。
 */
import { cn } from "@/lib/utils"

export function ProgressCircle({
  percentage,
  size = 64,
  strokeWidth = 5,
  className,
  children,
}: {
  percentage: number
  size?: number
  strokeWidth?: number
  className?: string
  children?: React.ReactNode
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percentage) ? percentage : 0))
  const r = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * r
  const offset = circumference * (1 - clamped / 100)
  return (
    <div
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`完成率 ${Math.round(clamped)}%`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-muted"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="stroke-emerald-500 transition-[stroke-dashoffset] duration-500 ease-out"
        />
      </svg>
      {children ? <div className="absolute inset-0 flex items-center justify-center">{children}</div> : null}
    </div>
  )
}