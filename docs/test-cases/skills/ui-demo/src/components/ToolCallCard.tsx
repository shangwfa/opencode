import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { MessagePart } from "../api"

interface ToolCallCardProps {
  part: MessagePart
}

export function ToolCallCard({ part }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false)
  const status = part.state?.status ?? "?"
  const input = part.state?.input ? JSON.stringify(part.state.input, null, 2) : ""
  const output = typeof part.state?.output === "string" ? part.state.output : ""
  const error = part.state?.error

  const statusStyle =
    status === "completed"
      ? "bg-emerald-50 text-emerald-600"
      : status === "running"
        ? "bg-blue-50 text-blue-600"
        : "bg-red-50 text-red-600"

  return (
    <div className="w-full overflow-hidden rounded-xl border border-gray-200 bg-white text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-gray-50"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-gray-400" />
        )}
        <span className="font-mono font-semibold text-gray-700">{part.tool}</span>
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusStyle}`}>
          {status}
        </span>
        {part.state?.title && (
          <span className="truncate text-gray-400">{part.state.title}</span>
        )}
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-gray-100 px-3 py-2.5">
          {input && (
            <div>
              <p className="mb-1 font-semibold text-gray-500">input</p>
              <pre className="max-h-40 overflow-auto rounded-lg bg-gray-50 p-2 text-[11px] leading-relaxed">
                {input}
              </pre>
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-red-50 p-2 text-red-600">{error}</div>
          )}
          {output && (
            <div>
              <p className="mb-1 font-semibold text-gray-500">output</p>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-2 text-[11px] leading-relaxed">
                {output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
