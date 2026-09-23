import { useState } from "react"
import { Check, HelpCircle, X } from "lucide-react"
import type { QuestionRequest } from "../api"
import { rejectQuestion, replyQuestion } from "../api"

interface QuestionCardProps {
  request: QuestionRequest
  onAnswered: () => void
}

export function QuestionCard({ request, onAnswered }: QuestionCardProps) {
  const [answers, setAnswers] = useState<string[][]>(() =>
    request.questions.map(() => []),
  )
  const [customText, setCustomText] = useState<string[]>(() =>
    request.questions.map(() => ""),
  )
  const [submitting, setSubmitting] = useState(false)

  const toggle = (qi: number, label: string) => {
    setAnswers((prev) =>
      prev.map((ans, i) => {
        if (i !== qi) return ans
        const q = request.questions[qi]
        if (q.multiple) {
          return ans.includes(label) ? ans.filter((l) => l !== label) : [...ans, label]
        }
        return [label]
      }),
    )
  }

  const canSubmit = request.questions.every((q, i) => {
    if (answers[i].length > 0) return true
    if (q.custom !== false && customText[i].trim()) return true
    return false
  })

  const submit = async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    try {
      const payload = request.questions.map((_q, i) => {
        if (answers[i].length > 0) return answers[i]
        return [customText[i].trim()]
      })
      await replyQuestion(request.id, payload)
      onAnswered()
    } catch (e) {
      console.error("replyQuestion failed", e)
    } finally {
      setSubmitting(false)
    }
  }

  const reject = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      await rejectQuestion(request.id)
      onAnswered()
    } catch (e) {
      console.error("rejectQuestion failed", e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4">
      <div className="flex items-center gap-2 pb-2">
        <HelpCircle className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-semibold text-gray-800">AI 在问你</span>
      </div>

      <div className="space-y-4">
        {request.questions.map((q, qi) => (
          <div key={qi}>
            <p className="text-sm font-medium text-gray-800">{q.question}</p>
            {q.header && <p className="mt-0.5 text-xs text-gray-400">{q.header}</p>}

            <div className="mt-2 space-y-1.5">
              {q.options.map((opt) => {
                const active = answers[qi].includes(opt.label)
                return (
                  <button
                    key={opt.label}
                    onClick={() => toggle(qi, opt.label)}
                    className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors ${
                      active
                        ? "border-blue-400 bg-blue-50"
                        : "border-gray-200 bg-white hover:border-gray-300"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                        active ? "border-blue-500 bg-blue-500" : "border-gray-300"
                      }`}
                    >
                      {active && <Check className="h-3 w-3 text-white" />}
                    </span>
                    <span>
                      <span className={`block text-sm ${active ? "text-blue-700" : "text-gray-700"}`}>
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="block text-xs text-gray-400">{opt.description}</span>
                      )}
                    </span>
                  </button>
                )
              })}

              {q.custom !== false && (
                <input
                  value={customText[qi]}
                  onChange={(e) =>
                    setCustomText((prev) =>
                      prev.map((t, i) => (i === qi ? e.target.value : t)),
                    )
                  }
                  placeholder="或输入自定义回答..."
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400"
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          onClick={reject}
          disabled={submitting}
          className="flex items-center gap-1 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
          跳过
        </button>
        <button
          onClick={submit}
          disabled={!canSubmit || submitting}
          className="rounded-xl bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {submitting ? "提交中..." : "确认"}
        </button>
      </div>
    </div>
  )
}
