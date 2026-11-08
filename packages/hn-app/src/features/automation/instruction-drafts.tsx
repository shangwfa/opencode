import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { baseFetch } from "@/lib/base-api"
import { InstructionPermissions } from "./instruction-permissions"
import {
  instructionApi,
  instructionStatusLabel,
  type InstructionApp,
  type InstructionDraft,
  type InstructionRun,
} from "@/lib/instruction-apps"

const active = (run: InstructionRun | null) =>
  !!run && ["queued", "running", "regenerating"].includes(run.status)

export function InstructionDrafts({ sessionId, onOpenFile }: { sessionId: string; onOpenFile?: (path: string) => void }) {
  const [drafts, setDrafts] = useState<InstructionDraft[]>([])
  const [draft, setDraft] = useState<InstructionDraft | null>(null)
  const [run, setRun] = useState<InstructionRun | null>(null)
  const [app, setApp] = useState<InstructionApp | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [resultConfirmed, setResultConfirmed] = useState(false)
  const pending = useRef<string | null>(null)
  const autoRequest = useRef("")
  const submitting = useRef(false)
  const selection = useRef(0)

  const action = async (fn: () => Promise<void>) => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError("")
    try {
      await fn()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const load = async (selected?: InstructionDraft, resetValues = false) => {
    const { items } = await instructionApi.drafts(sessionId)
    setDrafts(items)
    if (selected) {
      const current = items.find((item) => item.id === selected.id) ?? selected
      setDraft(current)
      if (resetValues) setValues(Object.fromEntries(current.definition.parameters.map((parameter) => [parameter.key, parameter.defaultValue])))
      const runs = await instructionApi.draftRuns(current.id)
      setRun(runs.items.find((item) => item.appVersion === current.version && item.draftHash === current.contentHash) ?? null)
      setApp(current.publishedAppId ? await instructionApi.app(current.publishedAppId) : null)
    }
  }

  useEffect(() => {
    let disposed = false
    void instructionApi
      .drafts(sessionId)
      .then(async ({ items }) => {
        if (disposed) return
        setDrafts(items)
        const current = items[0]
        if (!current || selection.current) return
        const marker = ++selection.current
        const [history, published] = await Promise.all([
          instructionApi.draftRuns(current.id),
          current.publishedAppId ? instructionApi.app(current.publishedAppId) : Promise.resolve(null),
        ])
        if (disposed || selection.current !== marker) return
        setDraft(current)
        setValues(Object.fromEntries(current.definition.parameters.map((parameter) => [parameter.key, parameter.defaultValue])))
        setRun(history.items.find((item) => item.appVersion === current.version && item.draftHash === current.contentHash) ?? null)
        setApp(published)
      })
      .catch((cause) => { if (!disposed) setError(String(cause)) })
    return () => { disposed = true }
  }, [sessionId])

  useEffect(() => {
    if (!run || !active(run)) return
    let disposed = false
    const timer = setTimeout(() => {
      void instructionApi
        .status(run.id)
        .then(async (current) => {
          if (disposed) return
          setRun(current)
          if (current.status === "failed" && current.regeneratedVersion) {
            setNotice(`执行失败，已生成待审核草稿 v${current.regeneratedVersion}，请在草稿列表中选择并重新测试。`)
            await load(draft ?? undefined)
            if (current.appId) {
              const updated = await instructionApi.app(current.appId)
              setApp(updated)
              setValues(Object.fromEntries(updated.definition.parameters.map((parameter) => [parameter.key, parameter.defaultValue])))
            }
          }
        })
        .catch((cause) => { if (!disposed) setError(String(cause)) })
    }, 2000)
    return () => { disposed = true; clearTimeout(timer) }
  }, [run])

  const select = async (item: InstructionDraft) => {
    selection.current++
    pending.current = null
    setConfirmed(false)
    setResultConfirmed(false)
    setRun(null)
    setNotice("")
    await load(item, true)
  }

  const generate = () => action(async () => {
    const { draft: created } = await instructionApi.generate(sessionId)
    setDrafts((items) => [created, ...items])
    await select(created)
  })

  const test = () => action(async () => {
    if (!draft) return
    setResultConfirmed(false)
    if (!pending.current) pending.current = crypto.randomUUID()
    const current = await instructionApi.testDraft(draft.id, {
      version: draft.version,
      requestKey: pending.current,
      parameters: { ...values },
      confirmed,
    })
    pending.current = null
    setRun(current)
  })

  const resume = (choice: "retry" | "stop") => action(async () => {
    if (!run) return
    setRun(await instructionApi.resume(run.id, choice))
  })

  const publish = () => action(async () => {
    if (!draft || !run) return
    const created = await instructionApi.publish(draft.id, draft.version, run.id)
    setApp(created)
    setNotice("应用已创建。执行时仍会在当前会话中运行，需要你核对业务结果。")
    await load({ ...draft, publishedAppId: created.id })
  })

  const runApp = () => action(async () => {
    const target = app ?? (draft?.publishedAppId ? await instructionApi.app(draft.publishedAppId) : null)
    if (!target) throw new Error("应用尚未创建")
    if (!app) setApp(target)
    if (!pending.current) pending.current = crypto.randomUUID()
    const current = await instructionApi.runApp(target.id, {
      sessionId,
      requestKey: pending.current,
      parameters: { ...values },
      confirmed,
    })
    pending.current = null
    setRun(current)
  })

  const needsConfirmation = !!draft?.definition.instructions.some((instruction) => instruction.requiresConfirmation)

  // 会话中的 AI 写入生成请求标记后，卡片自动生成草稿；仍需用户测试并确认发布。
  useEffect(() => {
    let disposed = false
    const check = async () => {
      try {
        const file = await baseFetch<{ content?: string }>(
          `/api/sessions/${encodeURIComponent(sessionId)}/fs/content?path=${encodeURIComponent("/workspace/.automation/app-request.json")}`,
        )
        const text = file.content ?? ""
        if (!text || text === autoRequest.current) return
        const parsed = JSON.parse(text) as { ready?: boolean; requestedAt?: number; execution?: string }
        // 只接受显式声明走旧版指令应用的标记。应用脚本自己也可能写这个文件（登记类应用），
        // 裸标记不再触发自动生成，避免把业务产物误判成「请生成应用」。
        if (parsed.execution !== "instruction") return
        const fresh = Number(parsed.requestedAt ?? 0)
        if (parsed.ready !== true || !fresh || Date.now() - fresh > 10 * 60 * 1000) return
        if (disposed || submitting.current) return
        await action(async () => {
          const { draft: created } = await instructionApi.generate(sessionId, `marker-${fresh}`)
          autoRequest.current = text
          const { items } = await instructionApi.drafts(sessionId)
          setDrafts(items)
          await select(created)
          setNotice(created.publishedAppId ? "已找到这次请求创建的应用。" : "已生成业务应用草稿，请先核对步骤再测试。")
        })
      } catch {
        // 没有生成请求或沙箱不可用时忽略
      }
    }
    void check()
    const timer = setInterval(() => void check(), 5000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [sessionId])

  const clean = !!draft && !!run && run.status === "succeeded" && run.appVersion === draft.version && run.draftHash === draft.contentHash && run.regeneratedVersion === null
  const stage = app || draft?.publishedAppId ? 4 : clean ? 3 : run ? 2 : draft ? 1 : 0
  const inputsChanged = !!run && Object.entries(values).some(([key, value]) => value !== (run.parameters[key] ?? ""))

  return (
    <section aria-label="业务应用草稿" className="mx-auto my-5 w-full max-w-3xl rounded-xl border bg-card p-4 text-sm shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">业务应用草稿</h2>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void generate()}>
          根据会话生成
        </Button>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">先审阅业务步骤并测试，核对结果后再创建应用。</p>
      {draft && <ol aria-label="创建应用进度" className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-y py-3 text-xs">
        {["审阅应用", "测试执行", "核对结果", "创建完成"].map((label, index) => (
          <li key={label} className={stage === index + 1 ? "font-semibold text-foreground" : "text-muted-foreground"} aria-current={stage === index + 1 ? "step" : undefined}>{index + 1}. {label}</li>
        ))}
      </ol>}
      {error && <p role="alert" className="mt-2 break-words text-xs text-destructive">{error}</p>}
      {notice && <p aria-live="polite" className="mt-2 break-words text-xs text-muted-foreground">{notice}</p>}
      {!drafts.length && !busy && <p className="mt-2 text-xs text-muted-foreground">还没有草稿。完成一次任务后再点击“根据会话生成”。</p>}
      {drafts.length > 1 && (
        <label className="mt-3 block text-xs">
          选择草稿
          <select
            aria-label="选择业务应用草稿"
            className="mt-1 h-9 w-full rounded-md border bg-background px-2"
            value={draft?.id ?? ""}
            onChange={(event) => {
              const item = drafts.find((entry) => entry.id === event.target.value)
              if (item) void action(() => select(item))
            }}
          >
            <option value="">选择草稿</option>
            {drafts.map((item) => <option key={item.id} value={item.id}>{item.definition.name} · v{item.version}{item.publishedAppId ? " · 已创建" : " · 草稿"}</option>)}
          </select>
        </label>
      )}
      {draft && (
        <div className="mt-4 space-y-3">
          <div>
            <h3 className="text-base font-semibold">{draft.definition.name} <span className="text-xs font-normal text-muted-foreground">v{draft.version} · {draft.publishedAppId || app ? "已创建" : "待测试"}</span></h3>
            <p className="mt-1 text-xs text-muted-foreground">{draft.definition.description}</p>
          </div>
          <ol className="list-inside list-decimal space-y-2 text-xs leading-6">
            {draft.definition.instructions.map((instruction) => (
              <li key={instruction.id}>
                {/* 长步骤默认折叠，让“测试执行/确认创建”保持在首屏附近。 */}
                <details open={instruction.text.length <= 120 || instruction.requiresConfirmation}>
                  <summary className="cursor-pointer">
                    <strong>{instruction.title}</strong>
                    {instruction.requiresConfirmation && <span className="ms-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">需确认</span>}
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap">{instruction.text}</p>
                </details>
              </li>
            ))}
          </ol>
          {draft.definition.verification && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">执行与校验细节</summary>
              <p className="mt-1">完成标准：产物 {draft.definition.verification.path} 必须生成{draft.definition.verification.contains ? `，且包含“${draft.definition.verification.contains}”` : ""}。</p>
            </details>
          )}
          {draft.definition.parameters.length > 0 && <h4 className="pt-2 font-medium">{app || draft.publishedAppId ? "运行输入" : "测试输入"}</h4>}
          {draft.definition.parameters.map((parameter) => (
            <label className="block text-xs" key={parameter.key}>
              {parameter.label}{parameter.required ? " *" : ""}
              <Input
                className="mt-1"
                value={values[parameter.key] ?? ""}
                onChange={(event) => {
                  pending.current = null
                  setResultConfirmed(false)
                  setValues((current) => ({ ...current, [parameter.key]: event.target.value }))
                }}
              />
            </label>
          ))}
          {run && (
            <div aria-live="polite" className="rounded-lg bg-muted p-3 text-xs">
              <p className="font-medium">执行状态：{instructionStatusLabel[run.status]}</p>
              {Object.keys(run.parameters).length > 0 && <details className="mt-2"><summary className="cursor-pointer">查看本次运行使用的输入</summary><dl className="mt-2 space-y-1">{Object.entries(run.parameters).map(([key, value]) => <div key={key} className="break-words"><dt className="inline font-medium">{run.definition.parameters.find((parameter) => parameter.key === key)?.label ?? key}：</dt><dd className="inline">{value || "（未填写）"}</dd></div>)}</dl></details>}
              {inputsChanged && <p className="mt-2 leading-5">当前输入已修改，以上结果仍对应本次运行的输入；如需验证新输入，请重新测试。</p>}
               {active(run) && <p className="mt-2 leading-5">按指令逐步执行中，执行过程见上方会话；本次运行按应用步骤直接执行，不再逐条询问工具权限。高风险步骤在发起前已由你确认。</p>}
               {(run?.steps?.length ?? 0) > 0 && (
                 <ol aria-label="步骤进度" className="mt-2 space-y-1">
                   {run!.steps!.map((step) => (
                     <li key={step.index} className="flex items-start gap-2">
                       <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-background text-[10px] text-muted-foreground">{step.index + 1}</span>
                       <span className="min-w-0 flex-1">
                         <span className={step.status === "running" ? "font-medium" : ""}>{step.title}</span>
                         <span className="ms-2 text-muted-foreground">{step.status === "succeeded" ? "已完成" : step.status === "running" ? "执行中" : step.status === "failed" ? "失败" : "待执行"}</span>
                       </span>
                     </li>
                   ))}
                 </ol>
               )}
               <InstructionPermissions sessionId={sessionId} active={active(run)} />
              {run.status === "paused" && <p className="mt-2 leading-5">执行已暂停。派发结果可能不确定，请先核对会话，不要重复执行。</p>}
              {clean && <p className="mt-2 leading-5">{draft.definition.verification ? "自动检查已通过：已找到本次产物" + (draft.definition.verification.contains ? "且包含指定内容。" : "。") : "未设置自动产物检查。"}自动检查不能证明业务结果正确。</p>}
              {clean && draft.definition.verification && <div className="mt-2"><p className="break-all">本次产物：/workspace/output/automation/{run.id}/{draft.definition.verification.path}</p>{onOpenFile && <button type="button" className="mt-2 text-primary underline underline-offset-2" onClick={() => onOpenFile(`/workspace/output/automation/${run.id}/${draft.definition.verification!.path}`)}>查看本次产物</button>}</div>}
              {run.error && <p className="mt-1 whitespace-pre-wrap break-words">{run.error}</p>}
              {run.output && <><p className="mt-3 font-medium">执行输出</p><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{run.output}</pre></>}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {needsConfirmation && (
              <label className="flex w-full items-start gap-2 text-xs">
                <input type="checkbox" checked={confirmed} onChange={(event) => { pending.current = null; setConfirmed(event.target.checked) }} />
                <span>我已核对需确认的高风险指令（发货、付款、删除等）</span>
              </label>
            )}
            {!draft.publishedAppId && !app && !clean && (
              <Button size="sm" disabled={busy || active(run) || run?.status === "paused" || (needsConfirmation && !confirmed)} onClick={() => void test()}>测试执行</Button>
            )}
            {run?.status === "paused" && (
              <>
                {run.promptId && <Button size="sm" disabled={busy} onClick={() => void resume("retry")}>继续观察</Button>}
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void resume("stop")}>结束运行</Button>
              </>
            )}
            {clean && !draft.publishedAppId && !app && (
              <><label className="flex w-full items-start gap-2 text-xs"><input type="checkbox" checked={resultConfirmed} disabled={inputsChanged} onChange={(event) => setResultConfirmed(event.target.checked)} /><span>我已核对本次运行的输入、输出和相关产物，确认结果符合预期</span></label><Button size="sm" disabled={busy || inputsChanged || !resultConfirmed} onClick={() => void publish()}>确认结果并创建应用</Button><Button size="sm" variant="outline" disabled={busy || (needsConfirmation && !confirmed)} onClick={() => void test()}>重新测试</Button></>
            )}
            {(app || draft.publishedAppId) && (
              <>
                <Button size="sm" disabled={busy || active(run) || run?.status === "paused" || (needsConfirmation && !confirmed)} onClick={() => void runApp()}>执行应用</Button>
                <a className="self-center text-xs text-primary underline" href={`#/cdp/instruction-apps/${app?.id ?? draft.publishedAppId}`}>查看应用详情</a>
              </>
            )}
          </div>
          {clean && !draft.publishedAppId && !app && <p className="text-xs text-muted-foreground">执行成功不代表业务结果正确，请先核对输出和文件，再确认创建。</p>}
        </div>
      )}
    </section>
  )
}
