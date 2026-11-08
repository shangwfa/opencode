import { useEffect, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { baseFetch } from "@/lib/base-api"
import { subscribeSessionEvents, type SseEvent } from "@/lib/base-sse"
import { automationApi, businessStages, runStatusLabel, type AutomationDraft, type AutomationRun } from "@/lib/automation-apps"

/** 把生成会话的 SSE 事件转成一句可读进度；高频增量与无信息事件返回空串忽略。 */
function eventText(event: SseEvent): string {
  switch (event.type) {
    case "session.execution.started": return "AI 正在阅读本次会话记录…"
    case "session.step.started": return "正在整理业务步骤与动作…"
    case "session.reasoning.ended": return "正在核对是否有足够证据…"
    case "session.text.ended": return "正在生成固定草稿…"
    case "session.execution.succeeded": return "结构化生成完成，正在保存草稿…"
    default: return ""
  }
}

export function SessionDrafts({ sessionId, onDrafts }: { sessionId: string; onDrafts?: (count: number) => void }) {  const [search] = useSearchParams()
  const selectedDraftId = search.get("draft")
  const [drafts, setDrafts] = useState<AutomationDraft[]>([])
  const [draft, setDraft] = useState<AutomationDraft | null>(null)
  const [run, setRun] = useState<AutomationRun | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string[]>([])
  // 平台自动沉淀的结果提示（成功或阻塞原因），避免用户误以为已经发布。
  const [autoNotice, setAutoNotice] = useState("")
  const [error, setError] = useState("")
  const [pollKey, setPollKey] = useState(0)
  const pending = useRef<{ draftId: string; version: number; requestKey: string; parameters: Record<string, string> } | null>(null)
  const submitting = useRef(false)
  const importing = useRef(false)
  const genStop = useRef<(() => void) | null>(null)
  useEffect(() => () => genStop.current?.(), [])
  // 让外层入口能显示「已有草稿」，并在自动导入后主动展开。
  useEffect(() => { onDrafts?.(drafts.length) }, [drafts.length, onDrafts])
  useEffect(() => {
    let disposed = false
    void automationApi.drafts(sessionId).then(({ items }) => { if (!disposed) setDrafts(items) }).catch((cause) => { if (!disposed) setError(String(cause)) })
    return () => { disposed = true }
  }, [sessionId])
  useEffect(() => {
    if (!run || !["queued", "running", "repairing"].includes(run.status)) return
    let disposed = false
    const timer = setTimeout(() => void automationApi.status(run.id).then((current) => { if (!disposed) setRun(current) }).catch((cause) => { if (!disposed) setError(String(cause)) }), 1500)
    return () => { disposed = true; clearTimeout(timer) }
  }, [run, pollKey])
  const action = async (fn: () => Promise<void>) => {
    if (submitting.current) return
    submitting.current = true; setBusy(true); setError("")
    try { await fn() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { submitting.current = false; setBusy(false) }
  }
  const select = async (item: AutomationDraft) => {
    pending.current = null
    setDraft(item)
    setValues(Object.fromEntries(item.definition.parameters.map((parameter) => [parameter.key, parameter.defaultValue])))
    const { items } = await automationApi.draftRuns(item.id)
    setRun(items.find((entry) => entry.appVersion === item.version && entry.draftHash === item.contentHash) ?? null)
  }
  useEffect(() => {
    if (!selectedDraftId || draft?.id === selectedDraftId) return
    let disposed = false
    void automationApi.draftDetail(selectedDraftId).then(async (item) => {
      if (disposed || item.sessionId !== sessionId) return
      await select(item)
      if (!disposed) setDrafts((current) => [item, ...current.filter((entry) => entry.id !== item.id)])
    }).catch((cause) => { if (!disposed) setError(String(cause)) })
    return () => { disposed = true }
  }, [selectedDraftId, sessionId, draft?.id])
  /** 平台接管沉淀：测试 → 门槛校验 → 发布；不满足条件时只提示原因，不假装成功。 */
  const autoDistill = async (item: AutomationDraft) => {
    try {
      let session = await automationApi.distill(sessionId, { draftId: item.id })
      for (let attempt = 0; attempt < 120; attempt++) {
        if (session.status === "published" || session.status === "already_published") {
          const appId = session.appId
          setDrafts((items) => items.map((entry) => entry.id === item.id ? { ...entry, publishedAppId: appId } : entry))
          setDraft((current) => current && current.id === item.id ? { ...current, publishedAppId: appId } : current)
          setAutoNotice(`应用已沉淀完成（${appId}）。`)
          return
        }
        if (session.status !== "testing") return
        const run = await automationApi.status(session.runId)
        setRun(run)
        if (run.status === "paused") {
          setAutoNotice(
            run.results[run.cursor]?.pauseReason === "confirmation"
              ? "平台已发起测试，脚本执行需要你确认后才会继续并自动发布。"
              : `测试暂停：${run.error ?? "需要人工核实"}`,
          )
          return
        }
        if (run.status === "failed") {
          setAutoNotice(`测试失败，未创建应用：${run.error ?? ""}`)
          return
        }
        if (run.status === "succeeded") {
          // 成功即回到 distill，由平台校验门槛并发布。
          session = await automationApi.distill(sessionId, { draftId: item.id })
          continue
        }
        await new Promise((resolve) => setTimeout(resolve, 2500))
        session = await automationApi.distill(sessionId, { draftId: item.id })
      }
    } catch (cause) {
      setAutoNotice(`未能自动沉淀：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const importDraft = () => action(async () => {
    const item = await automationApi.importDraft(sessionId)
    setDrafts((items) => [item, ...items])
    await select(item)
  })
  const generate = () => action(async () => {
    setProgress(["正在准备生成会话…"])
    const job = await automationApi.draftStart(sessionId)
    // 订阅临时生成会话的事件流，把 AI 的思考/文本进度实时回显到对话区。
    let last = ""
    genStop.current?.()
    genStop.current = subscribeSessionEvents(job.sessionId, (event) => {
      const text = eventText(event)
      if (!text || text === last) return
      last = text
      setProgress((current) => [...current.filter((line) => line !== text), text].slice(-4))
    })
    const deadline = Date.now() + 6 * 60_000
    try {
      for (;;) {
        const result = await automationApi.draftResult({ sessionId: job.sessionId, promptId: job.promptId }, job.sourceSessionId)
        if (result.status === "ready") {
          setDrafts((items) => [result.draft, ...items])
          await select(result.draft)
          return
        }
        if (Date.now() > deadline) throw new Error("生成超时，请稍后重试")
        await new Promise((resolve) => setTimeout(resolve, 2500))
      }
    } finally {
      genStop.current?.()
      genStop.current = null
      setProgress([])
    }
  })
  // 探索阶段写入经过验证的固定草稿与标记后，自动导入；PG generationKey 防止刷新、多标签、多 pod 重复创建。
  useEffect(() => {
    let disposed = false
    const check = async () => {
      if (importing.current) return
      try {
        const file = await baseFetch<{ content?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/fs/content?path=${encodeURIComponent("/workspace/.automation/app-request.json")}`)
        const marker = JSON.parse(file.content ?? "") as { ready?: boolean; requestedAt?: number; execution?: string }
        if (marker.ready !== true || marker.execution !== "fixed" || !Number.isSafeInteger(marker.requestedAt) || Math.abs(Date.now() - marker.requestedAt!) > 10 * 60 * 1000) return
        importing.current = true
        const item = await automationApi.importDraft(sessionId, `fixed-${marker.requestedAt}`)
        if (disposed) return
        setDrafts((items) => [item, ...items.filter((entry) => entry.id !== item.id)])
        await select(item)
        // AI 已完成真实执行验证并请求沉淀：平台自己接着走测试与发布，不需要用户再点一遍。
        // 需要脚本确认时停在确认环节，由用户决定。
        if (!item.publishedAppId) await autoDistill(item)
      } catch {
        importing.current = false // 草稿尚未写完时下次重试
      }
    }
    void check()
    const timer = setInterval(() => void check(), 5000)
    return () => { disposed = true; clearInterval(timer) }
  }, [sessionId])
  const test = () => action(async () => {
    if (!draft) return
    if (!pending.current) pending.current = { draftId: draft.id, version: draft.version, requestKey: crypto.randomUUID(), parameters: { ...values } }
    const { version, requestKey, parameters } = pending.current
    const current = await automationApi.testDraft(draft.id, { version, requestKey, parameters })
    pending.current = null
    setRun(current)
  })
  const resume = (choice: "confirm" | "stop") => action(async () => {
    if (!run) return
    setRun(await automationApi.resume(run.id, choice)); setPollKey((key) => key + 1)
  })
  const repair = () => action(async () => {
    if (!draft || !run) return
    const updated = await automationApi.applyDraftRepair(draft.id, draft.version, run.id)
    setDrafts((items) => items.map((item) => item.id === updated.id ? updated : item))
    setDraft(updated); setRun(null); pending.current = null
  })
  const publish = () => action(async () => {
    if (!draft || !run) return
    const app = await automationApi.publishDraft(draft.id, draft.version, run.id)
    const updated = { ...draft, publishedAppId: app.id }
    setDraft(updated); setDrafts((items) => items.map((item) => item.id === updated.id ? updated : item))
  })
  const completed = !!draft && !!run && run.status === "succeeded" && run.appVersion === draft.version && run.draftHash === draft.contentHash
  const hasRepair = !!run?.results.some((result) => result.repairedOperation && !result.skipped)
  const clean = completed && !run?.results.some((result) => result.skipped || result.repairedOperation)
  return (
    <section aria-label="会话应用草稿" className="mx-auto my-5 w-full max-w-3xl rounded-xl border bg-card p-4 text-sm shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">固定应用草稿</h2><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void generate()}>{progress.length ? "正在生成固定草稿…" : "根据会话生成固定草稿"}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void importDraft()}>读取会话草稿</Button></div></div>
      {!!progress.length && (
        <ul aria-live="polite" className="mt-3 space-y-1 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
          {progress.map((line, index) => (
            <li key={line} className="flex items-center gap-2">
              {index === progress.length - 1 && <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
              {line}
            </li>
          ))}
        </ul>
      )}
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">这是什么？</summary>
        <p className="mt-1 leading-5">可在会话中让 AI 整理应用，完成后从 /workspace/.automation/draft.json 读取。请检查脚本和资源中没有密码、令牌或不应执行的操作；文本资源随应用保存，外部依赖不会自动安装。</p>
      </details>
      {error && <p role="alert" className="mt-2 break-words text-xs text-destructive">{error}</p>}
      {autoNotice && <p role="status" className="mt-2 break-words rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">{autoNotice}</p>}
      {!!drafts.length && <label className="mt-3 block text-xs">选择草稿<select aria-label="选择会话草稿" className="mt-1 h-9 w-full rounded-md border bg-background px-2" value={draft?.id ?? ""} onChange={(event) => { const item = drafts.find((entry) => entry.id === event.target.value); if (item) void action(() => select(item)) }}><option value="">选择草稿</option>{drafts.map((item) => <option key={item.id} value={item.id}>{item.definition.name} · v{item.version}</option>)}</select></label>}
      {draft && <div className="mt-4 space-y-3">
         <div><h3 className="font-medium">{draft.definition.name} <span className="text-xs text-muted-foreground">v{draft.version}</span></h3><p className="mt-1 text-xs text-muted-foreground">{draft.definition.description}</p>{draft.legacyAppId && <p className="mt-1 text-xs text-amber-700">旧应用升级候选：请核对固定动作和产物，测试通过后才可发布。</p>}{draft.definition.verification && <p className="mt-1 text-xs text-muted-foreground">完成标准：本次产物 {draft.definition.verification.path}{draft.definition.verification.contains ? ` 包含“${draft.definition.verification.contains}”` : ""}</p>}</div>
        <ol className="list-inside list-decimal text-xs leading-6">{businessStages(draft.definition.steps).map((stage) => <li key={stage.entries[0]!.step.id}>{stage.title}</li>)}</ol>
        <details className="text-xs"><summary className="cursor-pointer">审阅执行细节</summary>{draft.definition.steps.map((step) => <div className="mt-2" key={step.id}><p>{step.title} · {step.operation.type === "browser" ? `${step.operation.action} ${step.operation.selector ?? ""} ${step.operation.value ?? ""}` : step.operation.runtime}</p>{step.operation.type === "script" && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{step.operation.source}</pre>}</div>)}</details>
        {!!draft.definition.resources?.length && <details className="text-xs"><summary className="cursor-pointer">审阅应用资源（{draft.definition.resources.length}）</summary>{draft.definition.resources.map((resource) => <div className="mt-2" key={resource.path}><p>{resource.path}</p><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{resource.content}</pre></div>)}</details>}
        {draft.definition.parameters.map((parameter) => <label className="block text-xs" key={parameter.key}>{parameter.label}{parameter.required ? " *" : ""}<Input className="mt-1" value={values[parameter.key] ?? ""} onChange={(event) => { pending.current = null; setValues((current) => ({ ...current, [parameter.key]: event.target.value })) }} /></label>)}
        {run && <div aria-live="polite" className="rounded-lg bg-muted p-3 text-xs"><p>测试：{runStatusLabel[run.status]} · {run.cursor}/{run.definition.steps.length} 个动作</p>{run.error && <p className="mt-1 break-words">{run.error}</p>}{run.results.map((result) => <div className="mt-2" key={result.stepId}><p>{run.definition.steps.find((step) => step.id === result.stepId)?.title ?? result.stepId}：{result.status === "succeeded" ? "已完成" : result.status === "paused" ? "已暂停" : "执行中"}</p>{result.output && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all">{result.output}</pre>}{result.repairedOperation && <details><summary className="cursor-pointer">查看修复内容</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(result.repairedOperation, null, 2)}</pre></details>}</div>)}</div>}
        <div className="flex flex-wrap gap-2">
          {!draft.publishedAppId && <Button size="sm" disabled={busy || !!run && ["queued", "running", "repairing", "paused"].includes(run.status)} onClick={() => void test()}>测试运行</Button>}
          {run?.status === "paused" && <><Button size="sm" disabled={busy} onClick={() => void resume("confirm")}>已核实，确认此步</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void resume("stop")}>结束测试</Button></>}
          {completed && hasRepair && <Button size="sm" variant="outline" disabled={busy} onClick={() => void repair()}>保存修复并重新测试</Button>}
          {clean && !draft.publishedAppId && <Button size="sm" variant="outline" disabled={busy} onClick={() => void publish()}>确认结果并创建应用</Button>}
          {draft.publishedAppId && <Link className="text-xs text-primary underline" to={`/cdp/apps/${draft.publishedAppId}`}>查看已创建应用</Link>}
        </div>
        {clean && !draft.publishedAppId && <p className="text-xs text-muted-foreground">运行成功不代表业务结果正确，请先核对输出及文件，再确认创建。</p>}
      </div>}
    </section>
  )
}
