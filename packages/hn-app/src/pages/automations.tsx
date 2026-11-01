import { useEffect, useRef, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router"
import { ArrowLeft, ArrowUpRight, Boxes, Play, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  automationApi,
  businessStages,
  operationLabel,
  runStatusLabel,
  type AutomationApp,
  type AutomationRun,
} from "@/lib/automation-apps"
import { browserApi } from "@/lib/browser"
import { baseFetch } from "@/lib/base-api"
import { BrowserPanel } from "@/features/browser-cdp/browser-panel"

export function AutomationsPage() {
  const [items, setItems] = useState<AutomationApp[]>([])
  const [query, setQuery] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let stopped = false
    setLoading(true)
    void automationApi
      .list()
      .then((result) => {
        if (!stopped) {
          setItems(result.items)
          setError("")
        }
      })
      .catch((cause) => {
        if (!stopped) setError(String(cause))
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
  return (
    <div className="chat-workspace h-full overflow-y-auto bg-slate-50 p-5 md:p-9">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="mb-2 text-xs tracking-widest text-muted-foreground">把做成的事，留给下一次</p>
            <h1 className="text-2xl font-semibold tracking-tight">自动化应用</h1>
            <p className="mt-3 text-sm text-muted-foreground">网页操作、文件与数据处理。一次探索，按需重复运行。</p>
          </div>
          <Button asChild size="sm">
            <Link to="/cdp">
              <Plus className="me-2 size-4" />
              描述新需求
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
          <Link to="/cdp/scripts" className="text-xs text-muted-foreground underline underline-offset-4">
            查看旧脚本库
          </Link>
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
            {!filtered.length && (
              <div className="col-span-full rounded-2xl border border-dashed bg-white px-6 py-16 text-center">
                <h2 className="text-sm font-medium">{query ? "没有匹配的应用" : "让 AI 先帮你做成，再保存为应用"}</h2>
                <p className="mt-3 text-xs leading-6 text-muted-foreground">
                  在自动化工作区完成任务后，点击「保存为应用」。已有脚本仍保留在旧脚本库。
                </p>
                <Button asChild className="mt-5" variant="outline">
                  <Link to="/cdp">开始任务</Link>
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
  const [revision, setRevision] = useState(0)
  // 恢复/修复后需要重启轮询；不用 URL 时间戳，避免时间戳相同时不重跑。
  const [pollKey, setPollKey] = useState(0)
  const pending = useRef<{ sessionId: string; requestKey: string; parameters: Record<string, string> } | null>(null)
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
        pending.current = { sessionId: session, requestKey: crypto.randomUUID(), parameters: { ...values } }
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
    <div className="chat-workspace h-full overflow-y-auto bg-slate-50 p-5 md:p-9">
      <div className="mx-auto max-w-6xl">
        <Link to="/cdp/apps" className="mb-7 flex w-fit items-center gap-2 text-xs text-muted-foreground">
          <ArrowLeft className="size-3" />
          自动化应用
        </Link>
        {error && (
          <p role="alert" className="mb-5 text-sm text-destructive">
            {error}
            <Button variant="ghost" size="sm" onClick={() => setRevision((r) => r + 1)}>
              刷新
            </Button>
          </p>
        )}
        {!app && !error && <p role="status">正在加载应用…</p>}
        {app && (
          <>
            <header className="mb-8">
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-semibold tracking-tight">{app.definition.name}</h1>
                <span className="rounded bg-white px-2 py-1 text-xs text-muted-foreground">v{app.version}</span>
              </div>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">{app.definition.description}</p>
            </header>
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="min-w-0 space-y-6">
                <section className="rounded-2xl border bg-white p-6">
                  <h2 className="mb-5 text-sm font-semibold">执行步骤</h2>
                  <ol className="space-y-5">
                    {businessStages(app.definition.steps).map((stage, index) => (
                      <li key={stage.entries[0]!.step.id} className="flex gap-3">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs text-muted-foreground">
                          {index + 1}
                        </span>
                        <div>
                          <p className="text-sm">{stage.title}</p>
                          <details className="mt-1 text-xs text-muted-foreground">
                            <summary className="cursor-pointer">查看执行细节</summary>
                            {stage.entries.map(({ step }) => <p className="mt-1" key={step.id}>{step.title} · {operationLabel(step)}</p>)}
                          </details>
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
                {run && (
                  <section aria-label="运行详情" className="rounded-2xl border bg-white p-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h2 className="text-sm font-semibold">{runStatusLabel[run.status]}</h2>
                      <Link
                        className="text-xs text-indigo-600"
                        to={hasBrowser ? `/cdp/session/${run.sessionId}` : `/free-chat/session/${run.sessionId}`}
                      >
                        打开会话与文件 ↗
                      </Link>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      运行版本 v{run.appVersion} · 已完成 {businessStages(run.definition.steps).filter((stage) => stage.entries.every(({ index }) => run.results[index]?.status === "succeeded")).length}/{businessStages(run.definition.steps).length} 个业务阶段
                    </p>
                    <ol aria-live="polite" className="mt-5 divide-y">
                      {businessStages(run.definition.steps).map((stage, stageIndex) => {
                        const results = stage.entries.map(({ index }) => run.results[index])
                        const state = results.every((result) => result?.status === "succeeded") ? "已完成"
                          : results.some((result) => result?.status === "paused") ? "已暂停"
                          : results.some((result) => result?.status === "running") || stage.entries.some(({ index }) => index === run.cursor && ["queued", "running", "repairing"].includes(run.status)) ? "执行中" : "待执行"
                        return (
                          <li key={stage.entries[0]!.step.id} className="py-3 text-sm">
                            <div className="flex justify-between gap-3">
                              <span>
                                {stageIndex + 1}. {stage.title}
                              </span>
                              <span className="shrink-0 text-xs text-muted-foreground">{state}</span>
                            </div>
                            <details className="mt-2 text-xs text-muted-foreground">
                              <summary className="cursor-pointer">查看执行细节</summary>
                              {stage.entries.map(({ step, index }) => {
                                const result = run.results[index]
                                return <div key={step.id} className="mt-2"><p>{step.title} · {result?.status === "succeeded" ? "已完成" : result?.status === "running" ? "执行中" : result?.status === "paused" ? "已暂停" : "待执行"}</p>
                            {!!result?.repairAttempts && (
                              <p className="mt-1 text-xs text-indigo-600">已尝试局部修复 {result.repairAttempts} 次</p>
                            )}
                            {result?.output && (
                              <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-xs leading-5">
                                {result.output}
                              </pre>
                            )}
                                </div>
                              })}
                            </details>
                          </li>
                        )
                      })}
                    </ol>
                    {run.status === "paused" && (
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
                    {run.status === "succeeded" &&
                      run.repairApplied && <p className="mt-5 rounded-xl bg-emerald-50 p-4 text-sm">修复后的运行已完成，应用已更新。请核对产物是否符合业务预期。</p>}
                    {run.status === "succeeded" &&
                      !run.repairApplied &&
                      run.results.some((result) => result.repairedOperation && !result.skipped) && (
                        <div className="mt-5 rounded-xl bg-indigo-50 p-4">
                          <p className="text-sm">本次修复未自动保存，可能因为应用版本已变化或运行中跳过了步骤。</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            请先核实执行结果；已有新版本时不会覆盖。
                          </p>
                          <Button
                            disabled={busy}
                            className="mt-3"
                            size="sm"
                            onClick={() =>
                              void action(async () => {
                                await automationApi.applyRepair(run.id)
                                setRun({ ...run, repairApplied: true })
                                setRevision((r) => r + 1)
                              })
                            }
                          >
                            确认更新应用
                          </Button>
                        </div>
                      )}
                  </section>
                )}
                {run && hasBrowser && (
                  <div className="flex h-[480px] min-h-0 flex-col overflow-hidden rounded-2xl border bg-white">
                    <BrowserPanel sessionId={run.sessionId} working={run.status === "running"} />
                  </div>
                )}
              </div>
              <aside className="space-y-6">
                <form
                  className="space-y-4 rounded-2xl border bg-white p-6"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void start()
                  }}
                >
                  <h2 className="text-sm font-semibold">运行应用</h2>
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
                  <p className="text-xs leading-5 text-muted-foreground">
                    需要已有文件或登录状态时，选择原会话。新会话不会自动复制文件或登录状态。点击及处理脚本将逐步请求确认。
                  </p>
                  <Button
                    type="submit"
                    disabled={busy || (!!run && ["queued", "running", "paused", "repairing"].includes(run.status))}
                    className="w-full"
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
