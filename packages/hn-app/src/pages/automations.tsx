import { useEffect, useRef, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router"
import { ArrowLeft, ArrowUpRight, Boxes, Check, ChevronRight, Circle, LoaderCircle, Play, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Input } from "@/components/ui/input"
import {
  automationApi,
  businessStages,
  operationLabel,
  repairSaveNotice,
  runStatusLabel,
  stepDisplayStatus,
  type AutomationApp,
  type AutomationRun,
} from "@/lib/automation-apps"
import { browserApi } from "@/lib/browser"
import { baseFetch } from "@/lib/base-api"
import { BrowserNavigationToggle } from "./cdp/layout"
import { BrowserPanel } from "@/features/browser-cdp/browser-panel"
import { instructionApi, type InstructionApp } from "@/lib/instruction-apps"

export function AutomationsPage() {
  const [items, setItems] = useState<AutomationApp[]>([])
  const [legacyItems, setLegacyItems] = useState<InstructionApp[]>([])
  const [query, setQuery] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let stopped = false
    setLoading(true)
    void Promise.allSettled([automationApi.list(), instructionApi.apps()])
      .then(([result, legacy]) => {
        if (!stopped) {
          if (result.status === "fulfilled") setItems(result.value.items)
          if (legacy.status === "fulfilled") setLegacyItems(legacy.value.items)
          setError(result.status === "rejected" ? `固定流程加载失败：${String(result.reason)}` : legacy.status === "rejected" ? `旧版应用加载失败：${String(legacy.reason)}` : "")
        }
      })
      .finally(() => {
        if (!stopped) setLoading(false)
      })
    return () => {
      stopped = true
    }
  }, [revision])
  const filtered = items.filter((item) =>
    `${item.definition.name} ${item.definition.description}`.toLowerCase().includes(query.toLowerCase()),
  )
  const migrated = new Set(items.flatMap((item) => item.legacyAppId ? [item.legacyAppId] : []))
  const filteredLegacy = legacyItems.filter((item) => !migrated.has(item.id) &&
    `${item.definition.name} ${item.definition.description}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <div className="chat-workspace h-full overflow-y-auto bg-slate-50 p-5 md:p-9">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="mb-2 text-xs tracking-widest text-muted-foreground">把做成的事，留给下一次</p>
            <div className="flex items-center gap-2"><BrowserNavigationToggle /><h1 className="text-2xl font-semibold tracking-tight">自动化应用</h1></div>
             <p className="mt-3 text-sm text-muted-foreground">和 AI 讨论、验证并发布流程；运行时直接执行固定步骤，异常时再请 AI 协助修复。旧版 AI 执行应用也在这里。</p>
          </div>
          <Button asChild size="sm">
            <Link to="/cdp">
              <Plus className="me-2 size-4" />
               和 AI 设计应用
            </Link>
          </Button>
        </header>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <Input
            aria-label="搜索自动化应用"
            placeholder="搜索名称或说明…"
            className="max-w-sm bg-white"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {error && (
          <div role="alert" className="mb-4 text-sm text-destructive">
            {error}
            <Button size="sm" variant="ghost" onClick={() => setRevision((r) => r + 1)}>
              重试
            </Button>
          </div>
        )}
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在加载应用…
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
             {filtered.map((item) => (
              <Link
                key={item.id}
                to={`/cdp/apps/${item.id}`}
                className="group rounded-2xl border border-slate-200 bg-white p-6 transition-colors hover:border-indigo-300"
              >
                <div className="flex items-center gap-3">
                   <Boxes className="size-4 text-indigo-500" />
                   <h2 className="flex-1 text-sm font-semibold">{item.definition.name}</h2>
                   <span className="rounded bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800">固定流程</span>
                   <ArrowUpRight className="size-4 text-muted-foreground" />
                </div>
                <p className="mt-3 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">
                  {item.definition.description || "暂无说明"}
                </p>
                <div className="mt-5 flex justify-between border-t pt-3 text-[11px] text-muted-foreground">
                  <span>
                    {businessStages(item.definition.steps).length} 个业务阶段 · {item.definition.parameters.length} 个参数
                  </span>
                  <span>v{item.version}</span>
                </div>
               </Link>
             ))}
             {filteredLegacy.map((item) => (
               <Link
                 key={item.id}
                 to={`/cdp/instruction-apps/${item.id}`}
                 className="group rounded-2xl border border-slate-200 bg-white p-6 transition-colors hover:border-amber-300"
               >
                 <div className="flex items-center gap-3">
                   <Boxes className="size-4 text-amber-600" />
                   <h2 className="flex-1 text-sm font-semibold">{item.definition.name}</h2>
                   <span className="rounded bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">待升级 · AI 执行</span>
                   <ArrowUpRight className="size-4 text-muted-foreground" />
                 </div>
                 <p className="mt-3 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">{item.definition.description || "暂无说明"}</p>
                 <div className="mt-5 flex justify-between border-t pt-3 text-[11px] text-muted-foreground">
                   <span>{item.definition.instructions.length} 个业务步骤 · {item.definition.parameters.length} 个参数</span>
                   <span>v{item.version}</span>
                 </div>
               </Link>
             ))}
             {!filtered.length && !filteredLegacy.length && (
              <div className="col-span-full rounded-2xl border border-dashed bg-white px-6 py-16 text-center">
                 <h2 className="text-sm font-medium">{query ? "没有匹配的应用" : "和 AI 一起设计你的第一条自动化流程"}</h2>
                <p className="mt-3 text-xs leading-6 text-muted-foreground">
                   先讨论和验证流程，再发布为可重复运行的应用。
                </p>
                <Button asChild className="mt-5" variant="outline">
                   <Link to="/cdp">和 AI 设计应用</Link>
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function AutomationDetailPage() {
  const { automationId = "" } = useParams()
  return <AutomationDetail key={automationId} id={automationId} />
}

function AutomationDetail({ id }: { id: string }) {
  const [search, setSearch] = useSearchParams()
  const runId = search.get("run") ?? ""
  const [app, setApp] = useState<AutomationApp | null>(null)
  const [history, setHistory] = useState<AutomationRun[]>([])
  const [run, setRun] = useState<AutomationRun | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [sessions, setSessions] = useState<Array<{ id: string; title?: string }>>([])
  const [sessionId, setSessionId] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [confirmedScripts, setConfirmedScripts] = useState(false)
  // 执行详情在右侧面板查看；选中哪个业务阶段就展示哪个。
  // 执行详情默认跟随步骤状态：执行中/暂停时自动展开，完成后自动收起；用户点击可覆盖。
  const [detailOverrides, setDetailOverrides] = useState<Record<string, boolean>>({})
  const [revision, setRevision] = useState(0)
  // 恢复/修复后需要重启轮询；不用 URL 时间戳，避免时间戳相同时不重跑。
  const [pollKey, setPollKey] = useState(0)
  const pending = useRef<{ sessionId: string; requestKey: string; parameters: Record<string, string>; confirmed?: boolean } | null>(null)
  const submitted = useRef(false)
  useEffect(() => {
    let stopped = false
    void Promise.all([
      automationApi.detail(id),
      baseFetch<{ items: Array<{ id: string; title?: string }> }>("/api/sessions"),
    ])
      .then(([result, available]) => {
        if (stopped) return
        setApp(result.app)
        setHistory(result.runs)
        setSessions(available.items)
        setError("")
        setValues((current) =>
          Object.keys(current).length
            ? current
            : Object.fromEntries(result.app.definition.parameters.map((p) => [p.key, p.defaultValue])),
        )
      })
      .catch((cause) => {
        if (!stopped) setError(String(cause))
      })
    return () => {
      stopped = true
    }
  }, [id, revision])
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>
    setRun(null)
    if (!runId) return
    const poll = async () => {
      try {
        const current = await automationApi.status(runId)
        if (stopped) return
        if (current.appId !== id) throw new Error("运行不属于当前应用")
        setRun(current)
        if (["queued", "running", "repairing"].includes(current.status)) timer = setTimeout(poll, 1500)
        else setRevision((r) => r + 1)
      } catch (cause) {
        if (!stopped) setError(String(cause))
      }
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [id, runId, pollKey])
  const selectRun = (current: AutomationRun) => {
    setRun(current)
    setDetailOverrides({})
    setSearch({ run: current.id })
  }
  const action = async (fn: () => Promise<void>) => {
    if (submitted.current) return
    submitted.current = true
    setBusy(true)
    setError("")
    try {
      await fn()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      submitted.current = false
      setBusy(false)
    }
  }
  const start = () =>
    action(async () => {
      if (!app) return
      if (!pending.current) {
        const browser = app.definition.steps.some((step) => step.operation.type === "browser")
        const session =
          sessionId ||
          (browser
            ? (await browserApi.create({ title: app.definition.name })).session.id
            : (
                await baseFetch<{ session: { id: string } }>("/api/sessions", {
                  method: "POST",
                  body: JSON.stringify({ title: app.definition.name }),
                })
              ).session.id)
        pending.current = { sessionId: session, requestKey: crypto.randomUUID(), parameters: { ...values }, confirmed: confirmedScripts }
      }
      const current = await automationApi.run(id, pending.current)
      pending.current = null
      setHistory((items) => [current, ...items.filter((item) => item.id !== current.id)])
      selectRun(current)
    })
  const resume = (answer: "confirm" | "retry" | "skip" | "stop") =>
    action(async () => {
      if (!run) return
      const current = await automationApi.resume(run.id, answer)
      // 恢复后重启轮询，等待后续步骤推进。
      setRun(current)
      setPollKey((key) => key + 1)
    })
  const hasBrowser = app?.definition.steps.some((step) => step.operation.type === "browser")
  const currentResult = run?.results[run.cursor]
  const currentOperation = currentResult?.repairedOperation ?? run?.definition.steps[run.cursor]?.operation
  return (
     <div className="chat-workspace h-full overflow-y-auto bg-[#f5f7f7] px-4 py-6 md:px-10 md:py-10">
       <div className="mx-auto max-w-6xl">
         <div className="mb-7 flex w-fit items-center gap-2">
          <BrowserNavigationToggle />
          <Link to="/cdp/apps" className="flex items-center gap-2 text-xs font-medium text-slate-500 hover:text-slate-900">
          <ArrowLeft className="size-3" />
          自动化应用
        </Link>
         </div>
        {error && (
          <p role="alert" className="mb-5 text-sm text-destructive">
            {error}
            <Button variant="ghost" size="sm" onClick={() => setRevision((r) => r + 1)}>
              刷新
            </Button>
          </p>
        )}
        {!app && !error && (
          <div role="status" aria-live="polite" aria-busy="true" className="animate-pulse">
            <span className="sr-only">正在加载应用…</span>
            <div className="mb-8 border-b border-slate-200 pb-7">
              <div className="flex flex-wrap items-center gap-3">
                <Skeleton className="h-8 w-64 max-w-full rounded-lg bg-slate-200/80 md:h-9" />
                <Skeleton className="h-6 w-24 rounded-full bg-slate-200/70" />
              </div>
              <Skeleton className="mt-4 h-4 w-full max-w-2xl rounded bg-slate-200/60" />
              <Skeleton className="mt-2 h-4 w-2/3 max-w-xl rounded bg-slate-200/60" />
            </div>
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_12px_32px_-28px_#0f172a55] md:p-7">
                <Skeleton className="h-3 w-20 rounded bg-slate-200/70" />
                <Skeleton className="mt-3 h-6 w-28 rounded bg-slate-200/80" />
                <Skeleton className="mt-3 h-3.5 w-52 rounded bg-slate-200/60" />
                <div className="mt-6 space-y-5 border-t border-slate-100 pt-5">
                  {[0, 1, 2].map((index) => (
                    <div key={index} className="flex gap-4">
                      <Skeleton className="size-9 shrink-0 rounded-xl bg-slate-200/70" />
                      <div className="min-w-0 flex-1 space-y-2 pt-1">
                        <Skeleton className="h-4 w-40 rounded bg-slate-200/70" />
                        <Skeleton className="h-3 w-24 rounded bg-slate-200/50" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_12px_32px_-28px_#0f172a55] md:p-6">
                <Skeleton className="h-3 w-16 rounded bg-slate-200/70" />
                <Skeleton className="mt-3 h-6 w-24 rounded bg-slate-200/80" />
                <Skeleton className="mt-2 h-3.5 w-44 rounded bg-slate-200/60" />
                <div className="mt-5 space-y-4 border-t border-slate-100 pt-4">
                  <Skeleton className="h-9 w-full rounded-md bg-slate-200/60" />
                  <Skeleton className="h-9 w-full rounded-md bg-slate-200/60" />
                  <Skeleton className="h-10 w-full rounded-md bg-slate-300/70" />
                </div>
              </div>
            </div>
          </div>
        )}
        {app && (
          <>
              <header className="mb-8 border-b border-slate-200 pb-7">
               <div className="flex flex-wrap items-center gap-3">
                 <h1 className="text-2xl font-semibold tracking-tight text-slate-950 md:text-3xl">{app.definition.name}</h1>
                 <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600">v{app.version} · 已发布</span>
               </div>
               <p className="mt-3 line-clamp-2 max-w-3xl text-sm leading-6 text-slate-600">{app.definition.description.split(/[：:；。]/)[0]}</p>
               {app.definition.description && <details className="group mt-2 max-w-3xl text-xs text-slate-500">
                 <summary className="flex w-fit cursor-pointer list-none items-center gap-1 font-medium text-teal-700 hover:text-teal-900 [&::-webkit-details-marker]:hidden">查看完整业务说明 <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" /></summary>
                 <p className="mt-3 whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-white p-4 leading-6">{app.definition.description}</p>
               </details>}
             </header>
             <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 space-y-6">
                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_12px_32px_-28px_#0f172a55] md:p-7">
                   <div aria-label="运行详情">
                     <div className="flex flex-wrap items-center justify-between gap-3">
                        <div><p className="text-[11px] font-semibold tracking-[0.16em] text-teal-700">RUN FLOW</p><h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">执行进度</h2></div>
                        {run && <span role="status" className={`rounded-full px-3 py-1 text-xs font-semibold ${run.status === "succeeded" ? "bg-emerald-50 text-emerald-700" : run.status === "paused" || run.status === "failed" ? "bg-amber-50 text-amber-800" : "bg-teal-50 text-teal-700"}`}>{runStatusLabel[run.status]}</span>}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs text-slate-500">{run ? `运行版本 v${run.appVersion} · 已完成 ${businessStages(run.definition.steps).filter((stage) => stage.entries.every(({ index }) => run.results[index]?.status === "succeeded")).length}/${businessStages(run.definition.steps).length} 个业务阶段` : `${businessStages(app.definition.steps).length} 个业务阶段`}</p>
                        {run && <Link
                          className="text-xs font-medium text-teal-700 hover:text-teal-900"
                         to={hasBrowser ? `/cdp/session/${run.sessionId}` : `/free-chat/session/${run.sessionId}`}
                       >
                         打开会话与文件 ↗
                       </Link>}
                     </div>
                     <ol aria-live="polite" className="relative mt-6">
                       {businessStages(run?.definition.steps ?? app.definition.steps).map((stage, stageIndex, all) => {
                          const states = stage.entries.map(({ index }) => stepDisplayStatus(run, index))
                          const state = states.every((item) => item === "已完成") ? "已完成"
                            : states.includes("修复中") ? "修复中"
                            : states.includes("已暂停") ? "已暂停"
                            : states.includes("执行中") ? "执行中" : "待执行"
                          // 默认随状态：执行中/暂停自动展开，完成后自动收起；用户手动点过则以点击为准。
                          const live = state === "执行中" || state === "修复中" || state === "已暂停"
                          const detailOpen = detailOverrides[stage.title] ?? live
                        return (
                           <li key={stage.entries[0]!.step.id} className="relative flex gap-4 pb-6 last:pb-0">
                              {stageIndex < all.length - 1 && (
                                <span aria-hidden className="absolute start-[17px] top-9 bottom-0 w-px bg-slate-200" />
                              )}
                              <div className={`relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full ring-4 ring-white ${state === "已完成" ? "bg-emerald-50 text-emerald-700" : state === "执行中" || state === "修复中" ? "bg-teal-700 text-white" : state === "已暂停" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-400"}`}>
                                {state === "已完成" ? <Check className="size-4" /> : state === "执行中" || state === "修复中" ? <LoaderCircle className="size-4 animate-spin" /> : state === "已暂停" ? <Circle className="size-4" /> : <span className="text-xs font-semibold">{stageIndex + 1}</span>}
                             </div>
                             <div className="min-w-0 flex-1">
                                {/* 状态与标题同一行、按钮与描述同一行，右列上下堆叠且逐行对齐。 */}
                                <div className="flex items-start justify-between gap-3">
                                  <span className="min-w-0 truncate text-sm font-semibold text-slate-900" title={stage.title}>{stage.title}</span>
                                  {run && <span className={`shrink-0 text-xs font-medium ${state === "已完成" ? "text-emerald-700" : state === "执行中" || state === "修复中" ? "text-teal-700" : state === "已暂停" ? "text-amber-700" : "text-slate-400"}`}>{state}</span>}
                                </div>
                             {/* 一个业务阶段的全部指令合并为一行；过长省略，hover 显示全文。未运行时只列动作，不显示状态。 */}
                             <div className="mt-2 flex items-center justify-between gap-3 text-xs text-slate-500">
                               <p
                                 className="min-w-0 truncate"
                                 title={stage.entries.map(({ step, index }) => `${step.title} · ${run ? stepDisplayStatus(run, index) : operationLabel(step)}`).join(" · ")}
                               >
                                 {stage.entries.map(({ step, index }) => `${step.title} · ${run ? stepDisplayStatus(run, index) : operationLabel(step)}`).join(" · ")}
                               </p>
                               {run && stage.entries.some(({ index }) => {
                                 const result = run.results[index]
                                 return !!result?.repairAttempts || !!result?.output || result?.status === "running"
                               }) && (
                                 <Button
                                   size="sm"
                                   variant="ghost"
                                   className="h-6 shrink-0 px-1.5 text-xs font-normal text-teal-700 hover:text-teal-900"
                                   aria-expanded={detailOpen}
                                   onClick={() => setDetailOverrides((current) => ({ ...current, [stage.title]: !detailOpen }))}
                                 >
                                   {detailOpen ? "收起执行详情" : "查看执行详情"}
                                 </Button>
                               )}
                             </div>
                             {/* 执行详情就地展开在当前卡片内，逐个指令列出输出。 */}
                             {run && detailOpen && (
                               <div className="mt-3 space-y-3 rounded-lg border border-slate-100 bg-slate-50/60 p-3">
                                 {stage.entries.map(({ step, index }) => {
                                   const result = run.results[index]
                                   return (
                                     <div key={step.id}>
                                       <div className="flex items-center justify-between gap-2">
                                         <p className="min-w-0 truncate text-xs font-medium text-slate-700" title={step.title}>{step.title}</p>
                                         <span className="shrink-0 text-[11px] text-slate-500">{stepDisplayStatus(run, index)}</span>
                                       </div>
                                       {!!result?.repairAttempts && <p className="mt-1 text-xs text-indigo-600">已尝试局部修复 {result.repairAttempts} 次</p>}
                                       {result?.output
                                         ? <pre className="mt-1.5 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md bg-white p-2.5 text-[11px] leading-5">{result.output}</pre>
                                         : <p className="mt-1 text-[11px] text-slate-400">暂无输出</p>}
                                     </div>
                                   )
                                 })}
                               </div>
                             )}
                             </div>
                          </li>
                        )
                      })}
                    </ol>
                     {run?.status === "paused" && (
                      <div className="mt-4 space-y-3 rounded-xl border border-amber-200 bg-amber-50/50 p-4">
                        <p role="status" className="text-sm leading-6">
                          {run.error}
                        </p>
                        <p className="text-xs leading-5 text-muted-foreground">
                          先核实当前页面和已有文件；已完成的步骤不会重跑。登录、验证码与权限问题请在会话中手动处理。
                        </p>
                        {currentOperation?.type === "script" && (
                          <details className="text-xs">
                            <summary className="cursor-pointer">查看将执行的固定脚本</summary>
                            <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap">
                              {currentOperation.source}
                            </pre>
                          </details>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <Button disabled={busy} size="sm" onClick={() => void resume("confirm")}>
                            已核实，确认执行此步
                          </Button>
                          <Button disabled={busy} size="sm" variant="outline" onClick={() => void resume("skip")}>
                            此步已完成，继续下一步
                          </Button>
                          {currentOperation?.type === "script" &&
                            currentResult?.pauseReason !== "confirmation" &&
                            (currentResult?.repairAttempts ?? 0) < 2 && (
                              <Button
                                disabled={busy}
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  void action(async () => {
                                    const repairing = await automationApi.repair(run.id)
                                    setRun(repairing)
                                    // 修复由 worker 异步生成方案，重启轮询等待结果。
                                    setPollKey((key) => key + 1)
                                  })
                                }
                              >
                                让 AI 修复此步
                              </Button>
                            )}
                          <Button disabled={busy} size="sm" variant="ghost" onClick={() => void resume("stop")}>
                            结束运行
                          </Button>
                        </div>
                      </div>
                    )}
                     {repairSaveNotice(run) === "saved" && <p className="mt-5 rounded-xl bg-emerald-50 p-4 text-sm">修复已自动保存为新版本，请核对产物是否符合业务预期。</p>}
                     {repairSaveNotice(run) === "skipped" && (
                        <p className="mt-5 rounded-xl bg-amber-50 p-4 text-sm">
                          本次有步骤为跳过完成，修复未经完整重跑验证，未保存到应用。
                        </p>
                      )}
                   </div>
                 </section>
                {run && hasBrowser && (
                  <div className="flex h-[480px] min-h-0 flex-col overflow-hidden rounded-2xl border bg-white">
                    <BrowserPanel sessionId={run.sessionId} working={run.status === "running"} />
                  </div>
                )}
              </div>
               <aside className="space-y-5 lg:sticky lg:top-6">
                 <form
                   className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_12px_32px_-28px_#0f172a55] md:p-6"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void start()
                  }}
                >
                   <div className="border-b border-slate-100 pb-4"><p className="text-[11px] font-semibold tracking-[0.16em] text-teal-700">NEW RUN</p><h2 className="mt-1 text-lg font-semibold text-slate-900">运行应用</h2><p className="mt-1 text-xs text-slate-500">填写参数后，按已发布流程顺序执行。</p></div>
                  {app.definition.parameters.map((parameter) => (
                    <label key={parameter.key} className="block space-y-2 text-sm">
                      <span>
                        {parameter.label}
                        {parameter.required ? " *" : ""}
                      </span>
                      <Input
                        required={parameter.required}
                        maxLength={8000}
                        value={values[parameter.key] ?? ""}
                    onChange={(e) => { pending.current = null; setValues((current) => ({ ...current, [parameter.key]: e.target.value })) }}
                      />
                    </label>
                  ))}
                  <label className="block space-y-2 text-sm">
                    <span>运行工作区</span>
                    <select
                      aria-label="运行工作区"
                      className="h-9 w-full rounded-md border bg-white px-2 text-xs"
                      value={sessionId}
                      onChange={(e) => {
                        pending.current = null
                        setSessionId(e.target.value)
                      }}
                    >
                      <option value="">新建独立会话</option>
                      {sessions.map((session) => (
                        <option value={session.id} key={session.id}>
                          {session.title || session.id}
                        </option>
                      ))}
                    </select>
                  </label>
                   {app.definition.steps.some((step) => step.operation.type === "script") && <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" checked={confirmedScripts} onChange={(event) => { pending.current = null; setConfirmedScripts(event.target.checked) }} /><span>我已核对已发布脚本和本次参数，确认本次运行中的固定脚本直接执行；脚本可能读写工作区文件。</span></label>}
                   <details className="text-xs leading-5 text-slate-500"><summary className="cursor-pointer">工作区与确认说明</summary><p className="mt-2">需要已有文件或登录状态时，选择原会话。新会话不会自动复制文件或登录状态。网页点击仍需逐步确认。</p></details>
                  <Button
                    type="submit"
                      disabled={busy || (app.definition.steps.some((step) => step.operation.type === "script") && !confirmedScripts) || (!!run && ["queued", "running", "paused", "repairing"].includes(run.status))}
                     className="h-10 w-full bg-teal-700 text-white hover:bg-teal-800"
                  >
                    <Play className="me-2 size-3" />
                    {busy ? "正在处理…" : "运行应用"}
                  </Button>
                </form>
                <section className="rounded-2xl border bg-white p-6">
                  <h2 className="text-sm font-semibold">通过 API 运行</h2>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    使用当前账号的登录凭证调用；先创建会话或使用有运行权限的已有会话。相同请求请复用同一个 requestKey。
                  </p>
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer">查看接口与参数</summary>
                    <p className="mt-3 break-all font-mono">POST /api/automation-apps/{id}/runs</p>
                    <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-3">{JSON.stringify({ sessionId: "已有会话 ID", requestKey: "每次运行生成的 UUID", parameters: Object.fromEntries(app.definition.parameters.map((parameter) => [parameter.key, parameter.defaultValue])) }, null, 2)}</pre>
                    <p className="mt-3 leading-5 text-muted-foreground">返回运行 ID 后，通过 GET /api/automation-apps/runs/&#123;runId&#125; 查询。状态为 paused 时需核实，使用 POST /api/automation-apps/runs/&#123;runId&#125;/resume 并提交 JSON，例如 &#123;"action":"confirm"&#125;；也可选择 skip 或 stop，不要盲目重试。</p>
                  </details>
                </section>
                <section className="rounded-2xl border bg-white p-6">
                  <h2 className="mb-3 text-sm font-semibold">运行记录</h2>
                  {history.length ? (
                    <ul className="divide-y">
                      {history.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => selectRun(item)}
                            className="flex w-full items-center justify-between gap-2 py-3 text-start text-xs"
                            aria-current={run?.id === item.id ? "true" : undefined}
                          >
                            <span>{new Date(item.timeCreated).toLocaleString()}</span>
                            <span className="text-muted-foreground">{runStatusLabel[item.status]}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">还没有运行记录</p>
                  )}
                </section>
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
