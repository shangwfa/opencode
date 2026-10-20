/**
 * showToast 桥接（保持源项目 API：@/ui/components/toast）。
 * ToastProvider 挂载时通过 registerToastHandler 注册实际实现；
 * 未挂载时降级 console（与 Solid 版行为差异：无 UI 时的静默兜底）。
 */
import type { StageToast } from "@/features/requirement/stage-machine"

export type ShowToastInput = StageToast

type Handler = (t: ShowToastInput) => void

let handler: Handler | null = null

export function registerToastHandler(h: Handler | null) {
  handler = h
}

export function showToast(t: ShowToastInput) {
  if (handler) {
    handler(t)
    return
  }
  // 测试/非 UI 环境兜底
  if (import.meta.env?.DEV) console.warn(`[toast] ${t.title}${t.description ? `: ${t.description}` : ""}`)
}
