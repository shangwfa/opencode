/**
 * 仪表盘（需求大盘）。
 * 源：xybot-front-opencode-ui src/pages/dashboard/index.tsx（Solid）+ dashboard.module.css。
 * 结构 1:1：toolbar（仓库过滤 / 时间范围 / 自动刷新）→ hero 状态流水线 →
 * 2×2 面板（状态分布、合并请求状态、人员需求排行、需求创建趋势）→ 仓库分布。
 * 数据源：harness requirements-v2 aggregate API（fetchRequirementsV2All）。
 * 本项目未引入查询库，用 useRequirementsAll 等价实现 loading/error/data + 60s 轮询。
 */
import { useMemo, useState } from "react"
import { ChevronDown, FolderOpen, Loader2, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import {
  completionRate,
  countByCreator,
  countByMergeState,
  countByRepo,
  countByStatus,
  filterByTimeRange,
  mergeStateItems,
  repoOptions,
  trendByDay,
  type TimeRange,
} from "./dashboard/aggregate"
import { BarRankList, DashboardPanel, DistributionBar, StatusPipeline, TrendChart } from "./dashboard/components"
import { useRequirementsAll } from "./dashboard/use-requirements-all"

const RANGES: TimeRange[] = [7, 30, "all"]

export function DashboardPage() {
  const [repo, setRepo] = useState("")
  const [range, setRange] = useState<TimeRange>("all")
  const [autoRefresh, setAutoRefresh] = useState(true)
  const { items, loading, error, loaded, reload } = useRequirementsAll(repo, autoRefresh)

  const repoOpts = useMemo(() => repoOptions(items), [items])
  const filtered = useMemo(() => filterByTimeRange(items, range), [items, range])

  const total = filtered.length
  const status = useMemo(() => countByStatus(filtered), [filtered])
  const completion = useMemo(() => completionRate(filtered), [filtered])
  const byRepo = useMemo(() => countByRepo(filtered), [filtered])
  const byCreator = useMemo(() => countByCreator(filtered), [filtered])
  const mergeItems = useMemo(() => mergeStateItems(countByMergeState(filtered)), [filtered])
  const trend = useMemo(() => trendByDay(filtered, range), [filtered, range])

  const statusItems = useMemo(
    () => [
      { key: "open", label: "待处理", value: status.open, color: "#1677ff" },
      { key: "pending_publish", label: "待发布", value: status.pending_publish, color: "#faad14" },
      { key: "done", label: "已发布", value: status.done, color: "#52c41a" },
    ],
    [status.open, status.pending_publish, status.done],
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-8 pt-7 pb-12">
        {/* toolbar */}
        <div className="mb-7 flex flex-wrap items-center justify-between gap-4 border-b pb-5">
          <h1 className="text-[22px] font-bold tracking-tight">仪表盘</h1>
          <div className="flex flex-wrap items-center gap-3">
            <RepoSelect value={repo} options={repoOpts} onChange={setRepo} />
            <div className="bg-background flex overflow-hidden rounded-md border">
              {RANGES.map((r) => (
                <button
                  key={String(r)}
                  type="button"
                  onClick={() => setRange(r)}
                  className={cn(
                    "border-r px-3.5 py-1.5 text-[13px] transition-colors last:border-r-0",
                    range === r
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {r === "all" ? "全部" : `近${r}天`}
                </button>
              ))}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoRefresh}
              onClick={() => setAutoRefresh((v) => !v)}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-[13px]"
            >
              <span
                className={cn(
                  "relative h-4 w-7 rounded-full transition-colors",
                  autoRefresh ? "bg-primary" : "bg-muted-foreground/30",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 size-3 rounded-full bg-white transition-[left]",
                    autoRefresh ? "left-3.5" : "left-0.5",
                  )}
                />
              </span>
              自动刷新
            </button>
          </div>
        </div>

        {/* 四态：首屏加载 / 错误 / 空 / 内容 */}
        {loading && !loaded ? (
          <StateBlock icon={<Loader2 className="size-5 animate-spin" />} text="加载中…" />
        ) : error && !loaded ? (
          <StateBlock
            icon={<TriangleAlert className="size-5 text-amber-500" />}
            text={error || "数据加载失败"}
            action={
              <Button size="sm" onClick={() => void reload()}>
                重试
              </Button>
            }
          />
        ) : total === 0 ? (
          <StateBlock
            icon={<FolderOpen className="size-5" />}
            text={items.length === 0 ? "暂无需求数据" : "当前筛选条件下没有需求"}
          />
        ) : (
          <>
            <StatusPipeline total={total} status={status} completionRate={completion} />

            <div className="mb-5 grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
              <DashboardPanel title="状态分布">
                <DistributionBar items={statusItems} />
              </DashboardPanel>
              <DashboardPanel title="合并请求状态">
                <DistributionBar items={mergeItems} />
              </DashboardPanel>
            </div>

            <div className="mb-5 grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
              <DashboardPanel title="人员需求排行">
                <BarRankList items={byCreator} />
              </DashboardPanel>
              <DashboardPanel title="需求创建趋势">
                <TrendChart points={trend} />
              </DashboardPanel>
            </div>

            <DashboardPanel title="仓库分布">
              <DistributionBar items={byRepo} labelWidth="w-[190px]" />
            </DashboardPanel>
          </>
        )}
      </div>
    </div>
  )
}

/** 仓库过滤下拉（长列表可滚动；沿用 Popover 避免引入 select 依赖） */
function RepoSelect({
  value,
  options,
  onChange,
}: {
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="bg-background hover:bg-muted flex h-8 max-w-[280px] items-center gap-2 rounded-md border px-3 text-[13px]"
        >
          <span className="truncate">{value === "" ? "全部仓库" : value}</span>
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] p-1">
        <button
          type="button"
          onClick={() => {
            onChange("")
            setOpen(false)
          }}
          className={cn(
            "hover:bg-muted w-full rounded-sm px-2 py-1.5 text-left text-[13px]",
            value === "" && "bg-muted font-medium",
          )}
        >
          全部仓库
        </button>
        <ScrollArea className="max-h-64">
          {options.length === 0 ? (
            <p className="text-muted-foreground px-2 py-3 text-center text-xs">暂无仓库数据</p>
          ) : (
            options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  onChange(opt)
                  setOpen(false)
                }}
                className={cn(
                  "hover:bg-muted w-full truncate rounded-sm px-2 py-1.5 text-left text-[13px]",
                  value === opt && "bg-muted font-medium",
                )}
                title={opt}
              >
                {opt}
              </button>
            ))
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}

function StateBlock({
  icon,
  text,
  action,
}: {
  icon: React.ReactNode
  text: string
  action?: React.ReactNode
}) {
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center gap-3.5 py-24 text-sm">
      {icon}
      <span className="text-center">{text}</span>
      {action}
    </div>
  )
}