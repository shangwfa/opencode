/**
 * fetch 版 SSE 订阅（hn-base-server）。
 * EventSource 无法携带 Authorization header，这里用 fetch 流式读取并解析 `data:` 行。
 */
import { getStoredToken, hnBaseUrl } from "./auth"

export type SseEvent = { type: string; properties: Record<string, unknown> }

export function subscribeSessionEvents(
  sessionId: string,
  onEvent: (event: SseEvent) => void,
  onEnd?: () => void,
): () => void {
  const controller = new AbortController()
  const token = getStoredToken()
  const headers: Record<string, string> = { accept: "text/event-stream" }
  if (token) headers.authorization = `Bearer ${token}`

  void (async () => {
    try {
      const res = await fetch(`${hnBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/event`, {
        headers,
        signal: controller.signal,
      })
      if (!res.ok || !res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE 事件以空行分隔；每段可能多行 data:
        let boundary: number
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const dataLines = chunk
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
          if (dataLines.length === 0) continue
          try {
            const parsed = JSON.parse(dataLines.join("\n")) as { type: string; data?: Record<string, unknown> }
            if (parsed?.type) onEvent({ type: parsed.type, properties: parsed.data ?? {} })
          } catch {
            // 心跳/非 JSON 忽略
          }
        }
      }
    } catch {
      // 中断（abort 时不回调）；网络错误通知上层重连
      if (!controller.signal.aborted) onEnd?.()
      return
    }
    // 流正常结束（服务端关闭）也通知重连
    if (!controller.signal.aborted) onEnd?.()
  })()

  return () => controller.abort()
}
