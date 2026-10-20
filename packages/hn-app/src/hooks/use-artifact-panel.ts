/**
 * 右侧面板（需求对话页「阶段产物」）收起状态。
 * 与左侧会话列表对称：PanelRight 家族图标，状态持久化，⌘/Ctrl+. 切换。
 */
import { useCallback, useEffect, useState } from "react"

export const ARTIFACT_PANEL_COLLAPSED_KEY = "hn-app:artifact-panel-collapsed"

export function readArtifactPanelCollapsed(storage?: Pick<Storage, "getItem"> | null): boolean {
  const store = storage ?? (typeof window === "undefined" ? null : window.localStorage)
  if (!store) return false
  try {
    return store.getItem(ARTIFACT_PANEL_COLLAPSED_KEY) === "1"
  } catch {
    return false
  }
}

export function writeArtifactPanelCollapsed(
  collapsed: boolean,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const store = storage ?? (typeof window === "undefined" ? null : window.localStorage)
  if (!store) return
  try {
    store.setItem(ARTIFACT_PANEL_COLLAPSED_KEY, collapsed ? "1" : "0")
  } catch {
    // 隐私模式/配额异常时忽略：状态仍在内存中生效
  }
}

/** ⌘/Ctrl+. 命中判定（输入框与可编辑区域内不拦截） */
export function isArtifactPanelShortcut(event: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  target?: unknown
}): boolean {
  if (event.key !== ".") return false
  if (!event.metaKey && !event.ctrlKey) return false
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | undefined
  if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return false
  if (target?.isContentEditable) return false
  return true
}

export function useArtifactPanelCollapsed(): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    setCollapsed(readArtifactPanelCollapsed())
  }, [])

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      writeArtifactPanelCollapsed(next)
      return next
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isArtifactPanelShortcut(event)) return
      event.preventDefault()
      toggle()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [toggle])

  return { collapsed, toggle }
}