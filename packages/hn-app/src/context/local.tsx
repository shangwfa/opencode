import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import type { ModelRef } from "@/features/requirement/flows/config"

/**
 * 本地选择状态（agent / model / variant），localStorage 持久化。
 * 源：xybot-front-opencode-ui src/context/local.tsx 的 chat 必需面。
 */
export type LocalContextValue = {
  agent: {
    current: () => string | undefined
    set: (name: string) => void
  }
  model: {
    current: () => ModelRef | undefined
    set: (model: ModelRef) => void
    variant: {
      current: () => string | undefined
      set: (variant: string | undefined) => void
    }
  }
}

const STORAGE_KEY = "hnapp.local.selection.v1"

type Persisted = { agent?: string; model?: ModelRef; variant?: string }

function readStorage(): Persisted {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Persisted
  } catch {
    return {}
  }
}

const LocalContext = createContext<LocalContextValue | null>(null)

export function LocalProvider({ children }: { children: ReactNode }) {
  const [persisted, setPersisted] = useState<Persisted>(readStorage)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
    } catch {
      // storage 不可用时仅保留内存态
    }
  }, [persisted])

  const value: LocalContextValue = {
    agent: {
      current: () => persisted.agent,
      set: (name) => setPersisted((p) => ({ ...p, agent: name })),
    },
    model: {
      current: () => persisted.model,
      set: (model) => setPersisted((p) => ({ ...p, model })),
      variant: {
        current: () => persisted.variant,
        set: (variant) => setPersisted((p) => ({ ...p, variant })),
      },
    },
  }

  return <LocalContext.Provider value={value}>{children}</LocalContext.Provider>
}

export function useLocal(): LocalContextValue {
  const ctx = useContext(LocalContext)
  if (!ctx) throw new Error("useLocal must be used within LocalProvider")
  return ctx
}
