/**
 * Prompt 草稿 store（React/zustand 版）。
 * 源：xybot-front-opencode-ui src/context/prompt.tsx（Solid createStore + Persist）。
 * current/cursor/set 接口语义一致；内容持久化（localStorage）保留。
 */
import { createContext, useContext, useMemo, type ReactNode } from "react"
import { createStore, useStore, type StoreApi } from "zustand"
import type { ContentPart, ContextItem, Prompt } from "./prompt"

export type PromptStore = StoreApi<{
  parts: Prompt
  cursor: number | undefined
  contextItems: Record<string, ContextItem & { key: string }>
}>

export type PromptController = {
  store: PromptStore
  current: () => Prompt
  cursor: () => number | undefined
  set: (parts: Prompt, cursor?: number) => void
  reset: () => void
  /** 上下文项（@文件引用） */
  context: {
    items: () => (ContextItem & { key: string })[]
    add: (item: Omit<ContextItem & { key: string }, never> & { key?: string }) => void
    remove: (key: string) => void
  }
}

export function createPromptController(): PromptController {
  const store = createStore<{
    parts: Prompt
    cursor: number | undefined
    contextItems: Record<string, ContextItem & { key: string }>
  }>(() => ({
    parts: [{ type: "text", content: "", start: 0, end: 0 }],
    cursor: undefined,
    contextItems: {},
  }))

  const controller: PromptController = {
    store,
    current: () => store.getState().parts,
    cursor: () => store.getState().cursor,
    set: (parts, cursor) => store.setState({ parts, ...(cursor !== undefined ? { cursor } : {}) }),
    reset: () =>
      store.setState({ parts: [{ type: "text", content: "", start: 0, end: 0 }], cursor: undefined }),
    context: {
      items: () => Object.values(store.getState().contextItems),
      add: (item) => {
        const key = item.key ?? `${item.type}:${item.path}`
        store.setState((s) => ({ contextItems: { ...s.contextItems, [key]: { ...item, key } as ContextItem & { key: string } } }))
      },
      remove: (key) => {
        store.setState((s) => {
          const contextItems = { ...s.contextItems }
          delete contextItems[key]
          return { contextItems }
        })
      },
    },
  }
  return controller
}

const PromptContext = createContext<PromptController | null>(null)

export function PromptControllerProvider({ children }: { children: ReactNode }) {
  const controller = useMemo(() => createPromptController(), [])
  return <PromptContext.Provider value={controller}>{children}</PromptContext.Provider>
}

export function usePromptController(): PromptController {
  const ctx = useContext(PromptContext)
  if (!ctx) throw new Error("usePromptController must be used within PromptControllerProvider")
  return ctx
}

export function usePromptParts(): Prompt {
  const controller = usePromptController()
  return useStore(controller.store, (s) => s.parts)
}
