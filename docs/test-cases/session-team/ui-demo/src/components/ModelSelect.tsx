import { useEffect, useRef, useState } from "react"
import {
  Check,
  ChevronDown,
  Cpu,
} from "lucide-react"
import type { ModelRef, ModelOption } from "../types"

export function ModelSelect({
  model,
  options,
  onChange,
}: {
  model: ModelRef
  options: ModelOption[]
  onChange: (model: ModelRef) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [open])
  const current = options.find((option) => option.providerID === model.providerID && option.modelID === model.modelID)
  const groups = [...new Map(options.map((option) => [option.providerID, option.providerName])).entries()]
  return (
    <div className="model-select" ref={ref}>
      <button
        type="button"
        className={`model-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        title="选择模型"
      >
        <Cpu size={13} />
        <span>{current?.modelName ?? model.modelID}</span>
        <ChevronDown size={12} className={`model-chevron ${open ? "open" : ""}`} />
      </button>
      {open && (
        <div className="model-panel">
          {groups.map(([providerID, providerName]) => (
            <div key={providerID}>
              <div className="model-group">{providerName}</div>
              {options
                .filter((option) => option.providerID === providerID)
                .map((option) => {
                  const selected = option.providerID === model.providerID && option.modelID === model.modelID
                  return (
                    <button
                      key={option.modelID}
                      type="button"
                      className={`model-option ${selected ? "selected" : ""}`}
                      onClick={() => {
                        onChange({ providerID: option.providerID, modelID: option.modelID })
                        setOpen(false)
                      }}
                    >
                      <span>{option.modelName}</span>
                      {selected && <Check size={13} />}
                    </button>
                  )
                })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
