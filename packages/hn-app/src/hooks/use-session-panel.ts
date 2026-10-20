/**
 * 会话列表列（L2）收起状态。
 * 与 L1 不同：L1 是常驻图标栏（不再展开/收起），只有 L2 收放。
 * 收起后宽度归零、主区占满，入口在主区 header 左侧；状态持久化，⌘/Ctrl+B 切换。
 */
import { useCallback, useEffect, useState } from "react"

export const SESSION_PANEL_COLLAPSED_KEY = "hn-app:session-panel-collapsed"

export function readSessionPanelCollapsed(storage?: Pick<Storage, "getItem"> | null): boolean {
  const store = storage ?? (typeof window === "undefined" ? null : window.localStorage)
  if (!store) return false
  try {
    return store.getItem(SESSION_PANEL_COLLAPSED_KEY) === "1"
  } catch {
    return false
  }
}

export function writeSessionPanelCollapsed(
  collapsed: boolean,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const store = storage ?? (typeof window === "undefined" ? null : window.localStorage)
  if (!store) return
  try {
    store.setItem(SESSION_PANEL_COLLAPSED_KEY, collapsed ? "1" : "0")
  } catch {
    // 隐私模式/配额异常时忽略：状态仍在内存中生效
  }
}

/** ⌘/Ctrl+B 命中判定（输入框与可编辑区域内不拦截） */
export function isSessionPanelShortcut(event: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  target?: unknown
}): boolean {
  if (event.key.toLowerCase() !== "b") return false
  if (!event.metaKey && !event.ctrlKey) return false
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | undefined
  if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return false
  if (target?.isContentEditable) return false
  return true
}

export function useSessionPanelCollapsed(): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    setCollapsed(readSessionPanelCollapsed())
  }, [])

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      writeSessionPanelCollapsed(next)
      return next
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSessionPanelShortcut(event)) return
      event.preventDefault()
      toggle()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [toggle])

  return { collapsed, toggle }
}