import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { Link } from "react-router"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { contextInsights, watchContext } from "@/lib/context-insights"
import { cacheRate, categories, compact, filterEvents, filterFiles, labels as dictionaries, lineDelta, money, readPreferences, sortFiles, tokenTotal, trendPoints, writePreferences, type Preferences } from "./model"
import { Composition, DurationCurve, FamilyView, markerIndex, Panel, PointMetrics, RequestBrowser, ResourceError, Select, TimingStrip, Trend } from "./views"
import { useResource } from "./use-resource"
import { FilePreviewDialog } from "@/components/session/file-preview-dialog"

export function SessionInsights({ sessionID, embedded = false }: { sessionID: string; embedded?: boolean }) {
  const [prefs, setPrefs] = useState(readPreferences)
  const labels = dictionaries[prefs.locale]
  const [tab, setTabState] = useState<"summary" | "browser" | "fleet" | "events" | "files">("summary")
  const [before, setBefore] = useState<number>()
  const [selected, setSelected] = useState<string>()
  const [query, setQuery] = useState("")
  const [eventType, setEventType] = useState<string>("all")
  const [fileAction, setFileAction] = useState<string>("all")
  const [openFile, setOpenFile] = useState<string>()
  const [previewPath, setPreviewPath] = useState<string>()
  const tabsID = useId()
  const summary = useResource(sessionID, (signal) => contextInsights.summary(sessionID, signal))
  const analysis = useResource(`${sessionID}:${before ?? "latest"}`, (signal) => contextInsights.analysis(sessionID, before, signal))
  const family = useResource(sessionID, (signal) => contextInsights.family(sessionID, signal))
  const refresh = useCallback(() => { summary.reload(); analysis.reload(); family.reload() }, [summary.reload, analysis.reload, family.reload])
  useEffect(() => watchContext(sessionID, refresh), [sessionID, refresh])
  useEffect(() => { writePreferences(prefs) }, [prefs])
  const settings = useRef<HTMLDetailsElement>(null)
  // `<details>` does not close on outside clicks; close it so the popover cannot cover the panel.
  useEffect(() => {
    const close = (event: MouseEvent) => {
      const element = settings.current
      if (element?.open && !element.contains(event.target as Node)) element.open = false
    }
    document.addEventListener("pointerdown", close)
    return () => document.removeEventListener("pointerdown", close)
  }, [])
  const preference = <K extends keyof Preferences>(key: K, value: Preferences[K]) => setPrefs((old) => ({ ...old, [key]: value }))
  const basePoints = useMemo(() => analysis.data?.points ?? [], [analysis.data])
  const points = useMemo(() => {
    const grouped = trendPoints(basePoints, prefs.granularity)
    if (prefs.deltaBase === "previous" || grouped.length === 0) return grouped
    const first = grouped[0]?.request.estimatedTokens ?? 0
    return grouped.map((point, index) => index === 0 ? { ...point, delta: null } : { ...point, delta: point.request.estimatedTokens - first })
  }, [basePoints, prefs.granularity, prefs.deltaBase])
  const point = analysis.data?.points.find((item) => item.request.id === selected) ?? analysis.data?.points.at(-1)
  const pointIndex = analysis.data?.points.findIndex((item) => item.request.id === point?.request.id) ?? -1
  const previousPoint = pointIndex > 0 ? analysis.data?.points[pointIndex - 1] : undefined
  const markers = useMemo(() => markerIndex(analysis.data?.points ?? [], analysis.data?.events ?? []), [analysis.data])
  const request = point?.request ?? (before === undefined ? summary.data?.latest : null)
  const member = family.data?.members.find((item) => item.sessionID === sessionID)
  const hit = member ? cacheRate(member.usage) : null
  const eventTypes = useMemo(
    () => Array.from(new Set((analysis.data?.events ?? []).map((event) => event.type))),
    [analysis.data],
  )
  const events = useMemo(() => filterEvents(analysis.data?.events ?? [], eventType), [analysis.data, eventType])
  const files = useMemo(
    () => sortFiles(filterFiles(analysis.data?.files ?? [], query, fileAction), prefs.fileSort),
    [analysis.data, query, fileAction, prefs.fileSort],
  )
  const incoming = useMemo(() => {
    const index = basePoints.findIndex((item) => item.request.id === point?.request.id)
    const previous = index > 0 ? basePoints[index - 1] : undefined
    if (!previous || !point) return []
    return categories
      .map((key) => ({ key, value: point.request.composition[key] - previous.request.composition[key] }))
      .filter((entry) => entry.value !== 0)
  }, [basePoints, point])
  const fileTotals = useMemo(
    () => files.reduce((total, file) => ({ added: total.added + (file.added ?? 0), removed: total.removed + (file.removed ?? 0) }), { added: 0, removed: 0 }),
    [files],
  )
  const tabs = useMemo<ReadonlyArray<"summary" | "browser" | "fleet" | "events" | "files">>(
    () => (prefs.fleetTab ? ["summary", "browser", "fleet", "events", "files"] : ["summary", "browser", "events", "files"]),
    [prefs.fleetTab],
  )
  // Hiding the family tab must not leave an unreachable panel selected.
  const tabVisible = tabs.includes(tab) ? tab : "summary"
  useEffect(() => { if (tab !== tabVisible) setTabState("summary") }, [tab, tabVisible])
  const control = "rounded-md border bg-background px-2 py-1.5 text-xs"
  return <div className={`min-w-0 ${embedded ? "p-1" : "mx-auto max-w-7xl p-4 sm:p-7"}`}>
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b pb-5">
      <div className="min-w-0"><p className="mb-1 font-mono text-[10px] uppercase tracking-[.18em] text-muted-foreground">CONTEXT / OBSERVATORY</p><h1 className="text-xl font-semibold tracking-tight">{labels.title}</h1><p className="mt-2 break-all text-xs text-muted-foreground">{member?.title ?? sessionID}</p></div>
      <div className="flex flex-wrap items-center gap-2"><Select aria-label="Language" value={prefs.locale} onChange={(event) => preference("locale", event.target.value === "en" ? "en" : "zh")} ><option value="zh">中文</option><option value="en">English</option></Select><details ref={settings} className="relative"><summary className={`${control} cursor-pointer list-none`}>{labels.settings}</summary><div className="absolute end-0 z-10 mt-1 w-64 space-y-2 rounded-md border bg-popover p-3 text-xs shadow-md">
          <label className="flex items-center justify-between gap-2"><span>{labels.placement}</span><Select aria-label={labels.placement} value={prefs.placement} onChange={(event) => preference("placement", event.target.value === "dialog" ? "dialog" : "dock")}><option value="dock">{labels.dock}</option><option value="dialog">{labels.dialog}</option></Select></label>
          <label className="flex items-center justify-between gap-2"><span>{labels.fleet}</span><input type="checkbox" aria-label={labels.fleet} checked={prefs.fleetTab} onChange={(event) => preference("fleetTab", event.target.checked)} /></label>
          <label className="flex items-center justify-between gap-2"><span>{labels.durationCurve}</span><input type="checkbox" aria-label={labels.durationCurve} checked={prefs.durationCurve === "show"} onChange={(event) => preference("durationCurve", event.target.checked ? "show" : "hide")} /></label>
          <label className="flex items-center justify-between gap-2"><span>{labels.insightsEntry}</span><input type="checkbox" aria-label={labels.insightsEntry} checked={prefs.insightsEntry === "show"} onChange={(event) => preference("insightsEntry", event.target.checked ? "show" : "hide")} /></label>
          <label className="flex items-center justify-between gap-2"><span>{labels.delta}</span><Select aria-label={labels.deltaBase} value={prefs.deltaBase} onChange={(event) => preference("deltaBase", event.target.value === "session" ? "session" : "previous")}><option value="previous">{labels.previous}</option><option value="session">{labels.first}</option></Select></label>
        </div></details>
        <Button size="sm" variant="outline" onClick={refresh}><RefreshCw aria-hidden="true" className="mr-1.5 size-3.5" />{labels.refresh}</Button>
        {!embedded && <Link to={`/free-chat/session/${sessionID}`} className="px-2 text-xs underline underline-offset-4">{labels.back}</Link>}
        <Link to="/context-insights" className="px-2 text-xs underline underline-offset-4">{labels.overview}</Link>
      </div>
    </header>
    <p className="mb-4 text-xs leading-5 text-muted-foreground">{labels.historical}</p>
    <ResourceError error={summary.error ?? analysis.error} retry={refresh} label={labels.retry} />
    <dl className="mb-6 grid grid-cols-2 divide-x overflow-hidden rounded-xl border bg-muted/20 md:grid-cols-4">
      {[[labels.requests, summary.data ? String(summary.data.capturedRequests) : "—"], [labels.actual, member ? compact(tokenTotal(member.usage)) : "—"], [labels.cost, member ? money(member.usage.cost) : "—"], [labels.cache, hit === null ? "—" : `${(hit * 100).toFixed(1)}%`]].map(([label, value]) => <div key={label} className="min-w-0 p-4"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="my-2 whitespace-nowrap font-mono text-xl font-medium tabular-nums">{value}</dd><span className="text-[10px] text-muted-foreground">{labels.lifetime}</span></div>)}
    </dl>
    <Tabs value={tabVisible} onValueChange={(value) => setTabState(value as typeof tabVisible)}>
      <TabsList aria-label={labels.title} className="mb-5 h-auto w-full justify-start gap-1 rounded-none border-b bg-transparent p-0">
        {tabs.map((key) => (
          <TabsTrigger key={key} id={`${tabsID}-${key}`} value={key} aria-controls={`${tabsID}-panel`}
            className="rounded-none border-0 border-b-2 border-transparent bg-transparent px-3 py-3 text-xs text-muted-foreground shadow-none outline-none transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary data-[state=active]:border-b-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:font-medium data-[state=active]:shadow-none">
            {labels[key]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
    <div id={`${tabsID}-panel`} role="tabpanel" aria-labelledby={`${tabsID}-${tabVisible}`}>
      {(tabVisible === "summary" || tabVisible === "browser") && <>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Select aria-label={labels.step} wrapClassName="min-w-0 max-w-full flex-1" className={control} value={request?.id ?? ""} onChange={(event) => setSelected(event.target.value)}>
            {!request && <option value="">{labels.empty}</option>}{(analysis.data?.points ?? []).map((item, index) => <option key={item.request.id} value={item.request.id}>{index + 1} · {item.request.kind === "title" ? labels.titleRequest : labels[item.request.kind]} · {new Date(item.request.time).toLocaleTimeString()} · ≈{item.request.estimatedTokens} · {labels[item.status]}</option>)}
          </Select>
          {before !== undefined && <Button size="sm" variant="outline" onClick={() => { setBefore(undefined); setSelected(undefined) }}>{labels.latest}</Button>}
          {analysis.data?.next !== undefined && <Button size="sm" variant="outline" onClick={() => { setBefore(analysis.data?.next); setSelected(undefined) }}>{labels.older}</Button>}
        </div>
        {analysis.data?.pending && <p className="mb-3 text-xs text-muted-foreground">{labels.pendingInputs}: {analysis.data.pending.count}</p>}
        {analysis.data?.epochs && analysis.data.epochs.length > 1 && <p className="mb-3 text-xs text-muted-foreground">{labels.epochs}: {analysis.data.epochs.slice(1).map((epoch) => `${new Date(epoch.time).toLocaleTimeString()} ${[epoch.systemChanged ? labels.system : "", epoch.toolsChanged ? labels.tools : ""].filter(Boolean).join("+")}`).join(" · ")}</p>}
        {analysis.data?.eventsTruncated && <p className="mb-4 text-xs text-amber-700 dark:text-amber-400">{labels.coverage}</p>}
        {!request ? (analysis.loading ? <div className="space-y-3" role="status" aria-live="polite"><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div> : <p className="py-16 text-center text-sm text-muted-foreground">{labels.empty}</p>) : tabVisible === "summary" ? <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <Panel title={labels.estimate}><p className="mb-5 font-mono text-3xl">≈{compact(request.estimatedTokens)}<small className="ml-3 text-xs text-muted-foreground">{request.contextWindow ? `${(request.estimatedTokens / request.contextWindow * 100).toFixed(1)}% / ${compact(request.contextWindow)}` : "Token"}</small></p><Composition request={request} labels={labels} />{point && <div className="mt-5 border-t pt-4"><PointMetrics point={point} labels={labels} /></div>}</Panel>
          <Panel title={labels.summary} action={<div className="flex flex-wrap gap-2"><Select aria-label={labels.overviewBand} value={prefs.trendView} onChange={(event) => preference("trendView", event.target.value === "band" ? "band" : "bars")} ><option value="bars">{labels.bars}</option><option value="band">{labels.overviewBand}</option></Select><Select aria-label={labels.turn} value={prefs.granularity} onChange={(event) => preference("granularity", event.target.value === "turn" ? "turn" : "step")} ><option value="step">{labels.step}</option><option value="turn">{labels.turn}</option></Select><Select aria-label={labels.delta} value={prefs.trend} onChange={(event) => preference("trend", event.target.value === "delta" ? "delta" : "total")} ><option value="total">{labels.total}</option><option value="delta">{labels.delta}</option></Select></div>}><Trend points={points} mode={prefs.trend} selected={request.id} onSelect={setSelected} labels={labels} markers={markers} band={prefs.trendView === "band"} />
            <div className="mt-4 space-y-1 border-t pt-3 text-xs">
              <p className="flex gap-2"><span className="w-14 shrink-0 text-muted-foreground">User</span><span className="min-w-0 break-words">{point?.brief ?? "—"}</span></p>
              <p className="flex gap-2"><span className="w-14 shrink-0 text-muted-foreground">In</span><span className="min-w-0 break-words">{incoming.length === 0 ? "—" : incoming.map((entry) => `${labels[entry.key]} ${entry.value > 0 ? "+" : "−"}${compact(Math.abs(entry.value))}`).join(" · ")}</span></p>
              <p className="flex gap-2"><span className="w-14 shrink-0 text-muted-foreground">Response</span><span className="min-w-0 break-words">{point ? `${labels.assistant} +${compact(point.request.composition.assistant)} · ${labels.tool} +${compact(point.request.composition.tool)}` : "—"}</span></p>
            </div>
            <div className="mt-4 border-t pt-3"><p className="mb-2 text-xs font-medium">{labels.timingStrip}</p><TimingStrip points={points} selected={request.id} onSelect={setSelected} labels={labels} /></div>
            {prefs.durationCurve === "show" && <div className="mt-4 border-t pt-3"><p className="mb-2 text-xs font-medium">{labels.durationCurve}</p><DurationCurve points={points} selected={request.id} onSelect={setSelected} labels={labels} /></div>}
            {analysis.data?.stats && <div className="mt-4 border-t pt-3 text-xs">
              <p className="mb-2 font-medium">{labels.contextStats}</p>
              <dl className="flex flex-wrap gap-x-4 gap-y-2 font-mono tabular-nums">
                {([[labels.turnsLabel, analysis.data.stats.turns], [labels.stepsLabel, analysis.data.stats.steps], [labels.injectShort, analysis.data.stats.injects], [labels.compactions, analysis.data.stats.compactions], [labels.skillsCount, analysis.data.stats.skills], [labels.skillTokens, analysis.data.stats.skillTokens ?? 0], [labels.toolCalls, analysis.data.stats.toolCalls]] as const)
                  .map(([name, value]) => <div key={name} className="flex items-baseline gap-1"><dt className="font-sans text-muted-foreground">{name}</dt><dd>{value}</dd></div>)}
              </dl>
              {analysis.data.stats.tools.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{analysis.data.stats.tools.slice(0, 12).map((tool) => <Badge key={tool.name} variant="secondary" className="font-mono">{tool.name} ×{tool.calls}{tool.failed > 0 ? <span className="ms-1 text-destructive">{tool.failed}✗</span> : null}</Badge>)}</div>}
              {analysis.data.stats.commands.length > 0 && <p className="mt-2 break-words text-muted-foreground">{labels.commands}: {analysis.data.stats.commands.map((command) => `/${command.name} ×${command.calls}`).join(" · ")}</p>}
            </div>}<p className="mt-4 break-all text-xs text-muted-foreground">{request.model.providerID} / {request.model.id}</p><Button variant="outline" size="sm" className="mt-4" onClick={() => setTabState("browser")}>{labels.browser}</Button></Panel>
        </div> : <Panel title={labels.browser} action={<Select aria-label={labels.browser} value={prefs.browser} onChange={(event) => preference("browser", event.target.value === "dna" ? "dna" : "list")} ><option value="list">{labels.list}</option><option value="dna">{labels.dna}</option></Select>}><RequestBrowser key={request.id} sessionID={sessionID} requestID={request.id} mode={prefs.browser} previous={previousPoint?.request.composition} labels={labels} initialSort={prefs.toolSort} onSort={(value) => preference("toolSort", value)} /></Panel>}
      </>}
      {tabVisible === "fleet" && <Panel title={labels.fleet}><ResourceError error={family.error} retry={family.reload} label={labels.retry} />{family.data ? <FamilyView family={family.data} labels={labels} /> : <p role="status">{family.loading ? "…" : labels.noFamily}</p>}</Panel>}
      {tabVisible === "events" && <Panel title={labels.events}><div className="mb-4 flex flex-wrap gap-2"><Select aria-label={labels.events} value={eventType} onChange={(event) => setEventType(event.target.value)}><option value="all">{labels.all}</option>{eventTypes.map((type) => <option key={type} value={type}>{type} ({analysis.data?.events.filter((event) => event.type === type).length ?? 0})</option>)}</Select></div><div className="max-h-[36rem] space-y-0 overflow-y-auto">{!events.length && <p className="text-xs text-muted-foreground">{labels.noEvents}</p>}{events.toReversed().map((event) => <div key={event.seq} className="flex flex-wrap items-start gap-3 border-b py-3 text-xs last:border-0"><time className="font-mono text-muted-foreground">{new Date(event.time).toLocaleTimeString()}</time><Badge variant="secondary">{event.type}</Badge><span className="min-w-0 flex-1 break-words">{event.label}{event.source && <small className="mt-1 block break-all text-muted-foreground">{labels.source}: {event.source}</small>}{event.tokens !== undefined && <Badge variant={event.tokens < 0 ? "secondary" : "outline"} className="ms-2 font-mono">{event.tokens < 0 ? "−" : "+"}{compact(Math.abs(event.tokens))}</Badge>}</span><span className="shrink-0 text-end font-mono text-muted-foreground">{event.turn !== undefined && <span className="me-2">{labels.turn} {event.turn}</span>}#{event.seq}</span></div>)}</div></Panel>}
      {tabVisible === "files" && <Panel title={labels.files}><div className="mb-4 flex flex-wrap gap-2"><input className="min-w-0 flex-1 rounded-md border bg-background p-2 text-xs" placeholder={labels.search} aria-label={labels.search} value={query} onChange={(event) => setQuery(event.target.value)} /><Select aria-label={labels.files} value={fileAction} onChange={(event) => setFileAction(event.target.value)}><option value="all">{labels.all}</option><option value="read">{labels.read}</option><option value="write">{labels.write}</option><option value="search">{labels.searchAction}</option><option value="attachments">{labels.attachmentsFilter}</option></Select><Select aria-label="Sort" value={prefs.fileSort} onChange={(event) => preference("fileSort", event.target.value === "calls" ? "calls" : event.target.value === "path" ? "path" : "recent")}><option value="recent">#</option><option value="calls">{labels.calls}</option><option value="path">A–Z</option></Select></div>{fileAction !== "attachments" && !files.length && <p className="text-xs text-muted-foreground">{labels.noFiles}</p>}
        {fileTotals.added > 0 || fileTotals.removed > 0 ? <p className="mb-3 font-mono text-xs text-muted-foreground">{labels.totals} <span className="text-emerald-600 dark:text-emerald-400">+{compact(fileTotals.added)}</span> <span className="text-rose-600 dark:text-rose-400">−{compact(fileTotals.removed)}</span></p> : null}
        {fileAction === "attachments" && <div className="max-h-[36rem] space-y-2 overflow-y-auto">{(analysis.data?.attachments ?? []).length === 0 ? <p className="text-xs text-muted-foreground">{labels.noAttachments}</p> : (analysis.data?.attachments ?? []).map((attachment) => <div key={`${attachment.requestID}:${attachment.name}`} className="flex flex-wrap gap-2 rounded-lg border p-3 text-xs"><span className="min-w-0 flex-1 break-all font-mono">{attachment.filename ?? attachment.name}</span><span className="rounded bg-muted px-1">{attachment.mediaType}</span><span className="font-mono">{attachment.bytes.toLocaleString()} B</span><span className="rounded bg-muted px-1 text-muted-foreground">{labels.notRetained}</span></div>)}</div>}
        {fileAction !== "attachments" && (analysis.data?.attachments ?? []).length > 0 && <div className="mb-4 rounded-lg border p-3"><p className="mb-2 text-xs font-medium">{labels.attachments}</p><ul className="space-y-1 text-xs text-muted-foreground">{(analysis.data?.attachments ?? []).map((attachment) => <li key={`${attachment.requestID}:${attachment.name}`} className="flex flex-wrap gap-2"><span className="min-w-0 break-all font-mono">{attachment.filename ?? attachment.name}</span><span className="rounded bg-muted px-1">{attachment.mediaType}</span><span className="font-mono">{attachment.bytes.toLocaleString()} B</span><span className="rounded bg-muted px-1">{labels.notRetained}</span></li>)}</ul></div>}
        <div className="max-h-[36rem] space-y-3 overflow-y-auto">{files.map((file) => { const key = `${file.action}:${file.path}`; return <details key={key} className="rounded-lg border p-3 text-xs" open={openFile === key || undefined} onToggle={(event) => setOpenFile((event.currentTarget as HTMLDetailsElement).open ? key : undefined)}><summary className="flex cursor-pointer flex-wrap gap-3"><span className="min-w-0 flex-1 break-all font-mono">{file.target === "file" ? <button type="button" className="text-start underline-offset-4 hover:underline" onClick={(event) => { event.preventDefault(); setPreviewPath(file.path) }}>{file.path}</button> : file.path}<small className="mt-1 block font-sans text-muted-foreground">{file.target === "scope" ? labels.scope : file.action === "read" ? labels.read : file.action === "search" ? labels.searchAction : labels.write}</small></span><span className="shrink-0 text-end">{file.calls}× · {file.failed} {labels.failed}<small className="mt-1 block text-muted-foreground">{file.nested} {labels.nested}</small>{lineDelta(file) && <small className="mt-1 block font-mono"><span className="text-emerald-600 dark:text-emerald-400">+{compact(file.added ?? 0)}</span> <span className="text-rose-600 dark:text-rose-400">−{compact(file.removed ?? 0)}</span></small>}</span></summary>
          <ol className="mt-3 space-y-1 border-t pt-2 font-mono text-[11px] text-muted-foreground">{(file.ops ?? []).map((op, index) => <li key={`${op.seq}:${index}`} className="flex flex-wrap gap-2"><span>#{op.seq}</span>{op.nested && <span className="rounded bg-muted px-1">{labels.nested}</span>}{op.failed && <span className="rounded bg-rose-100 px-1 text-rose-700">{labels.failed}</span>}{op.added !== undefined && <span className="text-emerald-600 dark:text-emerald-400">+{op.added}</span>}{op.removed !== undefined && <span className="text-rose-600 dark:text-rose-400">−{op.removed}</span>}</li>)}</ol>
        </details> })}</div></Panel>}
    </div>
    {previewPath && <FilePreviewDialog href={previewPath} sessionId={sessionID} onOpenChange={(open) => { if (!open) setPreviewPath(undefined) }} />}
  </div>
}
