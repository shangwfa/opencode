import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { api } from '@/lib/api'
import type { ModelOption } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface Props {
  model: ModelOption | null
  onModelChange: (model: ModelOption) => void
}

export default function ModelSelector({ model, onModelChange }: Props) {
  const [models, setModels] = useState<ModelOption[]>([])

  useEffect(() => {
    api
      .listModels()
      .then((data) => {
        setModels(data.models)
        const saved = localStorage.getItem('excalidraw-model-v2')
        const found =
          data.models.find((m) => `${m.providerID}/${m.modelID}` === saved) ??
          data.models.find(
            (m) => m.providerID === data.current.providerID && m.modelID === data.current.modelID,
          )
        if (found) onModelChange(found)
      })
      .catch(() => {})
  }, [])

  if (!model) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="max-w-56 text-muted-foreground">
          <span className="truncate">{model.label}</span>
          <ChevronDown className="ml-auto size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="max-h-72 w-72 overflow-auto">
        {models.map((m) => (
          <DropdownMenuItem
            key={m.label}
            className={m.label === model.label ? 'bg-accent' : ''}
            onClick={() => {
              onModelChange(m)
              localStorage.setItem('excalidraw-model-v2', `${m.providerID}/${m.modelID}`)
            }}
          >
            <span className="truncate">{m.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
