import { useState } from "react"
import {
  Check,
  HelpCircle,
  X,
} from "lucide-react"
import type { QuestionRequest } from "../types"
import { apiRequest } from "../api"

export function QuestionCard({ request, onAnswered }: { request: QuestionRequest; onAnswered: () => void }) {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []))
  const [customText, setCustomText] = useState<string[]>(() => request.questions.map(() => ""))
  const [submitting, setSubmitting] = useState(false)

  const toggle = (questionIndex: number, label: string) => {
    setAnswers((current) =>
      current.map((answer, index) => {
        if (index !== questionIndex) return answer
        if (request.questions[questionIndex].multiple)
          return answer.includes(label) ? answer.filter((item) => item !== label) : [...answer, label]
        return [label]
      }),
    )
  }

  const canSubmit = request.questions.every(
    (question, index) => answers[index].length > 0 || (question.custom !== false && customText[index].trim()),
  )

  async function submit() {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    try {
      await apiRequest(`/question/${request.id}/reply`, {
        method: "POST",
        body: JSON.stringify({
          answers: request.questions.map((_, index) =>
            answers[index].length > 0 ? answers[index] : [customText[index].trim()],
          ),
        }),
      })
      onAnswered()
    } finally {
      setSubmitting(false)
    }
  }

  async function reject() {
    if (submitting) return
    setSubmitting(true)
    try {
      await apiRequest(`/question/${request.id}/reject`, { method: "POST" })
      onAnswered()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4">
      <div className="flex items-center gap-2 pb-2">
        <HelpCircle size={16} className="text-amber-500" />
        <span className="text-sm font-semibold text-gray-800">AI 在问你</span>
      </div>
      <div className="space-y-4">
        {request.questions.map((question, questionIndex) => (
          <div key={questionIndex}>
            <p className="text-sm font-medium text-gray-800">{question.question}</p>
            {question.header && <p className="mt-0.5 text-xs text-gray-400">{question.header}</p>}
            <div className="mt-2 space-y-1.5">
              {question.options.map((option) => {
                const active = answers[questionIndex].includes(option.label)
                return (
                  <button
                    type="button"
                    key={option.label}
                    onClick={() => toggle(questionIndex, option.label)}
                    className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors ${
                      active ? "border-blue-400 bg-blue-50" : "border-gray-200 bg-white hover:border-gray-300"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                        active ? "border-blue-500 bg-blue-500" : "border-gray-300"
                      }`}
                    >
                      {active && <Check size={12} className="text-white" />}
                    </span>
                    <span>
                      <span className={`block text-sm ${active ? "text-blue-700" : "text-gray-700"}`}>
                        {option.label}
                      </span>
                      {option.description && <span className="block text-xs text-gray-400">{option.description}</span>}
                    </span>
                  </button>
                )
              })}
              {question.custom !== false && (
                <input
                  value={customText[questionIndex]}
                  onChange={(event) =>
                    setCustomText((current) =>
                      current.map((text, index) => (index === questionIndex ? event.target.value : text)),
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
          type="button"
          onClick={reject}
          disabled={submitting}
          className="flex items-center gap-1 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-50"
        >
          <X size={14} />
          跳过
        </button>
        <button
          type="button"
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
