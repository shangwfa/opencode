// ── SSE 事件流客户端（fetch streaming，EventSource 不支持自定义 header）──

export interface SSEEvent {
  id: string
  type: string
  properties: Record<string, unknown>
}

export type SSEHandler = (event: SSEEvent) => void

/**
 * 订阅 opencode 实例级 SSE 事件流。
 * 返回 close 函数。断线后自动重连（指数退避，上限 5s）。
 */
export function subscribeEvents(directory: string, onEvent: SSEHandler, onError?: (e: unknown) => void) {
  let closed = false
  let retryDelay = 500
  let controller: AbortController | null = null

  async function connect() {
    while (!closed) {
      try {
        controller = new AbortController()
        const res = await fetch("/opencode/event", {
          headers: { "x-opencode-directory": directory },
          signal: controller.signal,
        })
        if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
        retryDelay = 500 // 连接成功，重置退避

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (!closed) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const chunks = buffer.split("\n\n")
          buffer = chunks.pop() ?? ""
          for (const chunk of chunks) {
            const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "))
            if (!dataLine) continue
            try {
              onEvent(JSON.parse(dataLine.slice(6)) as SSEEvent)
            } catch {
              // 忽略单条解析失败
            }
          }
        }
      } catch (e) {
        if (closed) break
        if ((e as Error)?.name === "AbortError") break
        onError?.(e)
      }

      if (!closed) {
        await new Promise((r) => setTimeout(r, retryDelay))
        retryDelay = Math.min(retryDelay * 2, 5000)
      }
    }
  }

  connect()
  return () => {
    closed = true
    controller?.abort()
  }
}

// ── 事件 properties 类型 ──

export interface PartDeltaProps {
  sessionID: string
  messageID: string
  partID: string
  field: string
  delta: string
}

export interface PartUpdatedProps {
  sessionID: string
  part: {
    id: string
    type: string
    messageID: string
    text?: string
    tool?: string
    state?: { status?: string; input?: unknown; output?: string; title?: string; error?: string }
  }
}

export interface QuestionAskedProps {
  id: string
  sessionID: string
  questions: unknown[]
}
