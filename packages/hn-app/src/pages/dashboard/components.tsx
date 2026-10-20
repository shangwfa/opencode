/**
 * 仪表盘展示组件（React 版）。
 * 源：xybot-front-opencode-ui src/pages/dashboard/components.tsx（Solid）+ dashboard.module.css。
 * 结构与视觉 1:1（hero 状态流水线 / 分布条 / 人员排行 / 趋势柱），样式改为 Tailwind + 主题 token。
 * 颜色沿用源的内联 hex（#1677ff / #faad14 / #52c41a），因为它们编码的是数据语义而非主题色。
 */
import { useMemo, useState } from "react"
import { AnimatedNumber } from "@/components/animated-number"
import { ProgressCircle } from "@/components/progress-circle"
import { cn } from "@/lib/utils"
import type { CreatorStat, DayPoint, KeyValueCount, StatusCount } from "./aggregate"

const DEFAULT_LIMIT = 10

const STATUS_COLORS = {
  open: "#1677ff",
  pending_publish: "#faad14",
  done: "#52c41a",
  other: "#d9d9d9",
} as const

/** 顶部 hero：需求总数 + 状态占比条 + 图例 + 完成率圆环 */
export function StatusPipeline({
  total,
  status,
  completionRate,
}: {
  total: number
  status: StatusCount
  completionRate: number
}) {
  const sum = status.open + status.pending_publish + status.done + status.other
  const pct = (n: number) => (sum > 0 ? (n / sum) * 100 : 0)

  return (
    <section className="bg-card mb-6 flex flex-col gap-4 rounded-xl border p-6 shadow-xs">
      <div className="flex items-baseline gap-3">
        <span className="text-muted-foreground text-[13px] tracking-[0.02em]">需求总数</span>
        <AnimatedNumber value={total} className="text-3xl leading-none font-bold tracking-tight" />
      </div>

      <div
        className="bg-muted flex h-4 gap-0.5 overflow-hidden rounded-lg"
        role="img"
        aria-label={`待处理 ${status.open}，待发布 ${status.pending_publish}，已发布 ${status.done}`}
      >
        {sum > 0 && (
          <>
            <div style={{ width: `${pct(status.open)}%`, background: STATUS_COLORS.open }} />
            <div style={{ width: `${pct(status.pending_publish)}%`, background: STATUS_COLORS.pending_publish }} />
            <div style={{ width: `${pct(status.done)}%`, background: STATUS_COLORS.done }} />
            {status.other > 0 && <div style={{ width: `${pct(status.other)}%`, background: STATUS_COLORS.other }} />}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-6">
        <Legend dot={STATUS_COLORS.open} label="待处理" value={status.open} />
        <Legend dot={STATUS_COLORS.pending_publish} label="待发布" value={status.pending_publish} />
        <Legend dot={STATUS_COLORS.done} label="已发布" value={status.done} />
        <div className="flex items-center gap-3 border-l pl-5">
          <ProgressCircle percentage={completionRate} size={64} strokeWidth={5} />
          <div className="flex flex-col items-start gap-0.5">
            <strong className="text-lg leading-none font-bold tabular-nums">{Math.round(completionRate)}%</strong>
            <span className="text-muted-foreground text-[11px]">完成率</span>
          </div>
        </div>
      </div>
    </section>
  )
}

function Legend({ dot, label, value }: { dot: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="size-2 rounded-full" style={{ background: dot }} />
      <span className="text-muted-foreground text-[13px]">{label}</span>
      <AnimatedNumber value={value} className="text-[13px] font-semibold" />
    </div>
  )
}

/** 横向分布条（状态 / 合并请求 / 仓库分布复用），默认显示 10 项可展开 */
export function DistributionBar({
  items,
  limit = DEFAULT_LIMIT,
  labelWidth = "w-[72px]",
}: {
  items: KeyValueCount[]
  limit?: number
  /** 标签列宽：短标签用默认 72px；仓库等长 URL 需传更宽值，否则会被截断成 "https://git…" */
  labelWidth?: string
}) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? items : items.slice(0, limit)
  const hasMore = items.length > limit
  const max = useMemo(() => Math.max(1, ...items.map((i) => i.value)), [items])

  if (items.length === 0) return <PanelEmpty />

  return (
    <div className="flex flex-col gap-3">
      {visible.map((item) => (
        <div key={item.key} className="flex items-center gap-3">
          <span className={cn("shrink-0 truncate text-[13px] text-muted-foreground", labelWidth)} title={item.label}>
            {item.label}
          </span>
          <div className="bg-muted h-2.5 flex-1 overflow-hidden rounded-full">
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{ width: `${(item.value / max) * 100}%`, background: item.color }}
            />
          </div>
          <span className="w-10 text-right text-[13px] font-semibold tabular-nums">{item.value}</span>
        </div>
      ))}
      {hasMore && (
        <button
          type="button"
          className="text-primary mt-1 self-start text-xs hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "收起" : `展开全部（共 ${items.length} 项）`}
        </button>
      )}
    </div>
  )
}

/** 人员排行（序号 + 姓名 + 完成率 + 条形） */
export function BarRankList({ items, limit = DEFAULT_LIMIT }: { items: CreatorStat[]; limit?: number }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? items : items.slice(0, limit)
  const hasMore = items.length > limit
  const max = useMemo(() => Math.max(1, ...items.map((i) => i.total)), [items])

  if (items.length === 0) return <PanelEmpty />

  return (
    <div className="flex flex-col gap-3.5">
      {visible.map((item, index) => (
        <div key={item.name} className="flex items-center gap-3">
          <span className="text-muted-foreground w-[22px] shrink-0 text-center text-[13px] font-semibold tabular-nums">
            {index + 1}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[13px]">{item.name}</span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {item.done}/{item.total} · {Math.round(item.rate * 100)}%
              </span>
            </div>
            <div className="bg-muted h-2 overflow-hidden rounded-full">
              <div
                className="bg-primary h-full rounded-full transition-[width] duration-300"
                style={{ width: `${(item.total / max) * 100}%` }}
              />
            </div>
          </div>
        </div>
      ))}
      {hasMore && (
        <button
          type="button"
          className="text-primary mt-1 self-start text-xs hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "收起" : `展开全部（共 ${items.length} 人）`}
        </button>
      )}
    </div>
  )
}

/** 趋势柱状图（纯 CSS flex 柱，无图表库依赖） */
export function TrendChart({ points }: { points: DayPoint[] }) {
  const max = useMemo(() => Math.max(1, ...points.map((p) => p.count)), [points])

  if (points.length === 0) return <PanelEmpty text="暂无趋势数据" />

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex h-[208px] items-end justify-center gap-1 overflow-x-auto border-b pt-7">
        {points.map((p) => (
          <div
            key={p.date}
            className="group flex h-full max-w-8 min-w-1.5 flex-1 items-end justify-center"
            title={`${p.date}：${p.count} 个`}
          >
            <div
              className="bg-primary group-hover:bg-primary/85 relative min-h-[3px] w-[65%] rounded-t-sm transition-[height,background] duration-300"
              style={{ height: `${(p.count / max) * 100}%` }}
            >
              {p.count > 0 && (
                <span className="text-muted-foreground absolute -top-5 left-1/2 -translate-x-1/2 text-[11px] leading-none font-medium tabular-nums">
                  {p.count}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="text-muted-foreground flex justify-between text-[11px] tabular-nums">
        <span>{points[0]?.date}</span>
        <span>{points.at(-1)?.date}</span>
      </div>
    </div>
  )
}

/** 面板外壳：标题左侧 3px 主色竖条（对齐源 .panelTitle::before） */
export function DashboardPanel({
  title,
  className,
  children,
}: {
  title: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={cn("bg-card rounded-xl border p-5 shadow-xs", className)}>
      <h2 className="mb-4 flex items-center gap-2 text-[15px] font-semibold">
        <span className="bg-primary h-3.5 w-[3px] shrink-0 rounded-full" />
        {title}
      </h2>
      {children}
    </section>
  )
}

function PanelEmpty({ text = "暂无数据" }: { text?: string }) {
  return <p className="text-muted-foreground py-12 text-center text-[13px]">{text}</p>
}