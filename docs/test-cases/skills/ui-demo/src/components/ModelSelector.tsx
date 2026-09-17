import { useEffect, useMemo, useState } from "react"
import { ChevronDown } from "lucide-react"
import type { ModelRef, ProvidersResponse } from "../api"
import { listProviders } from "../api"

interface ModelSelectorProps {
  value: ModelRef
  onChange: (model: ModelRef) => void
}

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const [providers, setProviders] = useState<ProvidersResponse | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    listProviders().then(setProviders).catch(console.error)
  }, [])

  const groups = useMemo(() => {
    if (!providers) return []
    return providers.connected
      .map((pid) => {
        const p = providers.all.find((x) => x.id === pid)
        if (!p) return null
        return {
          id: pid,
          name: p.name,
          models: Object.values(p.models).map((m) => ({ providerID: pid, modelID: m.id })),
        }
      })
      .filter((g): g is NonNullable<typeof g> => g !== null)
  }, [providers])

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100"
      >
        <span className="font-mono">{value.providerID}/{value.modelID}</span>
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 max-h-72 w-72 overflow-y-auto rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg">
          {groups.map((g) => (
            <div key={g.id}>
              <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                {g.name}
              </p>
              {g.models.map((m) => {
                const active = m.providerID === value.providerID && m.modelID === value.modelID
                return (
                  <button
                    key={`${m.providerID}/${m.modelID}`}
                    onClick={() => {
                      onChange(m)
                      setOpen(false)
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                      active ? "bg-blue-50 text-blue-700" : "text-gray-600 hover:bg-gray-100"
                    }`}
                  >
                    <span className="font-mono text-xs">{m.modelID}</span>
                    {active && <span className="text-xs">✓</span>}
                  </button>
                )
              })}
            </div>
          ))}
          {groups.length === 0 && (
            <p className="px-2 py-3 text-xs text-gray-400">加载模型列表中...</p>
          )}
        </div>
      )}
    </div>
  )
}
