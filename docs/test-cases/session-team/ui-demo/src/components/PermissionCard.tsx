import { useState } from "react"
import {
  ShieldCheck,
} from "lucide-react"
import type { PermissionRequest } from "../types"
import { apiRequest } from "../api"

export function PermissionCard({ request, onResolved }: { request: PermissionRequest; onResolved: () => void }) {
  const [submitting, setSubmitting] = useState(false)
  const desc = request.metadata?.description || request.metadata?.command || request.patterns.join(", ")

  async function respond(reply: "always" | "once" | "reject") {
    if (submitting) return
    setSubmitting(true)
    try {
      await apiRequest(`/permission/${request.id}/reply`, {
        method: "POST",
        body: JSON.stringify({ reply }),
      })
      onResolved()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-2xl border border-blue-200 bg-blue-50/50 p-4">
      <div className="flex items-center gap-2 pb-2">
        <ShieldCheck size={16} className="text-blue-500" />
        <span className="text-sm font-semibold text-gray-800">权限请求</span>
        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
          {request.permission}
        </span>
      </div>
      <p className="text-sm text-gray-600">{desc}</p>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => respond("reject")}
          disabled={submitting}
          className="rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-50"
        >
          拒绝
        </button>
        <button
          type="button"
          onClick={() => respond("always")}
          disabled={submitting}
          className="rounded-xl bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {submitting ? "处理中..." : "允许"}
        </button>
      </div>
    </div>
  )
}
