import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronDown, HelpCircle, Sparkles, X } from "lucide-react"
import { Streamdown } from "streamdown"
import { subscribeEvents } from "./sse"

type AgentMode = "primary" | "subagent"
type Tab = "conversation" | "team" | "verification"

type Agent = {
  name: string
  label: string
  mode: AgentMode
  provider: string
  model: string
  tone: string
  permissions: string[]
  status: "ready" | "running"
}

type Message = {
  id: number
  sourceId?: string
  sourcePartId?: string
  reasoningPartId?: string
  role: "user" | "assistant" | "tool"
  agent?: string
  text: string
  reasoning?: string
  time: string
  finish?: boolean
}

type ApiPart = {
  id?: string
  messageID?: string
  type?: string
  text?: string
  tool?: string
  state?: { status?: string; error?: string }
}

type ApiInfo = {
  id?: string
  role?: string
  agent?: string
  finish?: string | boolean
  error?: { name?: string; data?: { message?: string } }
  time?: { created?: number; completed?: number }
}

type ApiMessage = {
  info?: ApiInfo
  parts?: ApiPart[]
}

type StreamEvent = {
  type?: string
  properties?: {
    sessionID?: string
    messageID?: string
    partID?: string
    field?: string
    delta?: string
    status?: { type?: string }
  }
}

type ApiSession = { id: string; directory?: string }

type QuestionOption = { label: string; description?: string }

type QuestionInfo = {
  question: string
  header?: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

type QuestionRequest = {
  id: string
  sessionID: string
  questions: QuestionInfo[]
}

const initialAgents: Agent[] = [
  {
    name: "manager",
    label: "项目经理",
    mode: "primary",
    provider: "zhipuai",
    model: "glm-5.1",
    tone: "负责拆解目标、分配任务和汇总交付物。对于方案讨论和规划问题直接回复，不要调用 read、glob、bash 或 task；只有用户明确要求执行代码或调度成员时才使用工具。",
    permissions: ["read", "edit", "bash", "task"],
    status: "ready",
  },
  {
    name: "researcher",
    label: "资料整理员",
    mode: "primary",
    provider: "zhipuai",
    model: "glm-5.1",
    tone: "整理可靠资料，需要时调度 source-finder。",
    permissions: ["read", "task"],
    status: "ready",
  },
  {
    name: "writer",
    label: "内容撰稿人",
    mode: "subagent",
    provider: "zhipuai",
    model: "glm-5.1",
    tone: "将资料组织为清晰、有说服力的内容。",
    permissions: ["read", "edit"],
    status: "ready",
  },
  {
    name: "source-finder",
    label: "资料来源检索员",
    mode: "subagent",
    provider: "zhipuai",
    model: "glm-5.1",
    tone: "只由 primary 调度，返回结构化检索结果。",
    permissions: ["read"],
    status: "ready",
  },
]

const initialMessages: Message[] = [
  { id: 1, role: "user", text: "准备新品发布方案，先整理 React 19 的关键资料。", time: "10:24" },
  {
    id: 2,
    role: "assistant",
    agent: "researcher",
    text: "我会先拆解资料搜集任务，再把结果整理成可引用的摘要。",
    time: "10:24",
    finish: true,
  },
  { id: 3, role: "tool", agent: "source-finder", text: "task · 已创建子会话并返回 3 个来源", time: "10:25" },
  {
    id: 4,
    role: "assistant",
    agent: "researcher",
    text: "资料已整理完成：React 19 的 Actions、useOptimistic 和 Server Components 是本次方案的重点。",
    time: "10:26",
    finish: true,
  },
]

const checks = [
  { id: "ST.3.2", title: "不指定 Agent + noReply", detail: "仅记录用户消息，不触发默认 Agent", state: "pass" },
  { id: "ST.3.4", title: "@researcher 回复", detail: "assistant.info.agent = researcher", state: "pass" },
  { id: "ST.3.11", title: "primary 调度 subagent", detail: "发现 task 工具调用", state: "pass" },
  { id: "ST.3.12", title: "创建子会话", detail: "source-finder / parent relation", state: "pass" },
  { id: "ST.3.14", title: "PG 持久化父子关系", detail: "session_agents + parent_id", state: "pending" },
]

async function apiRequest<T>(path: string, init?: RequestInit) {
  const response = await fetch(`/opencode${path}`, {
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    ...init,
  })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function isMessageFinished(value: string | boolean | undefined) {
  return value === true || value === "stop" || value === "error" || value === "abort" || value === "completed"
}

function isInfoFinished(info: ApiInfo | undefined) {
  if (!info) return false
  return isMessageFinished(info.finish) || Boolean(info.error) || Boolean(info.time?.completed)
}

function normalizeMessages(messages: ApiMessage[]): Message[] {
  return messages.flatMap<Message>((message, index) => {
    const info = message.info ?? {}
    const textParts = (message.parts ?? []).filter((part) => part.type === "text" && part.text)
    const reasoningParts = (message.parts ?? []).filter((part) => part.type === "reasoning" && part.text)
    const tool = (message.parts ?? []).find((part) => part.type === "tool")
    const result: Message[] = []
    if ((textParts.length > 0 || reasoningParts.length > 0) && ["user", "assistant"].includes(info.role ?? ""))
      result.push({
        id: index + 1,
        sourceId: info.id,
        sourcePartId: textParts[0]?.id,
        reasoningPartId: reasoningParts[0]?.id,
        role: info.role as "user" | "assistant",
        agent: info.agent,
        text: textParts.map((part) => part.text).join("\n"),
        reasoning: reasoningParts.map((part) => part.text).join("\n") || undefined,
        time: "now",
        finish: isInfoFinished(info),
      })
    if (tool)
      result.push({
        id: index + 1 + 100000,
        sourceId: info.id,
        role: "tool",
        agent: info.agent ?? tool.tool ?? "task",
        text: `${tool.tool ?? "tool"} · ${tool.state?.status ?? "running"}${tool.state?.error ? ` · ${tool.state.error}` : ""}`,
        time: "now",
      })
    return result
  })
}

function mergeMessages(current: Message[], remote: Message[], optimisticId: number) {
  const optimistic = current.find((message) => message.id === optimisticId)
  return optimistic && remote.every((message) => message.text !== optimistic.text) ? [optimistic, ...remote] : remote
}

function App() {
  const [tab, setTab] = useState<Tab>("conversation")
  const [agents, setAgents] = useState(initialAgents)
  const [messages, setMessages] = useState(initialMessages)
  const [questions, setQuestions] = useState<QuestionRequest[]>([])
  const [selectedAgent, setSelectedAgent] = useState("researcher")
  const [noReply, setNoReply] = useState(false)
  const [draft, setDraft] = useState("")
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [showAgentForm, setShowAgentForm] = useState(false)
  const [running, setRunning] = useState(false)
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

  async function refreshQuestions(id: string) {
    try {
      const all = await apiRequest<QuestionRequest[]>("/question")
      setQuestions(all.filter((question) => question.sessionID === id))
    } catch {
      setQuestions([])
    }
  }
  const [sessionId, setSessionId] = useState(() => window.localStorage.getItem("session-team-demo-id") ?? "")
  const [sessionDirectory, setSessionDirectory] = useState("")
  const [eventConnected, setEventConnected] = useState(false)
  const eventConnectedRef = useRef(false)
  const [connection, setConnection] = useState<"connecting" | "connected" | "offline">("connecting")

  useEffect(() => {
    let cancelled = false
    async function bootstrap() {
      try {
        const session = sessionId
          ? await apiRequest<ApiSession>(`/session/${sessionId}`)
          : await apiRequest<ApiSession>("/session", {
              method: "POST",
              body: JSON.stringify({ title: "新品发布方案" }),
            })
        if (cancelled) return
        const id = session.id
        setSessionId(id)
        setSessionDirectory(session.directory ?? "")
        window.localStorage.setItem("session-team-demo-id", id)
        const remoteAgents = await apiRequest<Array<{ name: string }>>(`/session/${id}/agents`)
        await Promise.all(
          initialAgents
            .filter((agent) => !remoteAgents.some((remote) => remote.name === agent.name))
            .map((agent) =>
              apiRequest(`/session/${id}/agents/create`, {
                method: "POST",
                body: JSON.stringify({
                  name: agent.name,
                  mode: agent.mode,
                  prompt: agent.tone,
                  model: { providerID: agent.provider, modelID: agent.model },
                  permission: Object.fromEntries(agent.permissions.map((permission) => [permission, "allow"])),
                }),
              }),
            ),
        )
        const history = await apiRequest<ApiMessage[]>(`/session/${id}/message`)
        const loadedMessages = normalizeMessages(history)
        if (loadedMessages.length > 0) setMessages(loadedMessages)
        await refreshQuestions(id)
        setConnection("connected")
      } catch {
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
          setEventConnected(true)
          eventConnectedRef.current = true
          return
        }
        if (eventSessionID && eventSessionID !== sessionId) return

        if (event.type === "message.part.delta" && props.messageID && props.partID && props.field === "text" && props.delta) {
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
            const label = `${part.tool ?? "tool"} · ${part.state?.status ?? "running"}${part.state?.error ? ` · ${part.state.error}` : ""}`
            const partID = part.id
            setMessages((current) => {
              const index = current.findIndex((message) => message.role === "tool" && message.sourcePartId === partID)
              if (index >= 0)
                return current.map((message, messageIndex) =>
                  messageIndex === index ? { ...message, text: label } : message,
                )
              return [
                ...current,
                {
                  id: nextMessageId(),
                  sourceId: part.messageID,
                  sourcePartId: partID,
                  role: "tool",
                  agent: part.tool ?? "tool",
                  text: label,
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
            if (finished) stopRunning()
          }
          return
        }

        if (
          event.type === "question.asked" ||
          event.type === "question.replied" ||
          event.type === "question.rejected"
        ) {
          void refreshQuestions(sessionId)
          return
        }

        if (event.type === "session.error") {
          stopRunning()
          void refetchMessages()
          return
        }

        if (
          event.type === "session.idle" ||
          (event.type === "session.status" && (props.status as { type?: string } | undefined)?.type === "idle")
        ) {
          stopRunning()
          void refetchMessages()
        }
    }
  }, [sessionId, sessionDirectory])

  const primaryAgents = useMemo(() => agents.filter((agent) => agent.mode === "primary"), [agents])
  const sessionStats = [
    { label: "Agents", value: agents.length, accent: "text-cyan-300" },
    { label: "Messages", value: messages.filter((message) => message.role !== "tool").length, accent: "text-lime-300" },
    { label: "Children", value: 1, accent: "text-amber-300" },
    { label: "Checks", value: "4/5", accent: "text-violet-300" },
  ]

  function sendMessage() {
    if (!draft.trim() || running) return
    const now = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    const text = draft.trim()
    const mentionedName = text.match(/(?:^|\s)@([a-zA-Z0-9_-]+)/)?.[1]
    const mentionedAgent = primaryAgents.find((agent) => agent.name === mentionedName)
    const targetAgent = mentionedAgent?.name ?? selectedAgent
    const messageId = Date.now()
    setMessages((current) => [...current, { id: messageId, role: "user", text, time: now }])
    setDraft("")
    setRunning(true)
    setRunningAgent(targetAgent)
    runningAgentRef.current = targetAgent
    setSelectedAgent(targetAgent)
    void sendToApi(text, messageId, targetAgent)
  }

  async function sendToApi(text: string, optimisticId: number, targetAgent: string) {
    try {
      if (!sessionId) throw new Error("Session 尚未创建")
      const path = noReply ? `/session/${sessionId}/message` : `/session/${sessionId}/prompt_async`
      await apiRequest(path, {
        method: "POST",
        body: JSON.stringify({
          parts: [{ type: "text", text }],
          ...(noReply
            ? { noReply: true }
            : { agent: targetAgent, model: { providerID: "zhipuai", modelID: "glm-5.1" } }),
        }),
      })
      if (noReply) {
        setRunning(false)
        setRunningAgent(null)
        runningAgentRef.current = null
        return
      }
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
    setMessages(initialMessages)
    setConnection("connecting")
  }

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

  function selectMention(agent: Agent) {
    const nextDraft = draft.replace(
      /(?:^|\s)@[a-zA-Z0-9_-]*$/,
      (match) => `${match.slice(0, -match.trim().length)}@${agent.name} `,
    )
    setDraft(nextDraft)
    setSelectedAgent(agent.name)
    setMentionQuery(null)
  }

  function addAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get("name") || "new-agent")
      .trim()
      .toLowerCase()
      .replaceAll(" ", "-")
    const mode = form.get("mode") === "primary" ? "primary" : "subagent"
    setAgents((current) => [
      ...current,
      {
        name,
        label: String(form.get("label") || "新 Agent"),
        mode,
        provider: "zhipuai",
        model: "glm-5.1",
        tone: "新建的 Session Agent，等待配置工作职责。",
        permissions: mode === "primary" ? ["read", "task"] : ["read"],
        status: "ready",
      },
    ])
    setShowAgentForm(false)
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">session team</div>
            <div className="brand-caption">test console / 0.1</div>
          </div>
        </div>
        <div className="sidebar-label">
          WORKSPACES <span>03</span>
        </div>
        <div className="session-list">
          <button className="session-row active" type="button">
            <span className="session-dot live" />
            <span className="session-copy">
              <strong>新品发布方案</strong>
              <small>多主 Agent 分工测试</small>
            </span>
            <span className="session-count">12</span>
          </button>
          <button className="session-row" type="button">
            <span className="session-dot" />
            <span className="session-copy">
              <strong>行业专家矩阵</strong>
              <small>法务 / 运营 / 数据</small>
            </span>
            <span className="session-count">08</span>
          </button>
          <button className="session-row" type="button">
            <span className="session-dot" />
            <span className="session-copy">
              <strong>云端与本地</strong>
              <small>多模型统一托管</small>
            </span>
            <span className="session-count">06</span>
          </button>
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

      <main className="workspace">
        <header className="topbar">
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

        <div className="content-wrap">
          <section className="hero-row">
            <div>
              <div className="eyebrow">SESSION / TEAM LAB</div>
              <h1>新品发布方案</h1>
              <p>验证多主 Agent 分工、子会话调度与上下文持久化。</p>
            </div>
            <button className="run-button" type="button" onClick={() => setTab("verification")}>
              <span>▶</span> Run checks <kbd>⌘ ↵</kbd>
            </button>
          </section>

          <section className="stat-grid">
            {sessionStats.map((stat) => (
              <div className="stat-card" key={stat.label}>
                <span>{stat.label}</span>
                <strong className={stat.accent}>{stat.value}</strong>
                <small>{stat.label === "Checks" ? "last run 2m ago" : "in this session"}</small>
              </div>
            ))}
          </section>

          <nav className="tabs" aria-label="Session sections">
            {(["conversation", "team", "verification"] as Tab[]).map((item) => (
              <button
                key={item}
                type="button"
                className={tab === item ? "tab active" : "tab"}
                onClick={() => setTab(item)}
              >
                {item === "conversation" ? "对话现场" : item === "team" ? "Agent 团队" : "测试验证"}
                {item === "verification" && <span className="tab-alert">1</span>}
              </button>
            ))}
          </nav>

          {tab === "conversation" && (
            <Conversation
              messages={messages}
              selectedAgent={selectedAgent}
              runningAgent={runningAgent}
              setSelectedAgent={setSelectedAgent}
              primaryAgents={primaryAgents}
              noReply={noReply}
              setNoReply={setNoReply}
              draft={draft}
              updateDraft={updateDraft}
              mentionQuery={mentionQuery}
              selectMention={selectMention}
              sendMessage={sendMessage}
              stopMessage={stopMessage}
              running={running}
              questions={questions}
              onAnswered={() => sessionId && void refreshQuestions(sessionId)}
            />
          )}
          {tab === "team" && <Team agents={agents} setShowAgentForm={setShowAgentForm} />}
          {tab === "verification" && <Verification />}
        </div>
      </main>

      {showAgentForm && (
        <div className="modal-backdrop" onClick={() => setShowAgentForm(false)}>
          <form className="modal" onSubmit={addAgent} onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="eyebrow">SESSION AGENT</div>
                <h2>添加团队成员</h2>
              </div>
              <button type="button" className="close-button" onClick={() => setShowAgentForm(false)}>
                ×
              </button>
            </div>
            <label>
              Agent name
              <input name="name" placeholder="例如 analyst" required />
            </label>
            <label>
              显示名称
              <input name="label" placeholder="例如 数据分析师" required />
            </label>
            <label>
              模式
              <select name="mode" defaultValue="subagent">
                <option value="primary">primary · 用户可直接调度</option>
                <option value="subagent">subagent · 仅由 primary 调度</option>
              </select>
            </label>
            <button className="submit-button" type="submit">
              创建 Agent
            </button>
          </form>
        </div>
      )}
    </div>
  )
}

function ReasoningBlock({ reasoning, finished }: { reasoning: string; finished?: boolean }) {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (finished) setOpen(false)
  }, [finished])
  return (
    <details className={`reasoning-block ${open ? "open" : ""}`} open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault()
          setOpen((current) => !current)
        }}
      >
        <Sparkles size={15} className="reasoning-mark" />
        <span>{finished ? "已思考" : "思考中"}</span>
        <ChevronDown size={12} className="reasoning-chevron" />
      </summary>
      <div className="reasoning-content">{reasoning}</div>
    </details>
  )
}

function QuestionCard({ request, onAnswered }: { request: QuestionRequest; onAnswered: () => void }) {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []))
  const [customText, setCustomText] = useState<string[]>(() => request.questions.map(() => ""))
  const [submitting, setSubmitting] = useState(false)

  const toggle = (questionIndex: number, label: string) => {
    setAnswers((current) =>
      current.map((answer, index) => {
        if (index !== questionIndex) return answer
        if (request.questions[questionIndex].multiple)
          return answer.includes(label) ? answer.filter((item) => item !== label) : [...answer, label]
        return [label]
      }),
    )
  }

  const canSubmit = request.questions.every(
    (question, index) => answers[index].length > 0 || (question.custom !== false && customText[index].trim()),
  )

  async function submit() {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    try {
      await apiRequest(`/question/${request.id}/reply`, {
        method: "POST",
        body: JSON.stringify({
          answers: request.questions.map((_, index) =>
            answers[index].length > 0 ? answers[index] : [customText[index].trim()],
          ),
        }),
      })
      onAnswered()
    } finally {
      setSubmitting(false)
    }
  }

  async function reject() {
    if (submitting) return
    setSubmitting(true)
    try {
      await apiRequest(`/question/${request.id}/reject`, { method: "POST" })
      onAnswered()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4">
      <div className="flex items-center gap-2 pb-2">
        <HelpCircle size={16} className="text-amber-500" />
        <span className="text-sm font-semibold text-gray-800">AI 在问你</span>
      </div>
      <div className="space-y-4">
        {request.questions.map((question, questionIndex) => (
          <div key={questionIndex}>
            <p className="text-sm font-medium text-gray-800">{question.question}</p>
            {question.header && <p className="mt-0.5 text-xs text-gray-400">{question.header}</p>}
            <div className="mt-2 space-y-1.5">
              {question.options.map((option) => {
                const active = answers[questionIndex].includes(option.label)
                return (
                  <button
                    type="button"
                    key={option.label}
                    onClick={() => toggle(questionIndex, option.label)}
                    className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors ${
                      active ? "border-blue-400 bg-blue-50" : "border-gray-200 bg-white hover:border-gray-300"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                        active ? "border-blue-500 bg-blue-500" : "border-gray-300"
                      }`}
                    >
                      {active && <Check size={12} className="text-white" />}
                    </span>
                    <span>
                      <span className={`block text-sm ${active ? "text-blue-700" : "text-gray-700"}`}>
                        {option.label}
                      </span>
                      {option.description && <span className="block text-xs text-gray-400">{option.description}</span>}
                    </span>
                  </button>
                )
              })}
              {question.custom !== false && (
                <input
                  value={customText[questionIndex]}
                  onChange={(event) =>
                    setCustomText((current) =>
                      current.map((text, index) => (index === questionIndex ? event.target.value : text)),
                    )
                  }
                  placeholder="或输入自定义回答..."
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400"
                />
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={reject}
          disabled={submitting}
          className="flex items-center gap-1 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-50"
        >
          <X size={14} />
          跳过
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit || submitting}
          className="rounded-xl bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {submitting ? "提交中..." : "确认"}
        </button>
      </div>
    </div>
  )
}

function Conversation(props: {
  messages: Message[]
  selectedAgent: string
  runningAgent: string | null
  setSelectedAgent: (value: string) => void
  primaryAgents: Agent[]
  noReply: boolean
  setNoReply: (value: boolean) => void
  draft: string
  updateDraft: (value: string) => void
  mentionQuery: string | null
  selectMention: (agent: Agent) => void
  sendMessage: () => void
  stopMessage: () => void
  running: boolean
  questions: QuestionRequest[]
  onAnswered: () => void
}) {
  const mentionAgents = props.primaryAgents.filter((agent) => agent.name.includes(props.mentionQuery ?? ""))
  const lastMessage = props.messages[props.messages.length - 1]
  const streamingContent =
    lastMessage?.role === "assistant" && !lastMessage.finish && Boolean(lastMessage.reasoning || lastMessage.text)
  const showThinking = props.running && !streamingContent && props.questions.length === 0
  return (
    <div className="conversation-layout">
      <section className="panel conversation-panel">
        <div className="panel-heading">
          <div>
            <span className="panel-kicker">LIVE TRANSCRIPT</span>
            <h2>对话现场</h2>
          </div>
          <span className="live-label">
            <span className="pulse" /> streaming
          </span>
        </div>
        <div className="message-list">
          {props.messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="message-meta">
                <span className={`role-dot ${message.role}`} />
                {message.role === "user" ? "YOU" : message.role === "tool" ? `TOOL / ${message.agent}` : message.agent}
                <time>{message.time}</time>
                {message.role === "assistant" && message.finish && <em>finished</em>}
              </div>
              <div className="message-body">
                {message.role === "assistant" ? (
                  <>
                    {message.reasoning && <ReasoningBlock reasoning={message.reasoning} finished={message.finish} />}
                    {message.text && (
                      <div className="markdown-content">
                        <Streamdown animated={!message.finish}>{message.text}</Streamdown>
                      </div>
                    )}
                  </>
                ) : (
                  message.text
                )}
              </div>
            </article>
          ))}
          {props.questions.map((question) => (
            <QuestionCard key={question.id} request={question} onAnswered={props.onAnswered} />
          ))}
          {showThinking && (
            <div className="thinking-indicator" role="status" aria-live="polite">
              <span className="role-dot assistant" />
              <strong>{props.runningAgent ?? props.selectedAgent}</strong>
              <span className="thinking-label">思考中</span>
              <span className="typing">
                <i />
                <i />
                <i />
              </span>
            </div>
          )}
        </div>
        <div className="composer">
          <div className="composer-toolbar">
            <label className="select-label">
              @{" "}
              <select value={props.selectedAgent} onChange={(event) => props.setSelectedAgent(event.target.value)}>
                {props.primaryAgents.map((agent) => (
                  <option key={agent.name} value={agent.name}>
                    {agent.name} · primary
                  </option>
                ))}
              </select>
            </label>
            <label className={`switch-label ${props.noReply ? "selected" : ""}`}>
              <input
                type="checkbox"
                checked={props.noReply}
                onChange={(event) => props.setNoReply(event.target.checked)}
              />
              <span className="switch" /> noReply <small>仅记录，不回复</small>
            </label>
          </div>
          <div className="composer-editor">
            {props.mentionQuery !== null && mentionAgents.length > 0 && (
              <div className="mention-menu">
                <div className="mention-hint">选择要 @ 的 primary Agent</div>
                {mentionAgents.map((agent) => (
                  <button
                    type="button"
                    className="mention-option"
                    key={agent.name}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => props.selectMention(agent)}
                  >
                    <span className="mention-avatar">{agent.name.slice(0, 1).toUpperCase()}</span>
                    <span>
                      <strong>{agent.name}</strong>
                      <small>{agent.label}</small>
                    </span>
                    <em>primary</em>
                  </button>
                ))}
              </div>
            )}
            <textarea
              value={props.draft}
              onChange={(event) => props.updateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  props.sendMessage()
                }
              }}
              placeholder={
                props.noReply
                  ? "写入一条不会触发 Agent 的消息..."
                  : `输入 @ 选择 Agent，或发送给 @${props.selectedAgent}...`
              }
            />
          </div>
          <div className="composer-footer">
            <span>
              Enter 发送 <b>·</b> Shift Enter 换行 <b>·</b> API /session/:id/prompt_async
            </span>
            {props.running ? (
              <button type="button" className="stop-button" onClick={props.stopMessage}>
                停止 <span>■</span>
              </button>
            ) : (
              <button type="button" className="send-button" onClick={props.sendMessage} disabled={!props.draft.trim()}>
                发送 <span>↗</span>
              </button>
            )}
          </div>
        </div>
      </section>
      <aside className="panel event-panel">
        <div className="panel-heading">
          <div>
            <span className="panel-kicker">EVENT STREAM</span>
            <h2>运行事件</h2>
          </div>
          <button type="button" className="text-button">
            清空
          </button>
        </div>
        <div className="event-list">
          <div className="event-item">
            <span className="event-icon cyan">↳</span>
            <div>
              <strong>task completed</strong>
              <p>source-finder returned result</p>
              <time>10:25:42</time>
            </div>
          </div>
          <div className="event-item">
            <span className="event-icon violet">◇</span>
            <div>
              <strong>assistant finished</strong>
              <p>researcher / info.finish = true</p>
              <time>10:26:08</time>
            </div>
          </div>
          <div className="event-item">
            <span className="event-icon amber">◌</span>
            <div>
              <strong>message persisted</strong>
              <p>message + parts written to PG</p>
              <time>10:26:09</time>
            </div>
          </div>
        </div>
        <div className="event-footer">
          <span className="pulse green" /> SSE /event
        </div>
      </aside>
    </div>
  )
}

function Team({ agents, setShowAgentForm }: { agents: Agent[]; setShowAgentForm: (value: boolean) => void }) {
  return (
    <div className="team-view">
      <div className="team-heading">
        <div>
          <span className="panel-kicker">SESSION AGENTS / 04</span>
          <h2>工作空间团队</h2>
          <p>每个 Agent 都属于当前 Session，配置和消息互相隔离。</p>
        </div>
        <button type="button" className="add-button" onClick={() => setShowAgentForm(true)}>
          + 添加 Agent
        </button>
      </div>
      <div className="agent-grid">
        {agents.map((agent) => (
          <article className={`agent-card ${agent.mode}`} key={agent.name}>
            <div className="agent-card-top">
              <div className={`agent-avatar ${agent.mode}`}>{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-title">
                <h3>{agent.name}</h3>
                <span>{agent.label}</span>
              </div>
              <span className={`mode-badge ${agent.mode}`}>{agent.mode}</span>
            </div>
            <p className="agent-tone">{agent.tone}</p>
            <div className="agent-config">
              <span>
                <small>MODEL</small>
                {agent.provider} / {agent.model}
              </span>
              <span>
                <small>PERMISSION</small>
                {agent.permissions.join(" · ")}
              </span>
            </div>
            <div className="agent-card-foot">
              <span>
                <span className="pulse green" /> ready
              </span>
              {agent.mode === "subagent" ? (
                <span className="dispatch-note">only via task</span>
              ) : (
                <button type="button" className="card-link">
                  可直接 @ 调度 →
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      <div className="relationship-panel">
        <div>
          <span className="panel-kicker">DISPATCH GRAPH</span>
          <h3>调度关系</h3>
        </div>
        <div className="graph">
          <div className="graph-node primary">
            <b>manager</b>
            <small>primary</small>
          </div>
          <span className="graph-line" />
          <div className="graph-node sub">
            <b>writer</b>
            <small>subagent</small>
          </div>
          <div className="graph-node primary">
            <b>researcher</b>
            <small>primary</small>
          </div>
          <span className="graph-line" />
          <div className="graph-node sub">
            <b>source-finder</b>
            <small>subagent</small>
          </div>
        </div>
      </div>
    </div>
  )
}

function Verification() {
  return (
    <div className="verification-view">
      <div className="verification-heading">
        <div>
          <span className="panel-kicker">SCENARIO / 03-AGENT-DISPATCH</span>
          <h2>测试验证</h2>
          <p>把文档用例变成可观察的运行断言，验证 API 响应、消息流和 PG 状态。</p>
        </div>
        <button type="button" className="run-button">
          <span>▶</span> Run all checks
        </button>
      </div>
      <div className="verification-summary">
        <div>
          <strong>4</strong>
          <span>passed</span>
        </div>
        <div className="summary-divider" />
        <div>
          <strong className="pending-text">1</strong>
          <span>pending</span>
        </div>
        <div className="summary-progress">
          <span style={{ width: "80%" }} />
        </div>
        <small>last run · 2 min ago</small>
      </div>
      <div className="check-list">
        {checks.map((check) => (
          <article className="check-row" key={check.id}>
            <span className={`check-status ${check.state}`}>{check.state === "pass" ? "✓" : "○"}</span>
            <div className="check-copy">
              <strong>
                {check.id} <span>{check.title}</span>
              </strong>
              <p>{check.detail}</p>
            </div>
            <span className="check-endpoint">
              {check.id === "ST.3.2" ? "POST /message" : check.id === "ST.3.12" ? "GET /children" : "ASSERT"}
            </span>
            <button type="button" className="inspect-button">
              inspect ↗
            </button>
          </article>
        ))}
      </div>
      <div className="verification-note">
        <span>i</span>
        <p>验证面板将来可以直接调用 `test-lib.sh` 对应的 HTTP API，当前版本使用本地演示数据展示状态流。</p>
      </div>
    </div>
  )
}

export default App
