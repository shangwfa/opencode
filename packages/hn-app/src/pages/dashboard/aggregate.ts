import type { AggregateRequirement } from "@/api/requirement/types"

export interface StatusCount {
  open: number
  pending_publish: number
  done: number
  other: number
}

export interface KeyValueCount {
  key: string
  label: string
  value: number
  color: string
}

export interface CreatorStat {
  name: string
  total: number
  done: number
  rate: number
}

export interface DayPoint {
  date: string
  count: number
}

export interface MergeStateCount {
  opened: number
  merged: number
  closed: number
}

export type TimeRange = 7 | 30 | "all"

export function countByStatus(items: AggregateRequirement[]): StatusCount {
  const r: StatusCount = { open: 0, pending_publish: 0, done: 0, other: 0 }
  for (const it of items) {
    if (it.status === "open") r.open++
    else if (it.status === "pending_publish") r.pending_publish++
    else if (it.status === "done") r.done++
    else r.other++
  }
  return r
}

function countByField(
  items: AggregateRequirement[],
  pick: (it: AggregateRequirement) => string | undefined,
  labels: Record<string, string>,
  colors: Record<string, string>,
): KeyValueCount[] {
  const map = new Map<string, number>()
  for (const it of items) {
    const k = pick(it) ?? "unknown"
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([key, value]) => ({
      key,
      label: labels[key] ?? key,
      value,
      color: colors[key] ?? "#8c8c8c",
    }))
    .sort((a, b) => b.value - a.value)
}

export function countByKind(items: AggregateRequirement[]): KeyValueCount[] {
  return countByField(
    items,
    (it) => it.kind,
    { regular: "常规", bugfix: "Bugfix", unknown: "未分类" },
    { regular: "#1677ff", bugfix: "#ff4d4f", unknown: "#8c8c8c" },
  )
}

export function countByPriority(items: AggregateRequirement[]): KeyValueCount[] {
  return countByField(
    items,
    (it) => it.priority,
    { high: "高", medium: "中", low: "低", unknown: "未设置" },
    { high: "#ff4d4f", medium: "#faad14", low: "#52c41a", unknown: "#bfbfbf" },
  )
}

export function countByRepo(items: AggregateRequirement[]): KeyValueCount[] {
  const map = new Map<string, number>()
  for (const it of items) {
    const k = it.target_gitlab?.trim() || "未指定"
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([key, value]) => ({ key, label: key, value, color: "#1677ff" }))
    .sort((a, b) => b.value - a.value)
}

export function countByCreator(items: AggregateRequirement[]): CreatorStat[] {
  const map = new Map<string, { total: number; done: number }>()
  for (const it of items) {
    const name = it.creator_nick_name?.trim() || "未指定"
    const cur = map.get(name) ?? { total: 0, done: 0 }
    cur.total++
    if (it.status === "done") cur.done++
    map.set(name, cur)
  }
  return [...map.entries()]
    .map(([name, v]) => ({
      name,
      total: v.total,
      done: v.done,
      rate: v.total > 0 ? v.done / v.total : 0,
    }))
    .sort((a, b) => b.total - a.total || b.done - a.done)
}

export function countByMergeState(items: AggregateRequirement[]): MergeStateCount {
  const r: MergeStateCount = { opened: 0, merged: 0, closed: 0 }
  for (const it of items) {
    for (const mr of it.merge_records ?? []) {
      if (mr.state === "opened") r.opened++
      else if (mr.state === "merged") r.merged++
      else if (mr.state === "closed") r.closed++
    }
  }
  return r
}

export function mergeStateItems(state: MergeStateCount): KeyValueCount[] {
  return [
    { key: "opened", label: "Opened", value: state.opened, color: "#1677ff" },
    { key: "merged", label: "Merged", value: state.merged, color: "#52c41a" },
    { key: "closed", label: "Closed", value: state.closed, color: "#8c8c8c" },
  ]
}

export function filterByTimeRange(
  items: AggregateRequirement[],
  range: TimeRange,
): AggregateRequirement[] {
  if (range === "all") return items
  const cutoff = Date.now() - range * 86_400_000
  return items.filter((it) => {
    const t = Date.parse(it.created_at)
    return Number.isFinite(t) && t >= cutoff
  })
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

export function trendByDay(
  items: AggregateRequirement[],
  range: TimeRange,
): DayPoint[] {
  // "全部"按月聚合避免点过多；近 N 天按天聚合
  const byMonth = range === "all"
  const counts = new Map<string, number>()
  let minKey: string | undefined
  for (const it of items) {
    const t = Date.parse(it.created_at)
    if (!Number.isFinite(t)) continue
    const key = byMonth ? monthKey(new Date(t)) : dayKey(new Date(t))
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (!minKey || key < minKey) minKey = key
  }
  const todayKey = byMonth ? monthKey(new Date()) : dayKey(new Date())
  const startKey =
    range === "all" ? minKey ?? todayKey : dayKey(new Date(Date.now() - (range - 1) * 86_400_000))

  const points: DayPoint[] = []
  if (byMonth) {
    let [y, m] = startKey.split("-").map(Number)
    const [ey, em] = todayKey.split("-").map(Number)
    while (y < ey || (y === ey && m <= em)) {
      const key = `${y}-${String(m).padStart(2, "0")}`
      points.push({ date: key, count: counts.get(key) ?? 0 })
      m++
      if (m > 12) {
        m = 1
        y++
      }
    }
  } else {
    let cursor = new Date(`${startKey}T00:00:00`)
    const end = new Date(`${todayKey}T00:00:00`)
    while (cursor <= end) {
      const key = dayKey(cursor)
      points.push({ date: key, count: counts.get(key) ?? 0 })
      const next = new Date(cursor)
      next.setDate(next.getDate() + 1)
      cursor = next
    }
  }
  return points
}

export function repoOptions(items: AggregateRequirement[]): string[] {
  const set = new Set<string>()
  for (const it of items) {
    const r = it.target_gitlab?.trim()
    if (r) set.add(r)
  }
  return [...set].sort()
}

export function completionRate(items: AggregateRequirement[]): number {
  const total = items.length
  if (total === 0) return 0
  const done = items.filter((it) => it.status === "done").length
  return (done / total) * 100
}
