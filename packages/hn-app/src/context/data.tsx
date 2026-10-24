import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { Message, Part, SessionStatus } from "@/types/opencode"
import { useSDK } from "./sdk"
import { byMessageCreated } from "@/shared/util/session"
import { Binary } from "@/shared/util/binary"
import { sessionMessages, subscribeEvents } from "@/lib/rest"
import { isLegacyShellText, isSystemMessage } from "@/lib/system-messages"

/**
 * 会话实时数据层（React 版，纯 REST）。
 * 源：xybot-front-opencode-ui src/context/sync.tsx + global-sync/event-reducer.ts 的 chat 必需面。
 * 事件协议 1:1：session.status / message.updated(.removed) / message.part.updated(.removed)。
 * 加载：GET /session/{id}/message（返回 [{info, parts}]）；实时：GET /event（SSE，EventSource）。
 */

export type DataState = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  session_status: Record<string, SessionStatus>
  session_error: Record<string, unknown>
  /** 已加载过消息的会话（避免重复拉取） */
  loaded: Record<string, boolean>
  /** 平台编排消息（不出现在时间线）：messageID → true */
  hidden: Record<string, boolean>
  /** SSE 内容优先于可能滞后的消息快照；在本轮快照确认后释放。 */
  streamed?: Record<string, Part[]>
}

type EventLike = { type: string; properties: Record<string, unknown> }

export function mergeStreamedParts(snapshot: Part[], streamed: Part[]): Part[] {
  const live = new Map(streamed.map((part) => [part.id, part]))
  const ids = new Set(snapshot.map((part) => part.id))
  // 持久化快照是终态：同 id 时只有流式副本更长（说明快照还没跟上）才用流式副本，
  // 否则已结束的段落会被流式副本覆盖回"思考中"。
  const textLength = (part: Part) => (part.type === "text" || part.type === "reasoning" ? part.text.length : 0)
  return [
    ...snapshot.map((part) => {
      const candidate = live.get(part.id)
      return candidate !== undefined && textLength(candidate) > textLength(part) ? candidate : part
    }),
    ...streamed.filter((part) => !ids.has(part.id)),
  ]
}

/** [MIGRATION] 事件归约（对齐 event-reducer.ts 的 chat 必需分支） */
export function applyDataEvent(
  state: DataState,
  event: EventLike,
): DataState {
  // 事件载荷缺失（例如新版本服务端换了信封）时保持状态不变，绝不在渲染期抛错。
  if (!event.properties || typeof event.properties !== "object") return state
  switch (event.type) {
    case "session.step.failed": {
      const props = event.properties as { sessionID: string; assistantMessageID: string; error: unknown }
      const messages = state.message[props.sessionID] ?? []
      return { ...state, message: { ...state.message, [props.sessionID]: messages.map((message) => message.id === props.assistantMessageID && message.role === "assistant" ? { ...message, error: props.error, time: { ...message.time, completed: Date.now() } } : message) } }
    }
    case "session.step.started": {
      const props = event.properties as { sessionID: string; assistantMessageID: string; promptMessageID?: string; agent: string; model: { id: string; providerID: string } }
      const list = state.message[props.sessionID] ?? []
      if (list.some((message) => message.id === props.assistantMessageID)) return state
      const parentID = props.promptMessageID ?? list.findLast((message) => message.role === "user")?.id ?? ""
      const message: Message = { id: props.assistantMessageID, sessionID: props.sessionID, role: "assistant", parentID, agent: props.agent, modelID: props.model.id, providerID: props.model.providerID, time: { created: Date.now() } }
      return { ...state, message: { ...state.message, [props.sessionID]: [...list, message] } }
    }
    case "session.reasoning.started":
    case "session.reasoning.delta":
    case "session.reasoning.ended":
    case "session.text.started":
    case "session.text.delta":
    case "session.text.ended": {
      const props = event.properties as { sessionID: string; assistantMessageID: string; ordinal: number; delta?: string; text?: string }
      const type = event.type.startsWith("session.reasoning.") ? "reasoning" : "text"
      const id = `${props.assistantMessageID}_${type}_${props.ordinal}`
      const current = state.part[props.assistantMessageID] ?? []
      const previous = current.find((part) => part.id === id)
      if (previous?.type !== undefined && previous.type !== type) return state
      const prior = previous?.type === "text" || previous?.type === "reasoning" ? previous : undefined
      const ended = event.type.endsWith(".ended")
      if (!ended && prior?.time?.end !== undefined) return state
      // started 可以晚于初次快照到达，不清空已收到的内容。
      const part: Part = { id, sessionID: props.sessionID, messageID: props.assistantMessageID, type,
        text: ended ? props.text ?? "" : (prior?.text ?? "") + (props.delta ?? ""),
        time: { start: prior?.time?.start ?? Date.now(), ...(ended ? { end: Date.now() } : {}) } }
      const next = previous ? current.map((item) => item.id === id ? part : item) : [...current, part]
      const live = state.streamed?.[props.assistantMessageID] ?? []
      const streamed = live.some((item) => item.id === id) ? live.map((item) => item.id === id ? part : item) : [...live, part]
      return { ...state, part: { ...state.part, [props.assistantMessageID]: next }, streamed: { ...state.streamed, [props.assistantMessageID]: streamed } }
    }
    case "session.execution.started": {
      const id = event.properties.sessionID as string
      return { ...state, session_status: { ...state.session_status, [id]: { type: "busy" } }, session_error: { ...state.session_error, [id]: undefined } }
    }
    case "session.execution.failed":
    case "session.execution.succeeded":
    case "session.execution.interrupted": {
      const id = event.properties.sessionID as string
      return { ...state, session_status: { ...state.session_status, [id]: { type: "idle" } }, session_error: { ...state.session_error, [id]: event.properties.error } }
    }
    case "session.status": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      if (!props.sessionID) break
      return {
        ...state,
        session_status: { ...state.session_status, [props.sessionID]: props.status },
      }
    }
    case "message.updated": {
      const info = (event.properties as { info: Message }).info
      // 平台编排（prepare 的 clone/切分支）不进入 chat 时间线
      if (isSystemMessage(info)) break
      if (state.hidden[info.id]) break
      if (info.role === "assistant" && state.hidden[info.parentID]) break
      const messages = state.message[info.sessionID] ?? []
      const idx = messages.findIndex((m) => m.id === info.id)
      const next =
        idx >= 0
          ? messages.map((m, i) => (i === idx ? info : m))
          : [...messages, info].sort(byMessageCreated)
      return { ...state, message: { ...state.message, [info.sessionID]: next } }
    }
    case "message.removed": {
      const props = event.properties as { sessionID: string; messageID: string }
      const messages = (state.message[props.sessionID] ?? []).filter((m) => m.id !== props.messageID)
      const part = { ...state.part }
      delete part[props.messageID]
      const hidden = { ...state.hidden }
      delete hidden[props.messageID]
      return { ...state, message: { ...state.message, [props.sessionID]: messages }, part, hidden }
    }
    case "message.part.updated": {
      const part = (event.properties as { part: Part }).part
      // legacy shell 的系统编排消息：识别到固定文案后，连同它触发的 assistant 回复一起隐藏
      if (part.type === "text" && isLegacyShellText(part.text) && !state.hidden[part.messageID]) {
        const hidden = { ...state.hidden, [part.messageID]: true }
        const message = { ...state.message }
        for (const [sessionID, list] of Object.entries(message)) {
          const next = list.filter(
            (m) => m.id !== part.messageID && !(m.role === "assistant" && m.parentID === part.messageID),
          )
          if (next.length !== list.length) message[sessionID] = next
        }
        return { ...state, hidden, message }
      }
      if (state.hidden[part.messageID]) return state
      const parts = state.part[part.messageID]
      if (!parts) {
        return { ...state, part: { ...state.part, [part.messageID]: [part] } }
      }
      const result = Binary.search(parts, part.id, (p) => p.id)
      const next = result.found
        ? parts.map((p, i) => (i === result.index ? part : p))
        : [...parts.slice(0, result.index), part, ...parts.slice(result.index)]
      return { ...state, part: { ...state.part, [part.messageID]: next } }
    }
    case "message.part.removed": {
      const props = event.properties as { messageID: string; partID: string }
      const parts = state.part[props.messageID]
      if (!parts) break
      const next = parts.filter((p) => p.id !== props.partID)
      return { ...state, part: { ...state.part, [props.messageID]: next } }
    }
  }
  return state
}

/**
 * 数据桥接：启用 hn-base-server 时替代「全局 SSE + SaaS 消息接口」。
 * 事件协议与 SaaS /event 完全一致（base-server 透传），归约逻辑复用。
 */
export type DataBridge = {
  subscribe?: (
    onEvent: (event: EventLike) => void,
    onEnd: () => void,
  ) => () => void
  loadMessages?: (sessionID: string) => Promise<{ message?: Message; info?: Message; parts?: Part[] }[]>
}

export type DataContextValue = {
  state: DataState
  /** 拉取会话消息（幂等；force 可刷新） */
  loadMessages: (sessionID: string, opts?: { force?: boolean }) => Promise<void>
  /** 乐观插入用户消息 + parts（发送时本地立即回显） */
  optimisticAdd: (input: { sessionID: string; message: Message; parts: Part[] }) => void
  optimisticRemove: (input: { sessionID: string; messageID: string }) => void
  setSessionStatus: (sessionID: string, status: SessionStatus) => void
}

const DataContext = createContext<DataContextValue | null>(null)

export function DataProvider({ bridge, children }: { bridge?: DataBridge; children: ReactNode }) {
  const { directory } = useSDK()
  const [state, setState] = useState<DataState>({
    message: {},
    part: {},
    session_status: {},
    session_error: {},
    loaded: {},
    hidden: {},
  })
  const stateRef = useRef(state)
  stateRef.current = state
  const messageRequests = useRef<Record<string, number>>({})

  // 事件流（GET /event SSE；断连 3s 重连）
  useEffect(() => {
    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | undefined

    const subscribeOnce = bridge?.subscribe
    const connect = () => {
      if (disposed) return
      try {
        const handler = (event: EventLike) => {
          if (!disposed) setState((prev) => applyDataEvent(prev, event))
          const sid = event.properties.sessionID
          if (!disposed && typeof sid === "string" && event.type.startsWith("session.") && !/^session\.(reasoning|text)\./.test(event.type) && !refreshTimer) {
            refreshTimer = setTimeout(() => {
              refreshTimer = undefined
              if (!disposed) void loadMessages(sid, { force: true })
            }, 250)
          }
        }
        const reconnect = () => {
          if (!disposed) retryTimer = setTimeout(connect, 3000)
        }
        unsubscribe = subscribeOnce
          ? subscribeOnce(handler, reconnect)
          : subscribeEvents(handler, { directory: directory || undefined })
      } catch {
        retryTimer = setTimeout(connect, 3000)
      }
    }
    connect()

    return () => {
      disposed = true
      unsubscribe?.()
      if (retryTimer) clearTimeout(retryTimer)
      if (refreshTimer) clearTimeout(refreshTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, bridge])

  // 注意：不要把 state 放进 useMemo 依赖以外的闭包缓存（曾因 stale closure 导致时间线空白）
  const loadMessages = async (sessionID: string, opts?: { force?: boolean }) => {
    if (!opts?.force && stateRef.current.loaded[sessionID]) return
    const requestID = (messageRequests.current[sessionID] ?? 0) + 1
    messageRequests.current[sessionID] = requestID
    try {
      const items = bridge?.loadMessages
        ? await bridge.loadMessages(sessionID)
        : (((await sessionMessages(sessionID, { directory: directory || undefined })).data ?? []) as {
            message?: Message
            info?: Message
            parts?: Part[]
          }[])
      setState((prev) => {
        if (messageRequests.current[sessionID] !== requestID) return prev
        const existing = prev.message[sessionID] ?? []
        // 刚发送的乐观消息可能还没被服务端持久化：空结果不要覆盖本地，避免“消息闪一下消失”
        if (items.length === 0 && existing.length > 0) {
          return { ...prev, loaded: { ...prev.loaded, [sessionID]: true } }
        }
        const message = { ...prev.message }
        const part = { ...prev.part }
        const list: Message[] = []
        const hidden = { ...prev.hidden }
        const streamed = { ...prev.streamed }
        // 先识别全部隐藏消息（legacy shell 的系统编排），再过滤依赖它的 assistant 回复
        for (const item of items) {
          const msg = item.message ?? item.info
          if (msg?.id && item.parts?.some((p) => p.type === "text" && isLegacyShellText(p.text))) {
            hidden[msg.id] = true
          }
        }
        for (const item of items) {
          // REST 返回 {info, parts}；乐观路径用 {message, parts}
          const msg = item.message ?? item.info
          if (!msg?.id) continue
          // 平台编排（prepare 的 clone/切分支）不进入 chat 时间线
          if (isSystemMessage(msg) || hidden[msg.id]) continue
          list.push(msg)
          part[msg.id] = mergeStreamedParts(item.parts ?? [], streamed[msg.id] ?? [])
          const live = streamed[msg.id]
          if (live?.length && live.every((entry) => (entry.type === "text" || entry.type === "reasoning") && entry.time?.end !== undefined && item.parts?.some((saved) => saved.id === entry.id && (saved.type === "text" || saved.type === "reasoning") && saved.text === entry.text))) delete streamed[msg.id]
        }
        // 由隐藏消息触发的 assistant 回复同样隐藏
        // 新 step 可能尚未进入请求发起时的快照，保留仍有流式内容的消息。
        for (const entry of existing) if (streamed[entry.id]?.length && !list.some((item) => item.id === entry.id)) list.push(entry)
        message[sessionID] = list
          .filter((m) => !hidden[m.id] && !(m.role === "assistant" && hidden[m.parentID]))
          .sort(byMessageCreated)
        return { ...prev, message, part, hidden, streamed, loaded: { ...prev.loaded, [sessionID]: true } }
      })
    } catch {
      // 加载失败保持 loaded=false，下次重试
    }
  }

  const optimisticAdd: DataContextValue["optimisticAdd"] = (input) => {
    setState((prev) => {
      const messages = prev.message[input.sessionID] ?? []
      const next = [...messages, input.message].sort(byMessageCreated)
      return {
        ...prev,
        message: { ...prev.message, [input.sessionID]: next },
        part: { ...prev.part, [input.message.id]: input.parts },
        session_status: { ...prev.session_status, [input.sessionID]: { type: "busy" } },
      }
    })
  }

  const optimisticRemove: DataContextValue["optimisticRemove"] = (input) => {
    setState((prev) => {
      const messages = (prev.message[input.sessionID] ?? []).filter((m) => m.id !== input.messageID)
      const part = { ...prev.part }
      delete part[input.messageID]
      return {
        ...prev,
        message: { ...prev.message, [input.sessionID]: messages },
        part,
        session_status: { ...prev.session_status, [input.sessionID]: { type: "idle" } },
      }
    })
  }

  const setSessionStatus: DataContextValue["setSessionStatus"] = (sessionID, st) => {
    setState((prev) => ({
      ...prev,
      session_status: { ...prev.session_status, [sessionID]: st },
    }))
  }

  const value = useMemo<DataContextValue>(
    () => ({ state, loadMessages, optimisticAdd, optimisticRemove, setSessionStatus }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, directory],
  )

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error("useData must be used within DataProvider")
  return ctx
}
