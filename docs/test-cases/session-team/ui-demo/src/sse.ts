export type SSEEvent = {
  id: string
  type: string
  properties: Record<string, unknown>
}

export function subscribeEvents(
  directory: string,
  sessionID: string,
  onEvent: (event: SSEEvent) => void,
  onError?: (error: unknown) => void,
) {
  let closed = false
  let retryDelay = 500
  let controller: AbortController | null = null

  async function connect() {
    while (!closed) {
      try {
        controller = new AbortController()
        const response = await fetch(`/opencode/event?sessionID=${encodeURIComponent(sessionID)}`, {
          headers: { "x-opencode-directory": directory },
          signal: controller.signal,
        })
        if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`)
        retryDelay = 500
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (!closed) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const chunks = buffer.split("\n\n")
          buffer = chunks.pop() ?? ""
          for (const chunk of chunks) {
            const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "))
            if (!dataLine) continue
            try {
              const raw = JSON.parse(dataLine.slice(6)) as SSEEvent & { payload?: SSEEvent }
              onEvent(raw.payload ?? raw)
            } catch {
              // Ignore malformed individual events and keep the stream alive.
            }
          }
        }
      } catch (error) {
        if (closed || (error as Error)?.name === "AbortError") break
        onError?.(error)
      }
      if (!closed) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay))
        retryDelay = Math.min(retryDelay * 2, 5000)
      }
    }
  }

  void connect()
  return () => {
    closed = true
    controller?.abort()
  }
}
