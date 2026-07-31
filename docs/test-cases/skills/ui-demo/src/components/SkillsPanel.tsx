import { useState } from "react"
import { X } from "lucide-react"
import type { CatalogEntry, SessionSkill } from "../api"

interface SkillsPanelProps {
  catalog: CatalogEntry[]
  registered: SessionSkill[]
  onRegister: (key: string) => Promise<void>
  onUnregister: (name: string) => Promise<void>
  onClose: () => void
}

export function SkillsPanel({
  catalog,
  registered,
  onRegister,
  onUnregister,
  onClose,
}: SkillsPanelProps) {
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const registeredNames = new Set(registered.map((s) => s.name))
  const bundles = [...new Set(catalog.map((c) => c.bundle))]

  const handleRegister = async (key: string) => {
    setLoading(key)
    setError(null)
    try {
      await onRegister(key)
    } catch (e) {
      setError(`${key}: ${String(e)}`)
    } finally {
      setLoading(null)
    }
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-gray-200/70 bg-white">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-800">技能配置</h2>
          <p className="text-xs text-gray-400">{catalog.length} 个可用技能</p>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {bundles.map((bundle) => (
          <div key={bundle} className="mb-4">
            <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              {bundle}
            </p>
            <div className="space-y-2">
              {catalog
                .filter((c) => c.bundle === bundle)
                .map((skill) => {
                  const isRegistered = registeredNames.has(skill.name)
                  return (
                    <div
                      key={skill.key}
                      className="rounded-xl border border-gray-200 p-3 transition-colors hover:border-gray-300"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-gray-800">
                            {skill.name}
                          </p>
                          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-gray-500">
                            {skill.description.slice(0, 110) || "—"}
                          </p>
                          <p className="mt-1.5 text-[10px] text-gray-400">
                            {skill.resourceCount} resources · {(skill.totalBytes / 1024).toFixed(0)}KB
                          </p>
                        </div>
                        {isRegistered ? (
                          <button
                            onClick={() => onUnregister(skill.name)}
                            className="shrink-0 rounded-lg bg-red-50 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-100"
                          >
                            注销
                          </button>
                        ) : (
                          <button
                            onClick={() => handleRegister(skill.key)}
                            disabled={loading === skill.key}
                            className="shrink-0 rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            {loading === skill.key ? "..." : "添加"}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="border-t border-red-100 bg-red-50 px-4 py-2.5 text-xs text-red-600">
          {error}
        </div>
      )}

      {registered.length > 0 && (
        <div className="border-t border-gray-100 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            已添加 ({registered.length})
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {registered.map((s) => (
              <span
                key={s.name}
                className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700"
              >
                {s.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </aside>
  )
}
