import { Schema } from "effect"
import { SessionContextInsights as C } from "@opencode/schema/session-context-insights"
import { authEnabled } from "./auth"
import { baseFetch } from "./base-api"
import { rest, restUrl } from "./rest"
import { subscribeSessionEvents } from "./base-sse"

const get = async <A, I>(id: string, suffix: string, codec: Schema.Codec<A, I>, signal?: AbortSignal): Promise<A> => {
  const body = authEnabled
    ? await baseFetch<unknown>(`/api/sessions/${encodeURIComponent(id)}/context-insights${suffix}`, { signal })
    : await rest<unknown>(`/api/session/${encodeURIComponent(id)}/context-insights${suffix}`, { signal })
  return Schema.decodeUnknownSync(codec)(body)
}

export const contextInsights = {
  summary: async (id: string, signal?: AbortSignal) => (await get(id, "", Schema.Struct({ data: C.Summary }), signal)).data,
  analysis: async (id: string, before?: number, signal?: AbortSignal) => (await get(id, `/analysis?limit=100${before === undefined ? "" : `&before=${before}`}`, Schema.Struct({ data: C.Analysis }), signal)).data,
  family: async (id: string, signal?: AbortSignal) => (await get(id, "/family", Schema.Struct({ data: C.Family }), signal)).data,
  detail: async (id: string, requestID: string, signal?: AbortSignal) => (await get(id, `/requests/${encodeURIComponent(requestID)}`, Schema.Struct({ data: C.Detail }), signal)).data,
  content: async (id: string, requestID: string, index: number, signal?: AbortSignal) => (await get(id, `/requests/${encodeURIComponent(requestID)}/items/${index}`, Schema.Struct({ data: C.Content }), signal)).data,
  async overview(days: number, signal?: AbortSignal) {
    const to = Date.now()
    const range = { from: to - days * 86400000, to }
    let value: unknown
    if (authEnabled) value = await baseFetch("/api/sessions/context-insights/overview", { method: "POST", body: JSON.stringify(range), signal })
    else {
      const sessions = await rest<{ data: Array<{ id: string }>; cursor?: { next?: string } }>("/api/session", { query: { limit: 500 }, signal })
      value = await rest("/api/context-insights/overview", { method: "POST", body: { ...range, sessionIDs: sessions.data.map((session) => session.id) }, signal })
    }
    return Schema.decodeUnknownSync(Schema.Struct({ data: C.Overview }))(value).data
  },
}

/** Only invalidation signals cross this boundary; prompt and tool bodies stay on the detail routes. */
export function watchContext(id: string, invalidate: () => void): () => void {
  let disposed = false
  let subscription: (() => void) | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  const refresh = () => {
    clearTimeout(debounce)
    debounce = setTimeout(invalidate, 250)
  }
  const relevant = (type: string) => type === "session.context.captured" || /session\.(step\.(ended|failed)|execution\.(succeeded|failed|interrupted)|compaction\.(ended|failed))/.test(type)
  const reconnect = () => { if (!disposed) retry = setTimeout(() => { refresh(); connect() }, 2000) }
  const connect = () => {
    if (disposed) return
    if (authEnabled) { subscription = subscribeSessionEvents(id, (event) => { if (relevant(event.type)) refresh() }, reconnect); return }
    const controller = new AbortController()
    subscription = () => controller.abort()
    void (async () => {
      try {
        const response = await fetch(restUrl(`/api/session/${encodeURIComponent(id)}/event`), { signal: controller.signal })
        if (!response.ok || !response.body) { reconnect(); return }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (!disposed) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          let end: number
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
            if (!data) continue
            try { const event = JSON.parse(data) as { type?: unknown }; if (typeof event.type === "string" && relevant(event.type)) refresh() } catch { /* Keep heartbeats and malformed frames out of the view state. */ }
          }
        }
      } catch { if (controller.signal.aborted) return }
      reconnect()
    })()
  }
  connect()
  return () => { disposed = true; clearTimeout(retry); clearTimeout(debounce); subscription?.() }
}
