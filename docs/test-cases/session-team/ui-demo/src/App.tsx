import { useEffect, useMemo, useRef, useState } from "react"
import {
  MessageSquare,
  Trash2,
  UserRound,
  Users,
} from "lucide-react"
import type { View, Agent, Message, QueuedMessage, ApiPart, ApiInfo, ApiMessage, ApiSession, Member, ModelRef, ModelOption, SessionEntry, QuestionRequest, PermissionRequest } from "./types"
import { initialMessages, initialMembers } from "./constants"
import { loadStored, loadAgents, isMessageFinished, isInfoFinished, parseTaskInfo, parseFileInfo, toolLabel, normalizeMessages, mergeMessages } from "./utils"
import { apiRequest } from "./api"
import { Conversation } from "./pages/Conversation"
import { Team } from "./pages/Team"
import { Members } from "./pages/Members"
import { subscribeEvents } from "./sse"

function App() {
  const [view, setView] = useState<View>("session")
  const [agents, setAgents] = useState(loadAgents)
  const [members, setMembers] = useState(() => loadStored<Member[]>("session-team-members", initialMembers))
  const [sessions, setSessions] = useState(() => loadStored<SessionEntry[]>("session-team-sessions", []))
  const [messages, setMessages] = useState(initialMessages)
  const [questions, setQuestions] = useState<QuestionRequest[]>([])
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [selectedAgent, setSelectedAgent] = useState("researcher")
  const [draft, setDraft] = useState("")
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [showAgentForm, setShowAgentForm] = useState(false)
  const [agentFormError, setAgentFormError] = useState<string | null>(null)
  const [showMemberForm, setShowMemberForm] = useState(false)
  const [running, setRunning] = useState(false)
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [runningAgent, setRunningAgent] = useState<string | null>(null)
  const runningAgentRef = useRef<string | null>(null)
  const messageIdRef = useRef(10000)

  function nextMessageId() {
    messageIdRef.current += 1
    return messageIdRef.current
  }

  function stopRunning() {
    setRunning(false)
    setRunningAgent(null)
    runningAgentRef.current = null
  }

  async function resyncRunning(id: string) {
    try {
      const status = await apiRequest<Record<string, { type?: string }>>("/session/status")
      const type = status[id]?.type
      if (type === "busy" || type === "retry") {
        setRunning(true)
        return
      }
      stopRunning()
    } catch {
      // 查询失败保持现状
    }
  }

  async function refreshQuestions(id: string) {
    try {
      const all = await apiRequest<QuestionRequest[]>("/question")
      setQuestions(all.filter((question) => question.sessionID === id))
    } catch {
      setQuestions([])
    }
  }

  async function refreshPermissions(id: string) {
    try {
      const all = await apiRequest<PermissionRequest[]>("/permission")
      setPermissions(all.filter((perm) => perm.sessionID === id))
    } catch {
      setPermissions([])
    }
  }
  const [sessionId, setSessionId] = useState(() => window.localStorage.getItem("session-team-demo-id") ?? "")
  const [model, setModel] = useState<ModelRef>(() =>
    loadStored<ModelRef>("session-team-model", { providerID: "zhipuai", modelID: "glm-5.1" }),
  )
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [sessionDirectory, setSessionDirectory] = useState("")
  const [eventConnected, setEventConnected] = useState(false)
  const eventConnectedRef = useRef(false)
  const [connection, setConnection] = useState<"connecting" | "connected" | "offline">("connecting")

  useEffect(() => {
    window.localStorage.setItem("session-team-agents", JSON.stringify(agents))
  }, [agents])

  useEffect(() => {
    window.localStorage.setItem("session-team-members", JSON.stringify(members))
  }, [members])

  useEffect(() => {
    window.localStorage.setItem("session-team-sessions", JSON.stringify(sessions))
  }, [sessions])

  useEffect(() => {
    if (!sessionId) return
    window.localStorage.setItem(`session-team-queue:${sessionId}`, JSON.stringify(queue))
  }, [queue, sessionId])

  useEffect(() => {
    window.localStorage.setItem("session-team-model", JSON.stringify(model))
  }, [model])

  useEffect(() => {
    apiRequest<{
      all: Array<{ id: string; name?: string; models: Record<string, { name?: string }> }>
      connected: string[]
    }>("/provider")
      .then((data) => {
        const options = data.all
          .filter((provider) => data.connected.includes(provider.id))
          .flatMap((provider) =>
            Object.entries(provider.models).map(([modelID, item]) => ({
              providerID: provider.id,
              modelID,
              providerName: provider.name ?? provider.id,
              modelName: item.name ?? modelID,
            })),
          )
        setModelOptions(options)
      })
      .catch(() => undefined)
  }, [])

  async function syncSessionAgents(id: string, list: Agent[]) {
    await apiRequest<Array<{ name: string }>>(`/session/${id}/agents`)
    await Promise.all(
      list.map((agent) =>
        apiRequest(`/session/${id}/agents/create`, {
          method: "POST",
          body: JSON.stringify({
            name: agent.name,
            mode: agent.mode,
            prompt: agent.tone,
            model: { providerID: agent.provider, modelID: agent.model },
            permission: {
              // 沙箱内执行无主机安全边界需求：兜底全量 allow，
              // 避免 ask 模式卡死（前端当前无权限审批 UI）及漏枚举工具
              "*": "allow",
            },
          }),
        }),
      ),
    )
  }

  useEffect(() => {
    let cancelled = false
    async function bootstrap() {
      try {
        const session = sessionId
          ? await apiRequest<ApiSession>(`/session/${sessionId}`)
          : await apiRequest<ApiSession>("/session", {
              method: "POST",
              body: JSON.stringify({
                title: `新会话 ${new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
              }),
            })
        if (cancelled) return
        const id = session.id
        setSessionId(id)
        setSessionDirectory(session.directory ?? "")
        window.localStorage.setItem("session-team-demo-id", id)
        setSessions((current) =>
          current.some((entry) => entry.id === id)
            ? current
            : [
                { id, title: session.title ?? "未命名会话", directory: session.directory, createdAt: Date.now() },
                ...current,
              ],
        )
        await syncSessionAgents(id, agents)
        const history = await apiRequest<ApiMessage[]>(`/session/${id}/message`)
        if (!cancelled) setMessages(normalizeMessages(history))
        await refreshQuestions(id)
        await refreshPermissions(id)
        // 刷新/切换恢复：持久化队列 + 服务端执行状态（显式设置，不沿用上个会话的状态）
        const storedQueue = loadStored<QueuedMessage[]>(`session-team-queue:${id}`, [])
        if (!cancelled) setQueue(storedQueue)
        try {
          const status = await apiRequest<Record<string, { type?: string }>>("/session/status")
          const type = status[id]?.type
          if (!cancelled && (type === "busy" || type === "retry")) {
            setRunning(true)
          } else if (!cancelled) {
            stopRunning()
            const [head, ...rest] = storedQueue
            if (head) {
              setQueue(rest)
              void dispatchQueued(head, Date.now(), () => {
                setMessages((current) => current.filter((message) => !message.pending))
              })
            }
          }
        } catch {
          // 状态查询失败不阻塞，保持默认 idle
          if (!cancelled) stopRunning()
        }
        setConnection("connected")
      } catch (error) {
        // 本地记住的会话已被删除：移除记录并触发新建
        if (!cancelled && sessionId && error instanceof Error && error.message.startsWith("4")) {
          setSessions((current) => current.filter((entry) => entry.id !== sessionId))
          window.localStorage.removeItem("session-team-demo-id")
          setSessionId("")
          return
        }
        if (!cancelled) setConnection("offline")
      }
    }
    bootstrap()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId || !sessionDirectory) return
    const partKinds = new Map<string, string>()
    const pendingDeltas = new Map<string, string>()
    const userMessageIds = new Set<string>()

    function updateAssistant(messageID: string, updater: (message: Message) => Message) {
      setMessages((current) => {
        const index = current.findIndex((message) => message.role === "assistant" && message.sourceId === messageID)
        if (index < 0)
          return [
            ...current,
            updater({
              id: nextMessageId(),
              sourceId: messageID,
              role: "assistant",
              agent: runningAgentRef.current ?? undefined,
              text: "",
              time: "now",
            }),
          ]
        return current.map((message, messageIndex) => (messageIndex === index ? updater(message) : message))
      })
    }

    function refetchMessages() {
      return apiRequest<ApiMessage[]>(`/session/${sessionId}/message`)
        .then((remoteMessages) => {
          for (const message of remoteMessages)
            if (message.info?.role === "user" && message.info.id) userMessageIds.add(message.info.id)
          const nextMessages = normalizeMessages(remoteMessages)
          if (nextMessages.length > 0) setMessages(nextMessages)
        })
        .catch(() => undefined)
    }

    const close = subscribeEvents(
      sessionDirectory,
      sessionId,
      (event) => handleEvent(event),
      () => {
        setEventConnected(false)
        eventConnectedRef.current = false
      },
    )
    return close

    function handleEvent(event: { type: string; properties: Record<string, unknown> }) {
      const props = event.properties
      const part = props.part as ApiPart | undefined
      const eventSessionID = props.sessionID as string | undefined
      if (event.type === "server.connected") {
        const reconnect = eventConnectedRef.current
        setEventConnected(true)
        eventConnectedRef.current = true
        // 断线重连后一次性校准 running（可能错过 busy/idle 事件）
        if (reconnect) void resyncRunning(sessionId)
        return
      }
      if (eventSessionID && eventSessionID !== sessionId) return

      if (
        event.type === "message.part.delta" &&
        props.messageID &&
        props.partID &&
        props.field === "text" &&
        props.delta
      ) {
        if (userMessageIds.has(props.messageID as string)) return
        const partID = props.partID as string
        const kind = partKinds.get(partID)
        if (!kind) {
          pendingDeltas.set(partID, `${pendingDeltas.get(partID) ?? ""}${props.delta as string}`)
          return
        }
        if (kind !== "reasoning" && kind !== "text") return
        updateAssistant(props.messageID as string, (message) =>
          kind === "reasoning"
            ? { ...message, reasoningPartId: partID, reasoning: `${message.reasoning ?? ""}${props.delta as string}` }
            : { ...message, sourcePartId: partID, text: message.text + (props.delta as string) },
        )
        return
      }

      if (event.type === "message.part.updated" && part?.id && part.messageID) {
        // 用户消息的 text part 也会触发 part.updated，不能为其创建 assistant 消息
        if (userMessageIds.has(part.messageID)) return
        const kind = part.type ?? "unknown"
        partKinds.set(part.id, kind)
        // 快照已包含此前所有 delta，丢弃缓冲区避免重复
        pendingDeltas.delete(part.id)
        if (kind === "reasoning" || kind === "text") {
          updateAssistant(part.messageID, (message) =>
            kind === "reasoning"
              ? { ...message, reasoningPartId: part.id, reasoning: part.text || message.reasoning }
              : { ...message, sourcePartId: part.id, text: part.text ?? message.text },
          )
          return
        }
        if (kind === "tool") {
          const label = toolLabel(part)
          const task = parseTaskInfo(part)
          const file = parseFileInfo(part)
          const partID = part.id
          setMessages((current) => {
            const index = current.findIndex((message) => message.role === "tool" && message.sourcePartId === partID)
            const displayText = task ? (task.description ?? label) : file ? file.filePath : label
            if (index >= 0)
              return current.map((message, messageIndex) =>
                messageIndex === index ? { ...message, text: displayText, task, file } : message,
              )
            return [
              ...current,
              {
                id: nextMessageId(),
                sourceId: part.messageID,
                sourcePartId: partID,
                role: "tool",
                agent: part.tool ?? "tool",
                text: displayText,
                task,
                file,
                time: "now",
              },
            ]
          })
        }
        return
      }

      if (event.type === "message.updated") {
        const info = props.info as ApiInfo | undefined
        if (!info?.id) return
        if (info.role === "user") {
          userMessageIds.add(info.id)
          return
        }
        if (info.role === "assistant") {
          const finished = isInfoFinished(info)
          updateAssistant(info.id, (message) => ({
            ...message,
            agent: info.agent ?? message.agent,
            finish: message.finish || finished,
          }))
          // 注意：单条消息 finish ≠ 会话空闲（Agent 可能继续下一轮），running 只由 session.idle / busy watcher 清除
        }
        return
      }

      if (event.type === "question.asked" || event.type === "question.replied" || event.type === "question.rejected") {
        void refreshQuestions(sessionId)
        return
      }

      if (event.type === "permission.asked" || event.type === "permission.resolved") {
        void refreshPermissions(sessionId)
        return
      }

      if (event.type === "session.error") {
        stopRunning()
        void refetchMessages()
        return
      }

      if (event.type === "session.status") {
        const type = (props.status as { type?: string } | undefined)?.type
        if (type === "busy" || type === "retry") {
          setRunning(true)
          return
        }
        if (type === "idle") {
          stopRunning()
          void refetchMessages()
        }
        return
      }

      if (event.type === "session.idle") {
        stopRunning()
        void refetchMessages()
      }
    }
  }, [sessionId, sessionDirectory])

  const primaryAgents = useMemo(() => agents.filter((agent) => agent.mode === "primary"), [agents])

  async function deleteSession(id: string) {
    setSessions((current) => current.filter((entry) => entry.id !== id))
    void apiRequest(`/session/${id}`, { method: "DELETE" }).catch(() => undefined)
    if (id !== sessionId) return
    const next = sessions.find((entry) => entry.id !== id)
    if (next) {
      selectSession(next.id)
      return
    }
    newSession()
  }

  async function autoTitleSession(id: string, text: string) {
    const entry = sessions.find((item) => item.id === id)
    if (!entry || entry.titled) return
    const title = text.replace(/@[a-zA-Z0-9_-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 20)
    if (!title) return
    setSessions((current) => current.map((item) => (item.id === id ? { ...item, title, titled: true } : item)))
    void apiRequest(`/session/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }).catch(() => undefined)
  }

  function sendMessage() {
    if (!draft.trim()) return
    const now = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    const text = draft.trim()
    const mentionedName = text.match(/(?:^|\s)@([a-zA-Z0-9_-]+)/)?.[1]
    const mentionedAgent = primaryAgents.find((agent) => agent.name === mentionedName)
    // 扣子语义：@ 才派发任务，不 @ 仅记录为项目背景
    const targetAgent = mentionedAgent?.name ?? null
    const messageId = Date.now()
    // Agent 运行中：不 @ 仅记录背景；@ 进入排队，当前任务完成后自动派发
    const queued = running && targetAgent !== null
    setMessages((current) => [...current, { id: messageId, role: "user", text, time: now, pending: queued }])
    setDraft("")
    void autoTitleSession(sessionId, text)
    if (queued) {
      setQueue((current) => [...current, { id: messageId, bubbleId: messageId, text, agent: targetAgent }])
      return
    }
    if (!targetAgent) {
      void sendToApi(text, messageId, null)
      return
    }
    setRunning(true)
    setRunningAgent(targetAgent)
    runningAgentRef.current = targetAgent
    setSelectedAgent(targetAgent)
    void sendToApi(text, messageId, targetAgent, () => {
      setMessages((current) => current.filter((message) => message.id !== messageId))
    })
  }

  async function dispatchQueued(item: QueuedMessage, optimisticId: number, onFailure: () => void, optimistic = false) {
    const now = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    setMessages((current) =>
      current.map((message) => (message.id === item.bubbleId ? { ...message, pending: false } : message)),
    )
    if (optimistic) {
      setMessages((current) => [...current, { id: optimisticId, role: "user", text: item.text, time: now }])
    }
    setRunning(true)
    setRunningAgent(item.agent)
    runningAgentRef.current = item.agent
    setSelectedAgent(item.agent)
    await sendToApi(item.text, optimisticId, item.agent, onFailure)
  }

  async function sendToApi(text: string, optimisticId: number, targetAgent: string | null, onFailure?: () => void) {
    try {
      if (!sessionId) throw new Error("Session 尚未创建")
      const path = targetAgent ? `/session/${sessionId}/prompt_async` : `/session/${sessionId}/message`
      await apiRequest(path, {
        method: "POST",
        body: JSON.stringify({
          parts: [{ type: "text", text }],
          ...(targetAgent ? { agent: targetAgent, model: { providerID: model.providerID, modelID: model.modelID } } : { noReply: true }),
        }),
      })
      if (!targetAgent) return
      if (!eventConnectedRef.current) await pollMessages(sessionId, optimisticId, text)
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: Date.now(),
          role: "tool",
          agent: "system",
          text: `API error · ${error instanceof Error ? error.message : "请求失败"}`,
          time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
        },
      ])
      setConnection("offline")
      setRunning(false)
      setRunningAgent(null)
      runningAgentRef.current = null
      onFailure?.()
    }
  }

  async function stopMessage() {
    if (!sessionId) return
    try {
      await apiRequest(`/session/${sessionId}/abort`, { method: "POST" })
    } finally {
      setRunning(false)
      setRunningAgent(null)
      runningAgentRef.current = null
    }
  }

  function newSession() {
    window.localStorage.removeItem("session-team-demo-id")
    setSessionId("")
    setSessionDirectory("")
    setMessages([])
    setQueue([])
    setConnection("connecting")
    setView("session")
  }

  function selectSession(id: string) {
    if (id === sessionId) return
    window.localStorage.setItem("session-team-demo-id", id)
    setMessages([])
    setQuestions([])
    setQueue([])
    stopRunning()
    setConnection("connecting")
    setSessionId(id)
    setView("session")
  }

  useEffect(() => {
    if (!sessionId || connection !== "connected") return
    void syncSessionAgents(sessionId, agents).catch(() => undefined)
  }, [agents, sessionId, connection])

  // running 转 idle 后自动派发队首
  useEffect(() => {
    if (running || queue.length === 0) return
    const [head, ...rest] = queue
    setQueue(rest)
    void dispatchQueued(head, Date.now(), () => {
      setMessages((current) => current.filter((message) => message.id !== head.bubbleId))
    }, messages.length === 0)
  }, [running, queue])

  async function pollMessages(id: string, optimisticId: number, text: string) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const remoteMessages = await apiRequest<ApiMessage[]>(`/session/${id}/message`)
      const nextMessages = normalizeMessages(remoteMessages)
      if (nextMessages.length > 0) setMessages((current) => mergeMessages(current, nextMessages, optimisticId))
      const userIndex = remoteMessages.reduce(
        (last, message, index) =>
          message.info?.role === "user" &&
          (message.parts ?? []).some((part) => part.type === "text" && part.text === text)
            ? index
            : last,
        -1,
      )
      const finished =
        userIndex >= 0 &&
        remoteMessages
          .slice(userIndex + 1)
          .some((message) => message.info?.role === "assistant" && isMessageFinished(message.info.finish))
      if (finished) {
        setRunning(false)
        setRunningAgent(null)
        runningAgentRef.current = null
        return
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000))
    }
    throw new Error("等待 Agent 回复超时")
  }

  function updateDraft(value: string) {
    setDraft(value)
    const match = value.match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/)
    setMentionQuery(match ? match[1].toLowerCase() : null)
  }

  function selectMention(name: string) {
    const nextDraft = draft.replace(
      /(?:^|\s)@[a-zA-Z0-9_-]*$/,
      (match) => `${match.slice(0, -match.trim().length)}@${name} `,
    )
    setDraft(nextDraft)
    if (agents.some((agent) => agent.name === name)) setSelectedAgent(name)
    setMentionQuery(null)
  }

  function addAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get("name") || "")
      .trim()
      .toLowerCase()
      .replaceAll(" ", "-")
    if (agents.some((agent) => agent.name === name)) {
      setAgentFormError(`已存在同名 Agent：${name}`)
      return
    }
    const mode = form.get("mode") === "primary" ? "primary" : "subagent"
    setAgents((current) => [
      ...current,
      {
        name,
        label: String(form.get("label") || "新 Agent"),
        mode,
        provider: "zhipuai",
        model: "glm-5.1",
        tone: String(form.get("prompt") || "").trim(),
        permissions: ["read", "edit", "write", "bash", "task", "question", "glob", "grep", "ls"],
        status: "ready",
      },
    ])
    setAgentFormError(null)
    setShowAgentForm(false)
  }

  function addMember(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get("name") || "new-member")
      .trim()
      .toLowerCase()
      .replaceAll(" ", "-")
    setMembers((current) => [
      ...current,
      {
        name,
        label: String(form.get("label") || "新成员"),
        title: String(form.get("title") || "成员"),
      },
    ])
    setShowMemberForm(false)
  }

  return (
    <div className="app-shell h-screen w-full overflow-hidden">
      <aside className="sidebar h-full overflow-y-auto">
        <div className="brand-lockup">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">session team</div>
            <div className="brand-caption">test console / 0.1</div>
          </div>
        </div>
        <div className="sidebar-label">MENU</div>
        <div className="session-list">
          <button
            className={`session-row ${view === "session" ? "active" : ""}`}
            type="button"
            onClick={() => setView("session")}
          >
            <MessageSquare size={15} className="menu-icon" />
            <span className="session-copy">
              <strong>会话</strong>
              <small>Session 工作台</small>
            </span>
          </button>
          <button
            className={`session-row ${view === "team" ? "active" : ""}`}
            type="button"
            onClick={() => setView("team")}
          >
            <Users size={15} className="menu-icon" />
            <span className="session-copy">
              <strong>Agent 团队</strong>
              <small>全局 Agent 管理</small>
            </span>
          </button>
          <button
            className={`session-row ${view === "members" ? "active" : ""}`}
            type="button"
            onClick={() => setView("members")}
          >
            <UserRound size={15} className="menu-icon" />
            <span className="session-copy">
              <strong>成员管理</strong>
              <small>全局成员管理</small>
            </span>
          </button>
        </div>
        <div className="sidebar-label">
          WORKSPACES <span>{String(sessions.length).padStart(2, "0")}</span>
        </div>
        <div className="session-list">
          {sessions.map((entry) => (
            <div
              className={`session-row group ${entry.id === sessionId && view === "session" ? "active" : ""}`}
              role="button"
              tabIndex={0}
              key={entry.id}
              onClick={() => selectSession(entry.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") selectSession(entry.id)
              }}
            >
              <span className={`session-dot ${entry.id === sessionId ? "live" : ""}`} />
              <span className="session-copy">
                <strong>{entry.title}</strong>
                <small>{entry.id.slice(0, 12)}</small>
              </span>
              <span
                className="session-delete"
                role="button"
                title="删除会话"
                onClick={(event) => {
                  event.stopPropagation()
                  void deleteSession(entry.id)
                }}
              >
                <Trash2 size={13} />
              </span>
            </div>
          ))}
        </div>
        <button className="new-session" type="button" onClick={newSession}>
          <span>+</span> 新建 Session
        </button>
        <div className="sidebar-bottom">
          <div className="service-status">
            <span className="pulse" /> API connected <code>14096</code>
          </div>
          <div className="service-status">
            <span className="pulse green" /> PostgreSQL <code>15432</code>
          </div>
        </div>
      </aside>

      <main className="workspace flex h-full min-h-0 flex-col overflow-hidden">
        <header className="topbar shrink-0">
          <div className="breadcrumbs">
            <span>WORKSPACES</span>
            <b>/</b>
            <strong>新品发布方案</strong>
            <i>session_7f2c</i>
          </div>
          <div className="top-actions">
            <span className="env-badge">
              <span className={`pulse ${connection === "connected" ? "green" : ""}`} />{" "}
              {connection === "connected"
                ? "API CONNECTED"
                : connection === "connecting"
                  ? "CONNECTING"
                  : "API OFFLINE"}
            </span>
            <button className="icon-button" type="button">
              ···
            </button>
            <div className="avatar">R</div>
          </div>
        </header>

        <div className="content-wrap flex min-h-0 w-full flex-1 flex-col overflow-hidden">
          {view === "team" && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Team
                agents={agents}
                setShowAgentForm={setShowAgentForm}
                onRemove={(name) => setAgents((current) => current.filter((agent) => agent.name !== name))}
              />
            </div>
          )}
          {view === "members" && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Members
                members={members}
                setShowMemberForm={setShowMemberForm}
                onRemove={(name) => setMembers((current) => current.filter((member) => member.name !== name))}
              />
            </div>
          )}
          {view === "session" && (
            <Conversation
              messages={messages}
              sessionId={sessionId}
              selectedAgent={selectedAgent}
              runningAgent={runningAgent}
              primaryAgents={primaryAgents}
              members={members}
              draft={draft}
              updateDraft={updateDraft}
              mentionQuery={mentionQuery}
              selectMention={selectMention}
              sendMessage={sendMessage}
              stopMessage={stopMessage}
              running={running}
              questions={questions}
              onAnswered={() => sessionId && void refreshQuestions(sessionId)}
              permissions={permissions}
              onPermissionResolved={() => sessionId && void refreshPermissions(sessionId)}
              model={model}
              modelOptions={modelOptions}
              onModelChange={setModel}
              queue={queue}
              onCancelQueued={(id) => {
                setQueue((current) => current.filter((item) => item.id !== id))
                setMessages((current) => current.filter((message) => message.id !== id))
              }}
            />
          )}
        </div>
      </main>

      {showAgentForm && (
        <div className="modal-backdrop" onClick={() => setShowAgentForm(false)}>
          <form className="modal" onSubmit={addAgent} onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="eyebrow">GLOBAL AGENT</div>
                <h2>添加 Agent</h2>
              </div>
              <button type="button" className="close-button" onClick={() => setShowAgentForm(false)}>
                ×
              </button>
            </div>
            <label>
              Agent 标识（用于 @ 提及，英文小写）
              <input name="name" placeholder="例如 analyst" pattern="[a-z0-9_-]+" required />
            </label>
            <label>
              显示名称
              <input name="label" placeholder="例如 数据分析师" required />
            </label>
            <label>
              职责 Prompt（Agent 的系统指令，决定它做什么、怎么做）
              <textarea
                name="prompt"
                className="w-full resize-y rounded-lg border border-[#dde4ec] p-2.5 text-xs leading-relaxed outline-none focus:border-[#3159ef]"
                placeholder="例如：负责把调研资料整理成结构化摘要，输出时标注信息来源，不确定的内容要明确说明。"
                rows={4}
                required
              />
            </label>
            <label>
              模式
              <select name="mode" defaultValue="primary">
                <option value="primary">primary · 用户可直接 @ 调度</option>
                <option value="subagent">subagent · 仅由 primary 通过 task 调度</option>
              </select>
            </label>
            {agentFormError && <p className="mt-1 text-[11px] text-[#c4544a]">{agentFormError}</p>}
            <button className="submit-button" type="submit">
              创建 Agent
            </button>
          </form>
        </div>
      )}

      {showMemberForm && (
        <div className="modal-backdrop" onClick={() => setShowMemberForm(false)}>
          <form className="modal" onSubmit={addMember} onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="eyebrow">GLOBAL MEMBER</div>
                <h2>添加成员</h2>
              </div>
              <button type="button" className="close-button" onClick={() => setShowMemberForm(false)}>
                ×
              </button>
            </div>
            <label>
              成员标识（用于 @ 提及）
              <input name="name" placeholder="例如 pm-li" required />
            </label>
            <label>
              姓名
              <input name="label" placeholder="例如 李然" required />
            </label>
            <label>
              角色
              <input name="title" placeholder="例如 产品经理" required />
            </label>
            <button className="submit-button" type="submit">
              添加成员
            </button>
          </form>
        </div>
      )}
    </div>
  )
}

export default App
