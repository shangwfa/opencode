import { useMemo, useState } from "react"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { contextInsights } from "@/lib/context-insights"
import { categories, colors, compact, duration, labels as dictionaries, money, readPreferences, tokenTotal, writePreferences } from "@/components/context-insights/model"
import { Composition, Panel, ResourceError, Select } from "@/components/context-insights/views"
import { useResource } from "@/components/context-insights/use-resource"

export function ContextInsightsPage() {
  const [locale, setLocale] = useState(() => readPreferences().locale)
  const labels = dictionaries[locale]
  const [range, setRange] = useState<1 | 7 | 30 | 90 | 400>(() => readPreferences().overviewRange)
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState("recent")
  const [day, setDay] = useState<string>()
  const resource = useResource(String(range), (signal) => contextInsights.overview(range, signal))
  const data = resource.data
  const members = useMemo(() => {
    const active = day ? new Set(data?.days.find((item) => item.date === day)?.sessionIDs ?? []) : null
    return (data?.sessions ?? []).filter((member) => (!active || active.has(member.sessionID)) && `${member.title} ${member.sessionID}`.toLowerCase().includes(query.toLowerCase()))
      .toSorted((a, b) => sort === "tokens" ? tokenTotal(b.usage) - tokenTotal(a.usage) : sort === "context" ? (b.latest?.estimatedTokens ?? 0) - (a.latest?.estimatedTokens ?? 0) : b.updated - a.updated)
  }, [data, query, sort, day])
  const days = useMemo(() => {
    if (!data) return []
    const map = new Map(data.days.map((item) => [item.date, item]))
    const first = Math.floor(data.range.from / 86400000)
    const last = Math.floor((data.range.to - 1) / 86400000)
    return Array.from({ length: last - first + 1 }, (_, i) => { const date = new Date((first + i) * 86400000).toISOString().slice(0, 10); return { date, value: map.get(date) } })
  }, [data])
  const max = Math.max(1, ...(data?.days.map((item) => item.tokens) ?? []))
  // 组成合计：只累加各会话「最新一次请求」的估算，缺失即不参与，不按零补齐。
  const aggregate = useMemo(() => {
    const total = { system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0 }
    for (const member of data?.sessions ?? []) {
      if (!member.latest) continue
      for (const key of categories) total[key] += member.latest.composition[key]
    }
    return total
  }, [data])
  const aggregateTotal = Object.values(aggregate).reduce((sum, value) => sum + value, 0)
  const recent = useMemo(() => days.slice(-7), [days])
  return <div className="h-full overflow-y-auto"><div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-7">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b pb-5"><div><p className="mb-1 font-mono text-[10px] uppercase tracking-[.18em] text-muted-foreground">CONTEXT / FLEET TELEMETRY</p><h1 className="text-2xl font-semibold tracking-tight">{labels.overview}</h1></div>
      <div className="flex flex-wrap gap-2"><Select aria-label="Language" value={locale} onChange={(event) => setLocale(event.target.value === "en" ? "en" : "zh")}><option value="zh">中文</option><option value="en">English</option></Select>{([[1, labels.today], [7, `7 ${labels.days}`], [30, `30 ${labels.days}`], [90, `90 ${labels.days}`], [400, labels.allTime]] as const).map(([value, text]) => <Button key={value} size="sm" variant={range === value ? "default" : "outline"} aria-pressed={range === value} onClick={() => { setRange(value); setDay(undefined); writePreferences({ ...readPreferences(), overviewRange: value }) }}>{text}</Button>)}<Button variant="outline" size="sm" onClick={resource.reload}>{labels.refresh}</Button></div>
    </header>
    <ResourceError error={resource.error} retry={resource.reload} label={labels.retry} />
    {resource.loading && !data ? <p role="status" className="py-20 text-center">…</p> : <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{[["Sessions", String(data?.sessions.length ?? 0)], [labels.actual, compact(data?.days.reduce((sum, value) => sum + value.tokens, 0) ?? 0)], [labels.cost, money(data?.days.reduce((sum, value) => sum + value.cost, 0) ?? 0)], ["Settlements", String(data?.days.reduce((sum, value) => sum + value.settlements, 0) ?? 0)], [labels.toolCalls, String(data?.days.reduce((sum, value) => sum + (value.toolCalls ?? 0), 0) ?? 0)]].map(([label, value]) => <div key={label} className="min-w-0 rounded-xl border bg-card p-4"><h2 className="text-xs text-muted-foreground">{label}</h2><p className="my-3 whitespace-nowrap font-mono text-2xl tabular-nums">{value}</p><p className="text-[10px] text-muted-foreground">{label === "Sessions" ? "≤500 authorized sessions" : labels.selected}</p></div>)}</div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Panel title={labels.sevenDay}>
          <div className="flex h-40 items-end gap-2">
            {recent.map((item) => <div key={item.date} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <span className="font-mono text-[10px] text-muted-foreground">{item.value ? compact(item.value.tokens) : "—"}</span>
              <span title={`${item.date}: ${item.value ? `${item.value.tokens} Token · ${money(item.value.cost)}` : "—"}`} className="w-full rounded-t-sm bg-cyan-600/70" style={{ height: `${item.value ? Math.max(2, (item.value.tokens / Math.max(1, ...recent.map((day) => day.value?.tokens ?? 0))) * 120) : 0}px` }} />
              <span className="font-mono text-[9px] text-muted-foreground">{item.date.slice(5)}</span>
            </div>)}
          </div>
        </Panel>
        <Panel title={labels.donut}>
          {aggregateTotal === 0 ? <p className="text-xs text-muted-foreground">{labels.empty}</p> : <>
            <div className="mb-4 flex h-4 overflow-hidden rounded-md bg-muted" role="img" aria-label={labels.donut}>
              {categories.map((key, index) => aggregate[key] > 0 ? <span key={key} style={{ background: colors[index], width: `${(aggregate[key] / aggregateTotal) * 100}%` }} /> : null)}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">{categories.map((key, index) => <div key={key} className="flex items-center gap-2"><span aria-hidden="true" className="size-2 shrink-0 rounded-sm" style={{ background: colors[index] }} /><dt className="truncate">{labels[key]}</dt><dd className="ml-auto font-mono tabular-nums">{compact(aggregate[key])}</dd></div>)}</dl>
          </>}
        </Panel>
      </div>
      <Panel title={labels.heatmap} action={day ? <Button size="sm" variant="outline" onClick={() => setDay(undefined)}>{day} ×</Button> : undefined}>
        <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-14 lg:grid-cols-28">{days.map((item) => <button key={item.date} type="button" disabled={!item.value} aria-pressed={day === item.date} aria-label={`${item.date}: ${item.value ? `${item.value.tokens} Token, ${money(item.value.cost)}` : "—"}`} title={`${item.date}: ${item.value ? `${item.value.tokens} Token` : "—"}`} onClick={() => setDay((old) => old === item.date ? undefined : item.date)} className={`aspect-square min-h-5 rounded-sm border focus-visible:outline-2 focus-visible:outline-primary ${day === item.date ? "ring-2 ring-primary ring-offset-2" : ""}`} style={{ background: item.value ? `color-mix(in srgb, #0891b2 ${20 + item.value.tokens / max * 80}%, var(--background))` : "var(--muted)" }} />)}</div>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">{labels.utc}</p>
        <details className="mt-3 text-xs"><summary className="cursor-pointer">UTC / Token / USD</summary><div className="mt-3 max-h-52 space-y-2 overflow-y-auto">{data?.days.map((item) => <button type="button" key={item.date} onClick={() => setDay(item.date)} className="flex w-full flex-wrap justify-between gap-2 rounded border p-2 font-mono"><span>{item.date}</span><span>{item.tokens.toLocaleString()} Token</span><span>{item.turns ?? 0} {labels.turnsLabel}</span><span>{item.toolCalls ?? 0} {labels.toolCalls}</span><span>{item.toolsMs !== undefined ? duration(item.toolsMs) : null}</span><span>{item.wallMs !== undefined ? `${labels.wall} ${duration(item.wallMs)}` : null}</span><span>{money(item.cost)}</span></button>)}</div></details>
      </Panel>
      <div className="flex flex-wrap gap-3"><input aria-label={labels.search} placeholder={labels.search} value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 rounded-md border bg-background p-2 text-sm" /><Select aria-label="Sort" value={sort} onChange={(event) => setSort(event.target.value)}><option value="recent">{labels.latest}</option><option value="tokens">{labels.actual}</option><option value="context">{labels.estimate}</option></Select></div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{members.map((member) => <article key={member.sessionID} className="min-w-0 rounded-xl border bg-card p-5"><Link to={`/session/${member.sessionID}`} className="mb-2 block break-words text-sm font-semibold underline-offset-4 hover:underline">{member.title}</Link><p className="mb-4 break-all font-mono text-[10px] text-muted-foreground">{member.sessionID}</p><div className="mb-4 flex flex-wrap justify-between gap-3 border-b pb-3 text-xs"><span>{labels.lifetime}: {compact(tokenTotal(member.usage))} Token</span><span className="font-mono">{money(member.usage.cost)}</span></div>{member.latest ? <Composition request={member.latest} labels={labels} /> : <p className="text-xs text-muted-foreground">{labels.empty}</p>}</article>)}</div>
      {!members.length && <p className="py-12 text-center text-sm text-muted-foreground">{labels.empty}</p>}
    </>}
  </div></div>
}
