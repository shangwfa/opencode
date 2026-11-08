import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { BrowserNavigationToggle } from "./cdp/layout"
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Circle, Clock3, LoaderCircle, Play, Sparkles, Terminal, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Markdown } from "@/components/session/markdown"
import { FilePreviewDialog } from "@/components/session/file-preview-dialog"
import { baseFetch } from "@/lib/base-api"
import { automationApi } from "@/lib/automation-apps"
import { timelineMessages, type SessionMessage } from "@/lib/session-messages"
import {
  instructionApi,
  instructionStatusLabel,
  type InstructionApp,
  type InstructionRun,
} from "@/lib/instruction-apps"

const active = (run: InstructionRun | null) =>
  !!run && ["queued", "running", "regenerating"].includes(run.status)

/** 本次运行的执行过程：应用详情页内联展示，不必跳到会话。 */
function RunProcess({ run }: { run: InstructionRun }) {
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [previewHref, setPreviewHref] = useState<string>()
  useEffect(() => {
    let stopped = false
    const load = async () => {
      try {
        const result = await instructionApi.runMessages(run.id)
        if (!stopped) setMessages(result.data as SessionMessage[])
      } catch {
        // 会话已回收或运行尚未开始时忽略
      }
    }
    void load()
    if (!active(run)) return () => { stopped = true }
    const timer = setInterval(load, 2000)
    return () => { stopped = true; clearInterval(timer) }
  }, [run.id, run.status])
  const turns = timelineMessages(run.sessionId, messages)
  const steps = run.steps ?? []
  const completed = steps.filter((step) => step.status === "succeeded").length
  return (
    <div className="mt-7">
      <div className="mb-5 flex items-center justify-between gap-3 border-b border-slate-100 pb-4">
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-slate-900">执行时间线</h3>
          <p className="mt-1 text-xs text-slate-500">按应用指令依次执行 · {completed}/{steps.length} 步已完成</p>
        </div>
        {active(run) && <span className="flex items-center gap-1.5 text-xs text-blue-700"><span className="size-1.5 animate-pulse rounded-full bg-blue-500" />实时更新</span>}
      </div>
      <ol aria-label="步骤进度" className="relative space-y-0">
        {steps.map((step) => {
          const label = step.status === "succeeded" ? "已完成" : step.status === "running" ? "执行中" : step.status === "failed" ? "失败" : "待执行"
          const parts = step.promptId ? turnOf(turns, step.promptId) : []
          const tools = parts.filter((part) => part.type === "tool")
          const streaming = parts.flatMap((part) => part.type === "text" && part.text.trim() ? [part.text] : [])
          const result = step.output || (step.status === "running" ? streaming.at(-1) : undefined)
          const tone = step.status === "succeeded" ? "bg-emerald-50 text-emerald-700 ring-emerald-100" : step.status === "running" ? "bg-blue-50 text-blue-700 ring-blue-100" : step.status === "failed" ? "bg-rose-50 text-rose-700 ring-rose-100" : "bg-slate-50 text-slate-400 ring-slate-100"
          return (
            <li key={step.index} className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-3 pb-6 last:pb-0">
              {step.index < steps.length - 1 && <span aria-hidden="true" className="absolute bottom-0 left-[15px] top-8 w-px bg-slate-200" />}
              <span className={`relative flex size-8 items-center justify-center rounded-full ring-1 ${tone}`}>
                {step.status === "succeeded" ? <Check className="size-4" /> : step.status === "running" ? <LoaderCircle className="size-4 animate-spin" /> : step.status === "failed" ? <TriangleAlert className="size-4" /> : <Circle className="size-3" />}
              </span>
              <div className={`min-w-0 rounded-xl border px-4 py-3.5 ${step.status === "running" ? "border-blue-200 bg-blue-50/40" : "border-slate-200/80 bg-white"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="shrink-0 text-[11px] font-medium tabular-nums text-slate-400">{String(step.index + 1).padStart(2, "0")}</span>
                    <h4 className="truncate text-sm font-medium text-slate-900">{step.title}</h4>
                  </div>
                  <span className={`shrink-0 text-xs ${step.status === "running" ? "font-medium text-blue-700" : step.status === "failed" ? "text-rose-700" : "text-slate-500"}`}>{label}</span>
                </div>
                {result && <div className="mt-3 border-t border-slate-100 pt-3 text-[13px] leading-6 text-slate-700"><Markdown content={result} className="break-words" onFileLink={setPreviewHref} sessionId={run.sessionId} /></div>}
                {step.status === "running" && !result && <p className="mt-3 text-xs text-blue-700">正在处理此步骤，过程会自动更新…</p>}
                {tools.length > 0 && (
                  <details key={`${step.promptId}-${step.status}`} open={step.status === "running" ? true : undefined} className="group mt-3 border-t border-slate-100 pt-3">
                    <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-slate-500 hover:text-slate-800 [&::-webkit-details-marker]:hidden">
                      <Terminal className="size-3.5" />执行明细 · {tools.length} 项<ChevronDown className="ms-auto size-3.5 transition-transform group-open:rotate-180" />
                    </summary>
                    <ol aria-label="执行过程" className="mt-3 space-y-1.5">
                      {tools.map((part) => {
                        if (part.type !== "tool") return null
                        const state = part.state
                        const failure = typeof state?.error === "string" ? state.error : ""
                        return <li key={part.id} className="min-w-0 rounded-md bg-slate-50 px-3 py-2 text-xs">
                          <div className="flex items-center gap-2"><span className="min-w-0 truncate font-mono text-slate-700">{part.tool}</span><span className="ms-auto shrink-0 text-slate-500">{state?.status === "completed" ? "完成" : state?.status === "error" ? "失败" : "进行中"}</span></div>
                          {failure && <p className="mt-1 break-words text-rose-700">{failure}</p>}
                          {typeof state?.output === "string" && state.output && <details className="mt-1"><summary className="cursor-pointer text-slate-500 hover:text-slate-800">查看输出</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] text-slate-600">{state.output}</pre></details>}
                        </li>
                      })}
                    </ol>
                  </details>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      {!steps.length && <p className="rounded-xl border border-dashed p-5 text-xs text-slate-500">{active(run) ? "正在启动执行…" : "本次运行没有步骤记录。"}</p>}
      {run.output && !steps.some((step) => step.output) && <div className="mt-5 border-t pt-4 text-sm text-slate-700"><Markdown content={run.output} onFileLink={setPreviewHref} sessionId={run.sessionId} /></div>}
      <FilePreviewDialog href={previewHref} sessionId={run.sessionId} onOpenChange={(open) => { if (!open) setPreviewHref(undefined) }} />
    </div>
  )
}

/** 取出归属于某个 prompt 的内容块。 */
function turnOf(turns: ReturnType<typeof timelineMessages>, promptId: string) {
  return turns
    .filter((turn) => {
      const parent = "parentID" in turn.info ? turn.info.parentID : undefined
      return parent === promptId || turn.info.id === promptId
    })
    .flatMap((turn) => turn.parts)
}

export function InstructionAppsPage() {
  const [items, setItems] = useState<InstructionApp[]>([])
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  useEffect(() => {
    let stopped = false
    void instructionApi
      .apps()
      .then((result) => {
        if (!stopped) setItems(result.items)
      })
      .catch((cause) => {
        if (!stopped) setError(String(cause))
      })
      .finally(() => {
        if (!stopped) setLoading(false)
      })
    return () => { stopped = true }
  }, [])
  const filtered = items.filter((item) =>
    `${item.definition.name} ${item.definition.description}`.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <div className="chat-workspace h-full overflow-y-auto bg-slate-50 p-5 md:p-9">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="mb-2 text-xs tracking-widest text-muted-foreground">由业务步骤组成，随会话执行</p>
            <div className="flex items-center gap-2"><BrowserNavigationToggle /><h1 className="text-2xl font-semibold tracking-tight">业务应用</h1></div>
             <p className="mt-3 text-sm text-muted-foreground">这里是旧版指令应用，运行时仍会逐步调用 AI。新应用请从探索会话生成固定脚本草稿，经测试发布后直接执行。</p>
          </div>
          <Button asChild size="sm">
            <Link to="/cdp"><Sparkles className="me-2 size-4" />描述新需求</Link>
          </Button>
        </header>
        <div className="mb-6">
          <Input aria-label="搜索业务应用" placeholder="搜索名称或说明…" className="max-w-sm bg-white" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">正在加载应用…</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {filtered.map((item) => (
             <Link key={item.id} to={`/cdp/instruction-apps/${item.id}`} className="group rounded-2xl border border-slate-200 bg-white p-6 transition-colors hover:border-indigo-300">
                <div className="flex items-center gap-3">
                  <Sparkles className="size-4 text-indigo-500" />
                   <h2 className="flex-1 text-sm font-semibold">{item.definition.name} <span className="ms-1 font-normal text-amber-700">AI 执行</span></h2>
                  <ArrowUpRight className="size-4 text-muted-foreground" />
                </div>
                <p className="mt-3 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">{item.definition.description || "暂无说明"}</p>
                <div className="mt-5 flex justify-between border-t pt-3 text-[11px] text-muted-foreground">
                  <span>{item.definition.instructions.length} 个业务步骤 · {item.definition.parameters.length} 个参数</span>
                  <span>v{item.version}</span>
                </div>
              </Link>
            ))}
            {!filtered.length && (
              <div className="col-span-full rounded-2xl border border-dashed bg-white px-6 py-16 text-center">
                <h2 className="text-sm font-medium">{query ? "没有匹配的应用" : "会话中生成后，这里会出现指令应用"}</h2>
                <p className="mt-3 text-xs leading-6 text-muted-foreground">在会话的「指令应用草稿」中生成、测试并确认创建。</p>
                <Button asChild className="mt-5" variant="outline"><Link to="/cdp">开始任务</Link></Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function InstructionAppDetailPage() {
  const { appId = "" } = useParams()
  return <InstructionAppDetail key={appId} id={appId} />
}

function InstructionAppDetail({ id }: { id: string }) {
  const navigate = useNavigate()
  const [app, setApp] = useState<InstructionApp | null>(null)
  const [runs, setRuns] = useState<InstructionRun[]>([])
  const [run, setRun] = useState<InstructionRun | null>(null)
  const [sessions, setSessions] = useState<Array<{ id: string; title?: string }>>([])
  const [sessionId, setSessionId] = useState("")
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState("")
  const [revision, setRevision] = useState(0)
  const pending = useRef<{ requestKey: string } | null>(null)
  const submitted = useRef(false)

  useEffect(() => {
    let stopped = false
    void Promise.all([
      instructionApi.app(id),
      instructionApi.appRuns(id),
      baseFetch<{ items: Array<{ id: string; title?: string }> }>("/api/sessions"),
    ])
      .then(([current, history, available]) => {
        if (stopped) return
        setApp(current)
        setRuns(history.items)
        setSessions(available.items)
        // 默认展示最近一次运行，执行过程直接可见。
        setRun((existing) => existing ?? history.items[0] ?? null)
        setValues((existing) =>
          Object.keys(existing).length
            ? existing
            : Object.fromEntries(current.definition.parameters.map((parameter) => [parameter.key, parameter.defaultValue])),
        )
        setError("")
      })
      .catch((cause) => { if (!stopped) setError(String(cause)) })
    return () => { stopped = true }
  }, [id, revision])

  useEffect(() => {
    if (!run || !active(run)) return
    let stopped = false
    const timer = setTimeout(() => {
      void instructionApi
        .status(run.id)
        .then((current) => {
          if (stopped) return
          setRun(current)
          if (!active(current)) setRevision((value) => value + 1)
        })
        .catch((cause) => { if (!stopped) setError(String(cause)) })
    }, 2000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [run])

  const action = async (fn: () => Promise<void>) => {
    if (submitted.current) return
    submitted.current = true
    setBusy(true)
    setError("")
    try { await fn() } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      submitted.current = false
      setBusy(false)
    }
  }

  const start = () => action(async () => {
    if (!app) return
    if (!pending.current) pending.current = { requestKey: crypto.randomUUID() }
    const session = sessionId || (await baseFetch<{ session: { id: string } }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: app.definition.name }),
    })).session.id
    setSessionId(session)
    const current = await instructionApi.runApp(app.id, {
      sessionId: session,
      requestKey: pending.current.requestKey,
      parameters: { ...values },
      confirmed,
    })
    pending.current = null
    setRun(current)
    setRuns((items) => [current, ...items.filter((item) => item.id !== current.id)])
  })

  const resume = (choice: "retry" | "stop") => action(async () => {
    if (!run) return
    setRun(await instructionApi.resume(run.id, choice))
  })
  const upgrade = () => action(async () => {
    const evidence = runs.find((entry) => entry.status === "succeeded" && entry.steps.every((step) => step.status === "succeeded"))
    if (!app || !evidence) return
    const draft = await automationApi.fromLegacy(app.id, evidence.id)
    navigate(`/cdp/session/${draft.sessionId}?draft=${encodeURIComponent(draft.id)}`)
  })

  return (
    <div className="chat-workspace h-full overflow-y-auto bg-slate-50 p-5 md:p-9">
      <div className="mx-auto max-w-6xl">
         <div className="mb-7 flex w-fit items-center gap-2">
          <BrowserNavigationToggle />
          <Link to="/cdp/apps" className="flex items-center gap-2 text-xs text-muted-foreground">
           <ArrowLeft className="size-3" />自动化应用
        </Link>
         </div>
        {error && <p role="alert" className="mb-5 text-sm text-destructive">{error}<Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>刷新</Button></p>}
        {!app && !error && <p role="status">正在加载应用…</p>}
        {app && (
          <>
            <header className="mb-8">
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-semibold tracking-tight">{app.definition.name}</h1>
                <span className="rounded bg-white px-2 py-1 text-xs text-muted-foreground">v{app.version}</span>
              </div>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">{app.definition.description}</p>
               <div className="mt-3 space-y-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-900">
                 <p>待升级的旧应用：现有运行逐步调用 AI。升级会从一次成功运行生成固定流程候选，不会直接更改当前应用；候选仍需审阅、测试与发布。</p>
                 <Button size="sm" variant="outline" disabled={busy || !runs.some((entry) => entry.status === "succeeded")} onClick={() => void upgrade()}>{busy ? "正在生成固定流程候选…" : "从成功运行升级为固定流程"}</Button>
                 {!runs.some((entry) => entry.status === "succeeded") && <p>暂无成功运行证据。请先在会话中探索并完成任务，再生成固定草稿。</p>}
               </div>
            </header>
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="space-y-6">
                {run && (
                  <section aria-label="运行详情" className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_10px_35px_-24px_rgba(15,23,42,0.35)]">
                    <div className="border-b border-slate-100 bg-slate-50/70 px-5 py-5 sm:px-7">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="flex items-start gap-3">
                          <span className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl ${run.status === "succeeded" ? "bg-emerald-100 text-emerald-700" : run.status === "failed" ? "bg-rose-100 text-rose-700" : "bg-blue-100 text-blue-700"}`}>
                            {run.status === "succeeded" ? <Check className="size-5" /> : run.status === "failed" ? <TriangleAlert className="size-5" /> : active(run) ? <LoaderCircle className="size-5 animate-spin" /> : <Clock3 className="size-5" />}
                          </span>
                          <div>
                            <p className="text-[11px] font-medium tracking-[0.12em] text-slate-500">本次运行</p>
                            <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">{instructionStatusLabel[run.status]}</h2>
                            <p className="mt-1 text-xs text-slate-500">{new Date(run.timeCreated).toLocaleString()} · 版本 v{run.appVersion}{run.regeneratedVersion ? ` · 已重新生成 v${run.regeneratedVersion}` : ""}</p>
                          </div>
                        </div>
                        <Link className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900" to={`/cdp/session/${run.sessionId}`}>在会话中打开（接管或调试）<ArrowUpRight className="size-3.5" /></Link>
                      </div>
                      {run.steps.length > 0 && <div aria-label="完成进度" className="mt-5 flex gap-1.5">{run.steps.map((step) => <span key={step.index} className={`h-1.5 flex-1 rounded-full ${step.status === "succeeded" ? "bg-emerald-500" : step.status === "running" ? "bg-blue-500" : step.status === "failed" ? "bg-rose-500" : "bg-slate-200"}`} />)}</div>}
                    </div>
                    <div className="px-5 pb-6 sm:px-7">
                    <RunProcess key={run.id} run={run} />
                    {run.error && <p role="alert" className="mt-5 whitespace-pre-wrap break-words rounded-lg border border-rose-100 bg-rose-50 p-3 text-xs text-rose-800">{run.error}</p>}
                    {run.status === "paused" && (
                      <div className="mt-5 flex gap-2">
                        <Button size="sm" disabled={busy} onClick={() => void resume("retry")}>{run.promptId ? "继续观察" : "恢复执行"}</Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void resume("stop")}>结束运行</Button>
                      </div>
                    )}
                    </div>
                  </section>
                )}
                <details className="group rounded-2xl border bg-white p-5 sm:p-6" open={!run ? true : undefined}>
                  <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">业务步骤 <span className="font-normal text-slate-500">· {app.definition.instructions.length} 步</span><ChevronDown className="ms-auto size-4 text-slate-400 transition-transform group-open:rotate-180" /></summary>
                  <ol className="mt-5 space-y-5 border-t pt-5">
                    {app.definition.instructions.map((instruction, index) => (
                      <li key={instruction.id} className="flex gap-3">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs text-muted-foreground">{index + 1}</span>
                        <div>
                          <p className="text-sm">{instruction.title}{instruction.requiresConfirmation && <span className="ms-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">需确认</span>}</p>
                          <p className="mt-1 whitespace-pre-wrap text-xs leading-6 text-muted-foreground">{instruction.text}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </details>
                <section className="rounded-2xl border bg-white p-6">
                  <h2 className="mb-4 text-sm font-semibold">运行记录</h2>
                  {runs.length ? (
                    <ul className="divide-y text-xs">
                      {runs.map((item) => (
                        <li key={item.id}>
                          <button type="button" aria-current={run?.id === item.id ? "true" : undefined} className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-slate-50 ${run?.id === item.id ? "bg-slate-50 font-medium" : ""}`} onClick={() => setRun(item)}>
                            <span>{instructionStatusLabel[item.status]}</span>
                            <span className="text-muted-foreground">v{item.appVersion} · {new Date(item.timeCreated).toLocaleString()}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="text-xs text-muted-foreground">还没有运行记录</p>}
                </section>
              </div>
              <form className="space-y-4 rounded-2xl border bg-white p-6" onSubmit={(event) => { event.preventDefault(); void start() }}>
                <h2 className="text-sm font-semibold">运行应用</h2>
                {app.definition.parameters.map((parameter) => (
                  <label key={parameter.key} className="block space-y-2 text-sm">
                    <span>{parameter.label}{parameter.required ? " *" : ""}</span>
                    <Input
                      required={parameter.required}
                      maxLength={8000}
                      value={values[parameter.key] ?? ""}
                      onChange={(event) => {
                        pending.current = null
                        setValues((current) => ({ ...current, [parameter.key]: event.target.value }))
                      }}
                    />
                  </label>
                ))}
                <label className="block space-y-2 text-sm">
                  <span>运行工作区</span>
                  <select aria-label="运行工作区" className="h-9 w-full rounded-md border bg-white px-2 text-xs" value={sessionId} onChange={(event) => { pending.current = null; setSessionId(event.target.value) }}>
                    <option value="">新建独立会话</option>
                    {sessions.map((session) => <option key={session.id} value={session.id}>{session.title || session.id}</option>)}
                  </select>
                  <span className="block text-[11px] leading-5 text-muted-foreground">依赖原会话文件或数据时，请选择原会话；新建会话只有空工作区。</span>
                </label>
                {app.definition.verification && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">执行与校验细节</summary>
                    <p className="mt-1">完成标准：产物 {app.definition.verification.path} 必须生成{app.definition.verification.contains ? `，且包含“${app.definition.verification.contains}”` : ""}。</p>
                  </details>
                )}
                {app.definition.instructions.some((instruction) => instruction.requiresConfirmation) && (
                  <label className="flex items-start gap-2 text-xs">
                    <input type="checkbox" checked={confirmed} onChange={(event) => { pending.current = null; setConfirmed(event.target.checked) }} />
                    <span>我已核对需确认的高风险指令（发货、付款、删除等）</span>
                  </label>
                )}
                <p className="text-xs leading-5 text-muted-foreground">执行过程显示在本页；需要接管浏览器或排查问题时再打开会话。登录、验证码和危险操作会暂停等待你确认。</p>
                <Button type="submit" className="w-full" disabled={busy || active(run) || run?.status === "paused" || (app.definition.instructions.some((instruction) => instruction.requiresConfirmation) && !confirmed)}>
                  <Play className="me-2 size-4" />{busy ? "正在处理…" : "运行应用"}
                </Button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
