import { useEffect, useState } from "react"
import type { Form } from "@opencode/schema/form"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** 通用会话表单：待回答问题（websearch provider 选择、确认类问答等），浏览器会话与聊天会话共用。 */
export type FormLoad = (sessionId: string) => Promise<{ data: Form.Info[] }>
export type FormReply = (sessionId: string, form: string, answer: Form.Answer) => Promise<unknown>

export function visibleFormFields(fields: readonly Form.Field[], answer: Form.Answer) {
  const visible: Form.Field[] = []
  const active = new Set<string>()
  for (const field of fields) {
    if (
      field.type === "external" ||
      !field.when?.length ||
      field.when.every((rule) => {
        const value = answer[rule.key]
        if (!active.has(rule.key) || value === undefined) return false
        const equal = Array.isArray(value) ? value.includes(String(rule.value)) : value === rule.value
        return rule.op === "eq" ? equal : !equal
      })
    ) {
      visible.push(field)
      active.add(field.key)
    }
  }
  return visible
}

function PendingForm({ form, sessionId, reply, replied }: { form: Form.Info; sessionId: string; reply: FormReply; replied: () => void }) {
  const [answer, setAnswer] = useState<Form.Answer>(() =>
    Object.fromEntries(
      form.fields.flatMap((field) =>
        field.type !== "external" && field.default !== undefined ? [[field.key, field.default]] : [],
      ),
    ),
  )
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const visible = visibleFormFields(form.fields, answer)
  const submit = async () => {
    setBusy(true)
    setError("")
    try {
      const filtered = Object.fromEntries(
        visible
          .filter((field) => field.type !== "external" && answer[field.key] !== undefined)
          .map((field) => [field.key, answer[field.key]]),
      )
      await reply(sessionId, form.id, filtered)
      replied()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className="space-y-3 rounded-xl border bg-background p-4"
    >
      <div>
        <h3 className="text-sm font-medium">{form.title === "Questions" ? "需要你确认" : form.title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">AI 正在等待你的回答，确认后继续。</p>
      </div>
      {visible.map((field) => {
        if (field.type === "external")
          return (
            <p key={field.key} className="text-xs">
              {field.title}
              {/^https?:\/\//.test(field.url) && (
                <a href={field.url} target="_blank" rel="noreferrer" className="ml-2 underline">
                  打开外部确认页面
                </a>
              )}
            </p>
          )
        const value = answer[field.key]
        return (
          <label key={field.key} className="block space-y-1.5 text-xs">
            <span>
              {field.title || field.key}
              {field.required ? " *" : ""}
            </span>
            {field.description && <span className="block text-muted-foreground">{field.description}</span>}
            {field.type === "boolean" ? (
              <select
                required={field.required}
                className="h-8 w-full rounded-md border bg-background px-2"
                value={value === undefined ? "" : String(value)}
                onChange={(e) => setAnswer((a) => ({ ...a, [field.key]: e.target.value === "true" }))}
              >
                <option value="" disabled>
                  请选择
                </option>
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
            ) : field.type === "multiselect" ? (
              <div className="flex flex-wrap gap-3">
                {field.options.map((option) => (
                  <span key={option.value} className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={Array.isArray(value) && value.includes(option.value)}
                      onChange={(e) =>
                        setAnswer((a) => {
                          const values = Array.isArray(a[field.key]) ? (a[field.key] as string[]) : []
                          return {
                            ...a,
                            [field.key]: e.target.checked
                              ? [...values, option.value]
                              : values.filter((v) => v !== option.value),
                          }
                        })
                      }
                    />
                    {option.label}
                  </span>
                ))}
              </div>
            ) : field.type === "string" && field.options?.length && !field.custom ? (
              <select
                className="h-8 w-full rounded-md border bg-background px-2"
                required={field.required}
                value={typeof value === "string" ? value : ""}
                onChange={(e) => setAnswer((a) => ({ ...a, [field.key]: e.target.value }))}
              >
                <option value="">请选择</option>
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                type={field.type === "integer" || field.type === "number" ? "number" : "text"}
                step={field.type === "integer" ? 1 : "any"}
                min={field.type === "number" || field.type === "integer" ? field.minimum : undefined}
                max={field.type === "number" || field.type === "integer" ? field.maximum : undefined}
                minLength={field.type === "string" ? field.minLength : undefined}
                maxLength={field.type === "string" ? field.maxLength : undefined}
                pattern={field.type === "string" ? field.pattern : undefined}
                required={field.required}
                value={typeof value === "string" || typeof value === "number" ? value : ""}
                onChange={(e) =>
                  setAnswer((a) => {
                    const next = { ...a }
                    if (e.target.value === "") delete next[field.key]
                    else
                      next[field.key] =
                        field.type === "number" || field.type === "integer" ? Number(e.target.value) : e.target.value
                    return next
                  })
                }
              />
            )}
          </label>
        )
      })}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Button size="sm" disabled={busy}>
        {busy ? "正在提交…" : "确认并继续"}
      </Button>
    </form>
  )
}

export function SessionForms({
  sessionId,
  load,
  reply,
  active = true,
}: {
  sessionId: string
  load: FormLoad
  reply: FormReply
  /** 仅在本轮执行中轮询，避免空闲时反复请求。 */
  active?: boolean
}) {
  const [forms, setForms] = useState<Form.Info[]>([])
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await load(sessionId)
        if (!stopped) {
          setForms(result.data)
          setError("")
        }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!stopped && active) timer = setTimeout(poll, 2500)
      }
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [sessionId, refresh, active, load])
  if (!forms.length && !error) return null
  return (
    <div className="space-y-3" aria-label="待确认问题">
      {error && (
        <p role="alert" className="text-xs text-destructive">
          无法获取待确认问题：{error}
        </p>
      )}
      {forms.map((form) => (
        <PendingForm
          key={form.id}
          form={form}
          sessionId={sessionId}
          reply={reply}
          replied={() => {
            setForms((items) => items.filter((item) => item.id !== form.id))
            setRefresh((n) => n + 1)
          }}
        />
      ))}
    </div>
  )
}
