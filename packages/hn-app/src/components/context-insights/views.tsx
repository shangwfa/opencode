import { useMemo, useState, type ReactNode, type SelectHTMLAttributes } from "react"
import { ChevronDown } from "lucide-react"
import { useNavigate } from "react-router"
import type { SessionContextInsights as C } from "@opencode/schema/session-context-insights"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Markdown } from "@/components/session/markdown"
import { contextInsights } from "@/lib/context-insights"
import { categories, colors, compact, duration, elapsed, familyLayout, money, tokenTotal, type Labels } from "./model"
import { useResource } from "./use-resource"

/** Lineage colours: each branch keeps one hue so sibling trees stay distinguishable. */
const palette = ["#6366f1", "#0891b2", "#a855f7", "#f59e0b", "#10b981", "#ef4444", "#0ea5e9"]
export const lineage = (index: number) => palette[(index < 0 ? 0 : index) % palette.length]

/** Only labelled origins are captured; an unlabelled tool is host-registered (builtin or plugin). */
export const sourceLabel = (source: string, labels: Labels) =>
  source.startsWith("mcp:") ? `${labels.mcp} ${source.slice(4)}` : labels.sessionTool

/**
 * 原生 select 的箭头紧贴边框、且不同浏览器位置不一：改为自绘 chevron。
 * `appearance-none` 去掉原生箭头，右侧用绝对定位的图标补回来，间距可控。
 */
export function Select({ className = "", wrapClassName = "", ...props }: SelectHTMLAttributes<HTMLSelectElement> & { wrapClassName?: string }) {
  return <span className={`relative inline-flex min-w-0 align-middle ${wrapClassName}`}>
    <select {...props} className={`w-full appearance-none rounded-md border bg-background ps-2 pe-7 py-1.5 text-xs ${className}`} />
    <ChevronDown aria-hidden="true" className="pointer-events-none absolute end-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
  </span>
}

export function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <section className="min-w-0 rounded-xl border bg-card p-4 sm:p-5"><header className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-semibold">{title}</h2>{action}</header>{children}</section>
}
export function ResourceError({ error, retry, label }: { error?: string; retry: () => void; label: string }) {
  return error ? (
    <Alert variant="destructive" className="my-3">
      <AlertDescription className="break-words text-sm">{error}</AlertDescription>
      <Button className="mt-2" size="sm" variant="outline" onClick={retry}>{label}</Button>
    </Alert>
  ) : null
}
export function Composition({ request, labels }: { request: C.Request; labels: Labels }) {
  // The declared output limit is reserved inside the same window as the input.
  const reserve = request.contextWindow === undefined ? 0 : Math.min(request.outputReserve ?? 0, request.contextWindow)
  const total = Math.max(request.contextWindow ?? 0, request.estimatedTokens) || 1
  const remaining =
    request.contextWindow === undefined ? 0 : Math.max(0, request.contextWindow - request.estimatedTokens - reserve)
  const stripe = (color: string) =>
    `repeating-linear-gradient(45deg, ${color}, ${color} 3px, transparent 3px, transparent 6px)`
  // 硬上限：模型的输入上限（若有）与"窗口减去输出预留"取小。这是能精确声明的边界，
  // 不等同于压缩阈值（阈值由 buffer / provider 策略决定，未采集前不画）。
  const ceiling = request.contextWindow === undefined
    ? undefined
    : Math.min(request.inputLimit ?? request.contextWindow, request.contextWindow - reserve)
  return <><div className="relative mb-4">
    <div className="flex h-5 overflow-hidden rounded-md bg-muted" role="img" aria-label={`${labels.estimate}: ${request.estimatedTokens}`}>
    {categories.map((key, i) => <span key={key} style={{ background: colors[i], width: `${request.composition[key] / total * 100}%` }} />)}
    {reserve > 0 && <span aria-hidden="true" className="shrink-0" style={{ width: `${reserve / total * 100}%`, background: stripe("var(--muted-foreground)"), opacity: 0.55 }} />}
    {remaining > 0 && <span aria-hidden="true" className="flex-1" style={{ background: stripe("var(--muted-foreground)"), opacity: 0.25 }} />}
    </div>
    {ceiling !== undefined && ceiling < total && <span aria-hidden="true" title={`${labels.ceiling} ≈${compact(ceiling)}`} className="absolute inset-y-0 w-px bg-foreground/50" style={{ left: `${(ceiling / total) * 100}%` }} />}
  </div><dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs sm:grid-cols-3">{categories.map((key, i) => <div key={key} className="flex items-center gap-2"><span aria-hidden="true" className="size-2 shrink-0 rounded-sm" style={{ background: colors[i] }} /><dt>{labels[key]}</dt><dd className="ml-auto font-mono tabular-nums">{compact(request.composition[key])}</dd></div>)}</dl>
    {(reserve > 0 || remaining > 0) && <div className="mt-3 space-y-1 text-xs text-muted-foreground">
      {reserve > 0 && <p className="flex items-center gap-2"><span aria-hidden="true" className="size-2 shrink-0 rounded-sm bg-muted-foreground/55" />{labels.outputReserve} <span className="font-mono tabular-nums">≈{compact(reserve)}</span></p>}
      {remaining > 0 && <p className="flex items-center gap-2"><span aria-hidden="true" className="size-2 shrink-0 rounded-sm bg-muted-foreground/25" />{labels.remaining} <span className="font-mono tabular-nums">≈{compact(remaining)}</span></p>}
      {ceiling !== undefined && <p className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-px bg-foreground/50" />{labels.ceiling} <span className="font-mono tabular-nums">≈{compact(ceiling)}</span></p>}
    </div>}
    {request.incomplete && <p className="mt-4 text-xs text-amber-700 dark:text-amber-400">{labels.incomplete}</p>}</>
}
/** Compaction markers land on the first point at or after the event sequence. */
export const markerIndex = (points: ReadonlyArray<{ readonly seq: number }>, events: ReadonlyArray<{ readonly seq: number; readonly type: string }>) =>
  new Set(events.filter((event) => event.type === "compaction").flatMap((event) => {
    const index = points.findIndex((point) => point.seq >= event.seq)
    return index < 0 ? [] : [index]
  }))

export function Trend({ points, mode, selected, onSelect, labels, markers = new Set<number>(), band = false, eventCount = 0 }: {
  points: C.Point[]; mode: "total" | "delta"; selected?: string; onSelect: (id: string) => void; labels: Labels
  markers?: ReadonlySet<number>; band?: boolean; eventCount?: number
}) {
  const max = Math.max(1, ...points.map((point) => mode === "total" ? point.request.estimatedTokens : Math.abs(point.delta ?? 0)))
  const last = points.at(-1)
  // Band mode fits the whole session into the panel; bar mode scrolls so bars keep a readable width.
  const width = band ? undefined : Math.max(points.length * 18, 100)
  return <div><div className={`relative border-b bg-muted/20 pt-3 ${band ? "flex h-24 gap-0 overflow-hidden px-1" : "flex h-44 items-end gap-px overflow-x-auto px-1"}`} aria-label={labels.summary} style={width === undefined ? undefined : { minWidth: `${width}px` }}>
    {mode === "delta" && <div aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-dashed" />}
    {points.map((point, index) => <button key={point.request.id} type="button" aria-pressed={selected === point.request.id}
      aria-label={`${index + 1}. ${point.request.kind}: ${point.request.estimatedTokens}; ${labels[point.status]}`}
      title={`${point.request.model.id} · ${point.request.estimatedTokens} · Δ ${point.delta ?? "—"}`}
      onClick={() => onSelect(point.request.id)} className={`relative h-full min-w-0 flex-1 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-primary ${selected === point.request.id ? "bg-primary/15" : "hover:bg-muted"}`}>
      {markers.has(index) && <span aria-hidden="true" title={labels.markers} className="absolute inset-x-0 top-0 z-10 h-0.5 bg-amber-500" />}
      {mode === "total" ? <span className="absolute inset-x-0 bottom-0 flex flex-col-reverse overflow-hidden rounded-t-sm">{categories.map((key, i) => <span key={key} style={{ background: colors[i], height: `${point.request.composition[key] / max * (band ? 84 : 148)}px` }} />)}</span>
        : <span className="absolute inset-x-0" style={{ background: (point.delta ?? 0) < 0 ? "#e11d48" : "#0891b2", height: `${Math.abs(point.delta ?? 0) / max * (band ? 40 : 72)}px`, ...((point.delta ?? 0) < 0 ? { top: "50%" } : { bottom: "50%" }) }} />}
    </button>)}
  </div><div className="mt-2 flex justify-between font-mono text-[10px] text-muted-foreground"><span>{points[0] ? new Date(points[0].request.time).toLocaleTimeString() : "—"}</span><span>{mode === "delta" ? "± " : ""}{compact(max)}</span><span>{last ? new Date(last.request.time).toLocaleTimeString() : "—"}</span></div></div>
}

/** Attachments keep only a descriptor: bytes are never retained, so no preview is claimed. */
function Attachment({ item, labels }: { item: C.Item; labels: Labels }) {
  const media = item.media
  if (!media) return null
  const image = media.mediaType.startsWith("image/")
  return <div className="mt-3 flex items-center gap-3 rounded-lg border bg-background p-3 text-xs">
    <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-[10px] uppercase">{image ? "IMG" : "FILE"}</span>
    <span className="min-w-0 flex-1 break-all"><span className="block font-medium">{media.filename ?? labels.untitled}</span><small className="block text-muted-foreground">{media.mediaType} · {item.bytes.toLocaleString()} B</small></span>
    <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{labels.notRetained}</span>
  </div>
}

/** Duration curve: per-request elapsed time; the model span is drawn as a lighter band under it. */
export function DurationCurve({ points, selected, onSelect, labels }: {
  points: C.Point[]; selected?: string; onSelect: (id: string) => void; labels: Labels
}) {
  const rows = points.filter((point) => point.elapsedMs !== null)
  const max = Math.max(1, ...rows.map((point) => point.elapsedMs ?? 0))
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">{labels.noEvents}</p>
  const x = (index: number) => (rows.length === 1 ? 50 : (index / (rows.length - 1)) * 100)
  const y = (value: number) => 100 - (value / max) * 100
  return <div className="min-w-0">
    <div className="relative h-28 overflow-hidden rounded-md border bg-background">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="size-full" role="img" aria-label={labels.durationCurve}>
        {rows.map((point, index) => point.modelMs === null ? null : <rect key={`m-${point.request.id}`} x={x(index) - 1.2} y={y(point.modelMs)} width={2.4} height={100 - y(point.modelMs)} fill="#0891b2" opacity={0.18} />)}
        <polyline fill="none" stroke="#0891b2" strokeWidth={1.5} vectorEffect="non-scaling-stroke"
          points={rows.map((point, index) => `${x(index)},${y(point.elapsedMs ?? 0)}`).join(" ")} />
        {rows.map((point, index) => <circle key={point.request.id} cx={x(index)} cy={y(point.elapsedMs ?? 0)} r={selected === point.request.id ? 2.2 : 1.4} fill={selected === point.request.id ? "#e11d48" : "#0891b2"} vectorEffect="non-scaling-stroke" />)}
      </svg>
    </div>
    <div className="mt-1 flex gap-px">{rows.map((point) => <button key={point.request.id} type="button" aria-pressed={selected === point.request.id}
      aria-label={`${labels.elapsed}: ${duration(point.elapsedMs)}`} onClick={() => onSelect(point.request.id)}
      className={`min-w-0 flex-1 truncate rounded px-1 py-0.5 font-mono text-[9px] ${selected === point.request.id ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-muted"}`}>
      {point.elapsedMs === null ? "—" : Math.round(point.elapsedMs)}
    </button>)}</div>
  </div>
}

/** Timing strip: one band per request, width = its share of summed elapsed; inner split by phase. */
export function TimingStrip({ points, selected, onSelect, labels }: {
  points: C.Point[]; selected?: string; onSelect: (id: string) => void; labels: Labels
}) {
  const rows = points.filter((point) => point.elapsedMs !== null && point.elapsedMs > 0)
  const total = rows.reduce((sum, point) => sum + (point.elapsedMs ?? 0), 0)
  if (rows.length === 0 || total === 0) return <p className="text-xs text-muted-foreground">{labels.noEvents}</p>
  return <div className="flex h-6 w-full overflow-hidden rounded-md border" role="img" aria-label={labels.timingStrip}>
    {rows.map((point) => {
      const elapsed = point.elapsedMs ?? 0
      const model = Math.min(point.modelMs ?? 0, elapsed)
      const tools = Math.min(point.toolMs ?? 0, elapsed - model)
      const first = Math.min(point.firstContentMs ?? 0, elapsed)
      const other = Math.max(0, elapsed - model - tools)
      return <button key={point.request.id} type="button" onClick={() => onSelect(point.request.id)}
        aria-pressed={selected === point.request.id} title={`#${point.turn} · ${duration(elapsed)}`}
        className={`flex h-full shrink-0 flex-col ${selected === point.request.id ? "ring-2 ring-primary ring-inset" : ""}`}
        style={{ width: `${(elapsed / total) * 100}%` }}>
        <span className="w-full" style={{ background: "#0891b2", height: `${(first / elapsed) * 100}%` }} />
        <span className="w-full" style={{ background: "#6366f1", height: `${(model / elapsed) * 100}%` }} />
        <span className="w-full" style={{ background: "#f59e0b", height: `${(tools / elapsed) * 100}%` }} />
        <span className="w-full flex-1 bg-muted" />
      </button>
    })}
  </div>
}

function Content({ sessionID, requestID, item, labels, call }: {
  sessionID: string; requestID: string; item: C.Item; labels: Labels; call?: C.Item
}) {
  const [markdown, setMarkdown] = useState(false)
  const resource = useResource(`${sessionID}:${requestID}:${item.index}`, (signal) => contextInsights.content(sessionID, requestID, item.index, signal))
  const args = useResource(`${sessionID}:${requestID}:call:${call?.index ?? -1}`,
    (signal) => call === undefined ? Promise.resolve(undefined) : contextInsights.content(sessionID, requestID, call.index, signal))
  const value = resource.data?.content
  return <div className="min-w-0 border-t bg-muted/20 p-3">
    <ResourceError error={resource.error} retry={resource.reload} label={labels.retry} />
    {resource.loading && value === undefined ? <Skeleton className="h-16 w-full" /> : value === null ? <p className="text-xs text-muted-foreground">{labels.omitted} · {item.omitted}</p> : value !== undefined ? <>
      <div className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{item.bytes.toLocaleString()} B</span><button type="button" className="rounded border px-2 py-1" aria-pressed={markdown} onClick={() => setMarkdown((old) => !old)}>{markdown ? "Raw" : "Markdown"}</button></div>
      {call !== undefined && <details className="mb-3"><summary className="cursor-pointer text-xs font-medium">{labels.arguments}</summary><pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded border bg-background p-2 font-mono text-[11px] leading-5">{args.data?.content ?? "…"}</pre></details>}
      {markdown ? <Markdown content={value} className="break-words" /> : <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs leading-5">{value}</pre>}
    </> : null}
  </div>
}
/** Slice-and-dice block map: area proportional to estimated tokens, grouped by category colour. */
export function Treemap({ items, labels }: { items: ReadonlyArray<C.Item>; labels: Labels }) {
  const rows = items.filter((item) => item.estimatedTokens > 0)
  const total = rows.reduce((sum, item) => sum + item.estimatedTokens, 0)
  if (total === 0) return null
  const index = new Map(categories.map((key, position) => [key, position]))
  return <div className="mb-4">
    <p className="mb-2 text-xs font-medium">{labels.treemap}</p>
    <div className="flex h-24 w-full overflow-hidden rounded-md border" role="img" aria-label={labels.treemap}>
      {rows.map((item) => <span key={item.index} title={`${item.name} · ≈${compact(item.estimatedTokens)}`}
        className="h-full shrink-0 border-e border-background/60 last:border-e-0"
        style={{ width: `${(item.estimatedTokens / total) * 100}%`, background: colors[index.get(item.category) ?? 0], opacity: 0.85 }} />)}
    </div>
  </div>
}

export function RequestBrowser({ sessionID, requestID, mode, previous, labels, initialSort = "order", onSort }: {
  sessionID: string; requestID: string; mode: "list" | "dna"; previous?: C.Composition; labels: Labels
  initialSort?: "order" | "size" | "name"; onSort?: (value: "order" | "size" | "name") => void
}) {
  const resource = useResource(`${sessionID}:${requestID}`, (signal) => contextInsights.detail(sessionID, requestID, signal))
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState("all")
  const [sort, setSort] = useState<"order" | "size" | "name">(initialSort)
  const [queries, setQueries] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const items = useMemo(() => {
    const rows = (resource.data?.items ?? []).filter((item) => item.name.toLowerCase().includes(query.toLowerCase()) && (kind === "all" || item.name.endsWith(`:${kind}`)))
    if (mode === "dna") {
      // 消息按提示词顺序在前，工具定义与系统提示词作为两个分组收尾（与原文一致）。
      const rank = (item: C.Item) => item.category === "tool" || item.category === "assistant" || item.category === "user" || item.category === "inject" ? 0 : item.category === "tools" ? 1 : 2
      return [...rows].sort((left, right) => rank(left) - rank(right) || left.index - right.index)
    }
    return sort === "order" ? rows : [...rows].sort((a, b) => sort === "size" ? b.estimatedTokens - a.estimatedTokens : a.name.localeCompare(b.name))
  }, [resource.data, query, kind, sort, mode])
  const bands = useMemo(() => {
    const rows = resource.data?.items ?? []
    const total = rows.reduce((sum, item) => sum + item.estimatedTokens, 0)
    const index = new Map(categories.map((key, position) => [key, position]))
    return total === 0 ? [] : rows.map((item) => ({ key: item.index, width: (item.estimatedTokens / total) * 100, color: colors[index.get(item.category) ?? 0] }))
  }, [resource.data])
  const row = (item: C.Item) => <div key={item.index} className="min-w-0 rounded-lg border">
    <button type="button" className="flex w-full items-start gap-2 p-3 text-start text-xs hover:bg-muted/50" aria-expanded={expanded.has(item.index)} onClick={() => setExpanded((old) => { const next = new Set(old); if (next.has(item.index)) next.delete(item.index); else next.add(item.index); return next })}>
      <span className="font-mono text-muted-foreground">#{item.index + 1}</span><span className="min-w-0 flex-1 break-all">{item.name}{item.tool && <Badge variant={item.tool.failed ? "destructive" : "secondary"} className="ms-2 align-middle font-sans">{item.tool.name}{item.tool.failed ? ` · ${labels.failed}` : ""}</Badge>}<small className="mt-1 block text-muted-foreground">{labels[item.category]}{item.omitted ? ` · ${item.omitted}` : ""}{item.source ? ` · ${sourceLabel(item.source, labels)}` : ""}{item.origin === "skills" ? ` · ${labels.skills}` : ""}{item.introduced !== undefined ? ` · ${labels.introduced} #${item.introduced}` : ""}</small>{item.media && <Attachment item={item} labels={labels} />}</span><span className="shrink-0 font-mono">≈{compact(item.estimatedTokens)}</span>
    </button>{expanded.has(item.index) && <Content sessionID={sessionID} requestID={requestID} item={item} labels={labels} call={item.tool ? (resource.data?.items ?? []).find((candidate) => candidate.category === "assistant" && candidate.tool?.callID === item.tool?.callID && candidate.tool?.failed === undefined) : undefined} />}
  </div>
  return <div className="min-w-0">{resource.data && mode !== "dna" && <Treemap items={resource.data.items} labels={labels} />}<div className="mb-4 flex flex-wrap gap-2"><input aria-label={labels.search} placeholder={labels.search} value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-xs" />
    <select aria-label="Content kind" value={kind} onChange={(event) => setKind(event.target.value)} className="rounded-md border bg-background p-2 text-xs"><option value="all">All</option><option value="reasoning">Thinking</option><option value="tool-call">Tools</option><option value="text">Text</option></select>
    {mode !== "dna" && <select aria-label="Sort" value={sort} onChange={(event) => { const next = event.target.value === "size" ? "size" : event.target.value === "name" ? "name" : "order"; setSort(next); onSort?.(next) }} className="rounded-md border bg-background p-2 text-xs"><option value="order">#</option><option value="size">Token ↓</option><option value="name">A–Z</option></select>}
  </div><ResourceError error={resource.error} retry={resource.reload} label={labels.retry} />
    {mode === "dna" && bands.length > 0 && <div className="mb-3 flex h-6 w-full overflow-hidden rounded-md border" role="img" aria-label={labels.dna}>{bands.map((band) => <span key={band.key} style={{ background: band.color, width: `${band.width}%` }} />)}</div>}
    {resource.loading && !resource.data ? <div className="space-y-2" role="status" aria-live="polite"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-2/3" /></div> : mode === "dna" ? <div className="max-h-[38rem] space-y-2 overflow-y-auto">{items.map(row)}</div> : <div className="space-y-3">{categories.map((category) => {
      const group = items.filter((item) => item.category === category)
      return <details key={category} open={!!query || undefined} className="rounded-lg border p-3"><summary className="cursor-pointer text-xs font-medium">{labels[category]} <span className="font-mono text-muted-foreground">{group.length}</span>{previous && resource.data ? (() => { const d = resource.data.request.composition[category] - previous[category]; return d !== 0 ? <span className={`ml-2 rounded px-1.5 py-0.5 font-mono text-[10px] ${d > 0 ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>{d > 0 ? "+" : "−"}{compact(Math.abs(d))} {labels.estimate}</span> : null })() : null}</summary><div className="mt-3 max-h-96 space-y-2 overflow-y-auto"><input aria-label={`${labels.search} · ${labels[category]}`} placeholder={labels.search} value={queries[category] ?? ""} onChange={(event) => setQueries((old) => ({ ...old, [category]: event.target.value }))} className="mb-2 w-full rounded-md border bg-background px-2 py-1.5 text-xs" />{group.filter((entry) => (queries[category] ?? "") === "" || entry.name.toLowerCase().includes((queries[category] ?? "").toLowerCase())).map(row)}</div></details>
    })}</div>}
  </div>
}
export function FamilyView({ family, labels }: { family: C.Family; labels: Labels }) {
  const navigate = useNavigate()
  const [hover, setHover] = useState<string>()
  const layout = useMemo(() => familyLayout(family.members, family.rootID), [family])
  const byId = new Map<string, C.SessionCard>(family.members.map((m) => [m.sessionID, m]))
  const statusLabel = (m: C.SessionCard) =>
    m.running ? labels.running : m.outcome === "succeeded" ? labels.completed : m.outcome ? labels[m.outcome] : labels.unknown
  const total = family.members.reduce((sum, m) => sum + tokenTotal(m.usage), 0)
  const cost = family.members.reduce((sum, m) => sum + m.usage.cost, 0)
  const cols = Math.max(1, ...layout.nodes.map((n) => n.x)) + 1
  const rows = Math.max(1, ...layout.nodes.map((n) => n.depth)) + 1
  const NODE_W = 196
  const NODE_H = 96
  const GAP_X = 40
  const GAP_Y = 56
  const W = cols * (NODE_W + GAP_X) + GAP_X
  const H = rows * (NODE_H + GAP_Y) + GAP_Y
  const px = (n: { x: number }) => GAP_X + n.x * (NODE_W + GAP_X)
  const py = (n: { depth: number }) => GAP_Y + n.depth * (NODE_H + GAP_Y)
  const chainSet = new Set(hover ? (layout.nodes.find((n) => n.id === hover)?.chain ?? []) : [])
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-6 text-xs">
        <span>{family.members.length} Agents</span>
        <span>
          {labels.lifetime}: {compact(total)} Token
        </span>
        <span>{money(cost)}</span>
      </div>
      {!family.complete && <p className="mb-4 text-xs text-amber-700 dark:text-amber-400">{labels.filtered}</p>}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ maxHeight: "70vh" }}
        role="img"
        aria-label={`${labels.fleet}: ${family.members.length} agents`}
      >
        {layout.edges.map((edge) => {
          const from = layout.nodes.find((n) => n.id === edge.from)
          const to = layout.nodes.find((n) => n.id === edge.to)
          if (!from || !to) return null
          const x1 = px(from) + NODE_W / 2
          const y1 = py(from) + NODE_H
          const x2 = px(to) + NODE_W / 2
          const y2 = py(to)
          const lit = hover && chainSet.has(edge.from) && chainSet.has(edge.to)
          return (
            <path
              key={`${edge.from}->${edge.to}`}
              d={`M ${x1} ${y1} C ${x1} ${y1 + 28}, ${x2} ${y2 - 28}, ${x2} ${y2}`}
              fill="none"
              stroke={edge.running ? "#10b981" : lit ? lineage(layout.nodes.findIndex((node) => node.id === edge.to)) : "#cbd5e1"}
              strokeWidth={lit ? 3 : edge.running ? 2.5 : 1.5}
              strokeDasharray={edge.running ? "4 3" : undefined}
            />
          )
        })}
        {layout.nodes.map((n) => {
          const member = byId.get(n.id)
          if (!member) return null
          const lit = !hover || chainSet.has(n.id)
          return (
            <g
              key={n.id}
              role="button"
              tabIndex={0}
              aria-label={`${member.title} · ${labels.openSession}`}
              onClick={() => navigate(`/session/${n.id}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  navigate(`/session/${n.id}`)
                }
              }}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(undefined)}
              onFocus={() => setHover(n.id)}
              onBlur={() => setHover(undefined)}
              className="cursor-pointer focus:outline-none"
              style={{ opacity: lit ? 1 : 0.32 }}
            >
              <rect
                x={px(n)}
                y={py(n)}
                width={NODE_W}
                height={NODE_H}
                rx={10}
                className="fill-card stroke-border focus-visible:outline-none"
                strokeWidth={hover === n.id ? 2.5 : 1}
                stroke={hover === n.id ? "#6366f1" : undefined}
              />
              <circle cx={px(n) + 14} cy={py(n) + 16} r={4} fill={member.running ? "#10b981" : "#94a3b8"} />
              <text x={px(n) + 26} y={py(n) + 20} className="fill-foreground text-[11px] font-medium">
                {member.title.length > 18 ? member.title.slice(0, 17) + "…" : member.title}
              </text>
              <text x={px(n) + 12} y={py(n) + 38} className="fill-muted-foreground font-mono text-[9px]">
                {compact(tokenTotal(member.usage))} Token · {money(member.usage.cost)}
              </text>
              {member.latest ? <>
                <text x={px(n) + 12} y={py(n) + 52} className="fill-muted-foreground font-mono text-[9px]">
                  {labels.window} {member.latest.contextWindow ? `${((member.latest.estimatedTokens / member.latest.contextWindow) * 100).toFixed(0)}%` : "—"}
                </text>
                {categories.map((key, i) => {
                  const window = member.latest?.contextWindow
                  const width = window ? (member.latest.composition[key] / window) * (NODE_W - 24) : 0
                  const offset = categories.slice(0, i).reduce((sum, previous) => sum + (window ? (member.latest.composition[previous] / window) * (NODE_W - 24) : 0), 0)
                  return width <= 0 ? null : <rect key={key} x={px(n) + 12 + offset} y={py(n) + 58} width={width} height={5} fill={colors[i]} />
                })}
              </> : null}
              <text x={px(n) + 12} y={py(n) + 78} className="fill-muted-foreground text-[9px]">
                {statusLabel(member)}{member.requests === undefined ? "" : ` · ${member.requests} ${labels.steps}`}{member.started === undefined ? "" : ` · ${elapsed((member.running ? Date.now() : member.updated) - member.started)}`}
              </text>
            </g>
          )
        })}
      </svg>
      {hover && byId.get(hover) ? (() => {
        const member = byId.get(hover)!
        return <div className="mt-4 grid gap-2 rounded-lg border bg-muted/20 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <p className="break-words font-medium sm:col-span-2 lg:col-span-4">{member.title}</p>
          <p><span className="text-muted-foreground">{labels.actual}: </span><span className="font-mono">{compact(tokenTotal(member.usage))}</span></p>
          <p><span className="text-muted-foreground">{labels.cost}: </span><span className="font-mono">{money(member.usage.cost)}</span></p>
          <p><span className="text-muted-foreground">{labels.steps}: </span><span className="font-mono">{member.requests ?? "—"}</span></p>
          <p><span className="text-muted-foreground">{labels.elapsedLabel}: </span><span className="font-mono">{member.started === undefined ? "—" : elapsed((member.running ? Date.now() : member.updated) - member.started)}</span></p>
          <p><span className="text-muted-foreground">{labels.window}: </span><span className="font-mono">{member.latest?.contextWindow ? `${((member.latest.estimatedTokens / member.latest.contextWindow) * 100).toFixed(1)}%` : "—"}</span></p>
        </div>
      })() : null}
    </>
  )
}
export function PointMetrics({ point, labels }: { point: C.Point; labels: Labels }) {
  return <dl className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-3">{[
    [labels.actual, point.actual ? compact(tokenTotal(point.actual)) : "—"], [labels.cost, point.actual ? money(point.actual.cost) : "—"],
    [labels.elapsed, duration(point.elapsedMs)], [labels.first, duration(point.firstContentMs)], [labels.model, duration(point.modelMs)], [labels.toolsTime, duration(point.toolMs)],
  ].map(([label, value]) => <div key={label}><dt className="mb-1 text-muted-foreground">{label}</dt><dd className="font-mono text-sm">{value}</dd></div>)}</dl>
}
