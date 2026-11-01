import { useRef, useState } from "react"
import { useNavigate } from "react-router"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { automationApi, businessStages, operationLabel, type AutomationDefinition } from "@/lib/automation-apps"

export function SaveAppDialog({
  open,
  onOpenChange,
  sessionId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
}) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState<AutomationDefinition | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const generation = useRef(0)
  const generate = async () => {
    const token = ++generation.current
    setBusy(true)
    setError("")
    try {
      const result = await automationApi.draft(sessionId)
      if (token === generation.current) setDraft(result.definition)
    } catch (cause) {
      if (token === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (token === generation.current) setBusy(false)
    }
  }
  const save = async () => {
    if (!draft) return
    setBusy(true)
    setError("")
    try {
      const app = await automationApi.save(draft)
      onOpenChange(false)
      navigate(`/cdp/apps/${app.id}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        if (!next) {
          generation.current++
          setDraft(null)
          setError("")
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className="chat-workspace max-h-[85dvh] max-w-2xl overflow-y-auto bg-white">
        <DialogHeader>
          <DialogTitle>保存为自动化应用</DialogTitle>
          <DialogDescription>
            把这次做成的事情，变成下次填参数就能运行的应用。网页操作、文件与数据处理可以组合在一起。
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!draft ? (
          <div className="space-y-5 py-4">
            <p className="text-sm leading-6 text-muted-foreground">
              AI 会根据当前会话的执行记录整理业务步骤和参数。生成后请检查，草稿不代表已经验证通过。
            </p>
            <Button disabled={busy} onClick={() => void generate()}>
              {busy ? "正在整理步骤和参数…" : "从本次任务生成应用"}
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            <label className="block space-y-2 text-sm">
              <span>应用名称</span>
              <Input
                value={draft.name}
                maxLength={120}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="block space-y-2 text-sm">
              <span>应用说明</span>
              <Textarea
                value={draft.description}
                maxLength={4000}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <section aria-label="应用步骤">
              <h3 className="mb-2 text-sm font-medium">每次运行会做什么</h3>
              <ol className="divide-y rounded-xl border px-4">
                {businessStages(draft.steps).map((stage, index) => (
                  <li className="py-3 text-sm" key={stage.entries[0]!.step.id}>
                    <span className="me-2 text-muted-foreground">{index + 1}.</span>
                    {stage.title}
                    <details className="mt-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer">查看执行细节</summary>
                      {stage.entries.map(({ step }) => (
                        <div className="mt-2" key={step.id}>
                          {step.title} · {operationLabel(step)}
                          {step.operation.type === "script" && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{step.operation.source}</pre>}
                        </div>
                      ))}
                    </details>
                  </li>
                ))}
              </ol>
            </section>
            {!!draft.parameters.length && (
              <section>
                <h3 className="mb-3 text-sm font-medium">运行参数与默认值</h3>
                <div className="space-y-3">
                  {draft.parameters.map((parameter, index) => (
                    <label key={parameter.key} className="block space-y-1 text-sm">
                      <span>
                        {parameter.label}
                        {parameter.required ? " *" : ""}
                      </span>
                      <Input
                        value={parameter.defaultValue}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            parameters: draft.parameters.map((p, i) =>
                              i === index ? { ...p, defaultValue: e.target.value } : p,
                            ),
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              </section>
            )}
            <p className="rounded-lg bg-slate-50 p-3 text-xs leading-5 text-muted-foreground">
              固定执行不调用
              AI；定位失效时尝试局部修复。点击与数据处理脚本需确认，结果不确定时暂停，不盲目重跑。修复后的整次运行成功且未跳过步骤时，自动更新未发生版本变化的应用。
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => void generate()}>
                重新整理
              </Button>
              <Button disabled={busy || !draft.name.trim()} onClick={() => void save()}>
                {busy ? "正在保存…" : "确认保存"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
