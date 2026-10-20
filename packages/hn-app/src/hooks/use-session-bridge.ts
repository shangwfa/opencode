/**
 * 会话数据桥（网关模式）。
 *  - 启用 hn-base-server 时：单会话 SSE + 网关消息接口
 *  - 未启用：返回 undefined，DataProvider 保持「全局 /event + SaaS 直连」现状
 */
import { useMemo } from "react"
import type { DataBridge } from "@/context/data"
import { sessionSource, usingBaseServer } from "@/lib/session-source"

export function useSessionBridge(sessionId?: string): DataBridge | undefined {
  return useMemo<DataBridge | undefined>(() => {
    if (!usingBaseServer()) return undefined
    const source = sessionSource()
    return {
      subscribe: (onEvent, onEnd) =>
        sessionId ? source.subscribe(sessionId, onEvent, onEnd) : () => {},
      loadMessages: (sid) =>
        source.messages(sid) as ReturnType<NonNullable<DataBridge["loadMessages"]>>,
    }
  }, [sessionId])
}
