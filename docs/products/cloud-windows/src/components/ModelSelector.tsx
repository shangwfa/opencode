import { useEffect, useState } from 'react'
import { Check, ChevronsUpDown, Sparkles } from 'lucide-react'
import { api, saveModel } from '../lib/api'
import type { ModelOption } from '../lib/api'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

interface Props {
  value: { providerID: string; modelID: string } | null
  onChange: (model: { providerID: string; modelID: string }) => void
}

export default function ModelSelector({ value, onChange }: Props) {
  const [models, setModels] = useState<ModelOption[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    api
      .listModels()
      .then(({ models }) => setModels(models))
      .catch(() => {})
  }, [])

  const current =
    models.find((m) => m.providerID === value?.providerID && m.modelID === value.modelID) ??
    null

  const providers = models.reduce<Record<string, ModelOption[]>>((acc, m) => {
    acc[m.providerID] = acc[m.providerID] ?? []
    acc[m.providerID].push(m)
    return acc
  }, {})

  function select(model: ModelOption) {
    const next = { providerID: model.providerID, modelID: model.modelID }
    saveModel(next)
    onChange(next)
    setOpen(false)
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 rounded-full px-2.5 text-xs font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Sparkles className="size-3.5" />
          {current ? current.name || current.modelID : '选择模型'}
          <ChevronsUpDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
        {Object.entries(providers).map(([providerID, providerModels]) => (
          <div key={providerID} className="py-1">
            <p className="px-2 py-1 text-[10px] font-semibold text-muted-foreground">
              {providerID}
            </p>
            {providerModels.map((model) => (
              <button
                key={model.label}
                onClick={() => select(model)}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate">
                  {model.name || model.modelID}
                </span>
                {current?.label === model.label && (
                  <Check className="size-3 shrink-0 text-primary" />
                )}
              </button>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
