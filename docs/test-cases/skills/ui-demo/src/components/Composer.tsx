import { useState, type KeyboardEvent } from "react"
import { Plus, SendHorizonal, X } from "lucide-react"
import type { ModelRef, SessionSkill } from "../api"
import { ModelSelector } from "./ModelSelector"

interface ComposerProps {
  busy: boolean
  registered: SessionSkill[]
  selected: Set<string>
  model: ModelRef
  onModelChange: (model: ModelRef) => void
  onToggleSkill: (name: string) => void
  onSend: (text: string) => Promise<void>
}

export function Composer({
  busy,
  registered,
  selected,
  model,
  onModelChange,
  onToggleSkill,
  onSend,
}: ComposerProps) {
  const [text, setText] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)

  const submit = async () => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setText("")
    await onSend(trimmed)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="px-4 pb-4">
      <div className="mx-auto max-w-4xl rounded-2xl border border-gray-200 bg-white shadow-sm">
        {/* 选中的技能 chips */}
        {selected.size > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {[...selected].map((name) => (
              <span
                key={name}
                className="flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700"
              >
                {name}
                <button
                  onClick={() => onToggleSkill(name)}
                  className="rounded-full p-0.5 hover:bg-blue-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 px-3 py-2.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="发消息测试技能..."
            rows={2}
            className="max-h-40 flex-1 resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-gray-400"
          />
          <button
            onClick={submit}
            disabled={busy || !text.trim()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
          >
            <SendHorizonal className="h-4 w-4" />
          </button>
        </div>

        {/* 底部操作栏 */}
        <div className="relative flex items-center gap-1 border-t border-gray-100 px-3 py-2">
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100"
          >
            <Plus className="h-3.5 w-3.5" />
            添加技能
          </button>
          <ModelSelector value={model} onChange={onModelChange} />
          <span className="ml-auto text-[11px] text-gray-300">
            Enter 发送 · Shift+Enter 换行
          </span>

          {/* 技能选择弹层 */}
          {pickerOpen && (
            <div className="absolute bottom-full left-3 mb-2 w-64 rounded-xl border border-gray-200 bg-white p-2 shadow-lg">
              <p className="px-2 pb-1.5 text-[11px] font-medium text-gray-400">
                本会话已注册技能
              </p>
              {registered.length === 0 ? (
                <p className="px-2 py-3 text-xs text-gray-400">
                  还没有注册技能，请先在右侧面板注册
                </p>
              ) : (
                registered.map((s) => {
                  const active = selected.has(s.name)
                  return (
                    <button
                      key={s.name}
                      onClick={() => onToggleSkill(s.name)}
                      className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                        active ? "bg-blue-50 text-blue-700" : "text-gray-600 hover:bg-gray-100"
                      }`}
                    >
                      {s.name}
                      {active && <span className="text-xs">✓</span>}
                    </button>
                  )
                })
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
