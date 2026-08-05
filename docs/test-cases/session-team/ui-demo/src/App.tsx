import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  ChevronDown,
  HelpCircle,
  ListTree,
  MessageSquare,
  Sparkles,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react"
import { Streamdown } from "streamdown"
import { mermaid } from "@streamdown/mermaid"

const streamdownPlugins = { mermaid }
import { subscribeEvents } from "./sse"

type AgentMode = "primary" | "subagent"
type View = "session" | "team" | "members"

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

type TaskInfo = {
  description?: string
  subagent?: string
  status?: string
  childId?: string
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
  task?: TaskInfo
}

type ApiPart = {
  id?: string
  messageID?: string
  type?: string
  text?: string
  tool?: string
  state?: {
    status?: string
    error?: string
    input?: { description?: string; prompt?: string; subagent_type?: string }
    output?: string
  }
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

type ApiSession = { id: string; directory?: string; title?: string }

type Member = {
  name: string
  label: string
  title: string
}

type SessionEntry = {
  id: string
  title: string
  directory?: string
  createdAt: number
}

function loadStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const AGENTS_VERSION = 2

function loadAgents(): Agent[] {
  const stored = loadStored<Agent[]>("session-team-agents", [])
  const version = Number(window.localStorage.getItem("session-team-agents-version") ?? "0")
  if (version >= AGENTS_VERSION) return stored
  const merged = [...stored]
  for (const agent of initialAgents) if (!merged.some((item) => item.name === agent.name)) merged.push(agent)
  window.localStorage.setItem("session-team-agents-version", String(AGENTS_VERSION))
  return merged
}

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
  {
    name: "planner",
    label: "项目规划师",
    mode: "primary",
    provider: "zhipuai",
    model: "glm-5.1",
    tone: "把模糊目标拆解为可执行的里程碑和任务清单，输出优先级、依赖关系和验收标准。只做规划，不调用工具。",
    permissions: ["read"],
    status: "ready",
  },
  {
    name: "prd",
    label: "需求分析师",
    mode: "primary",
    provider: "zhipuai",
    model: "glm-5.1",
    tone: "撰写结构化 PRD：背景、目标、用户故事、功能范围、验收标准、边界情况。关键不确定点用 question 工具向用户确认。",
    permissions: ["read", "question"],
    status: "ready",
  },
  {
    name: "architect",
    label: "架构师",
    mode: "primary",
    provider: "zhipuai",
    model: "glm-5.1",
    tone: "负责技术选型与系统设计：模块划分、数据模型、接口契约、扩展性与风险权衡。输出决策依据，不直接写代码。",
    permissions: ["read"],
    status: "ready",
  },
  {
    name: "developer",
    label: "开发工程师",
    mode: "primary",
    provider: "zhipuai",
    model: "glm-5.1",
    tone: "根据需求和设计实现代码，遵循现有代码风格，完成后自测并说明改动点。禁止访问外网（无网络环境）。",
    permissions: ["read", "edit", "bash"],
    status: "ready",
  },
  {
    name: "reviewer",
    label: "代码审查员",
    mode: "primary",
    provider: "zhipuai",
    model: "glm-5.1",
    tone: "审查代码与方案：找出事实错误、逻辑漏洞、安全与性能风险，按严重程度输出问题清单和修改建议。",
    permissions: ["read"],
    status: "ready",
  },
  {
    name: "tester",
    label: "测试工程师",
    mode: "primary",
    provider: "zhipuai",
    model: "glm-5.1",
    tone: "设计测试用例：正常路径、边界条件、异常场景，输出可执行的验证步骤和预期结果。",
    permissions: ["read", "bash"],
    status: "ready",
  },
  {
    name: "analyst",
    label: "数据分析师",
    mode: "primary",
    provider: "zhipuai",
    model: "glm-5.1",
    tone: "分析数据与指标：清洗、统计、解读趋势和异常，输出结论和可视化建议（表格优先）。",
    permissions: ["read", "bash"],
    status: "ready",
  },
  {
    name: "designer",
    label: "设计顾问",
    mode: "primary",
    provider: "zhipuai",
    model: "glm-5.1",
    tone: "提供交互与视觉设计建议：信息架构、布局、组件状态、可用性细节，输出具体可落地的方案。",
    permissions: ["read"],
    status: "ready",
  },
  {
    name: "copywriter",
    label: "文案策划",
    mode: "primary",
    provider: "zhipuai",
    model: "glm-5.1",
    tone: "撰写营销文案与内容：标题、正文、 slogan，风格匹配目标受众，给出多个版本供选择。",
    permissions: ["read"],
    status: "ready",
  },
  {
    name: "devops",
    label: "运维工程师",
    mode: "primary",
    provider: "zhipuai",
    model: "glm-5.1",
    tone: "负责部署、监控与故障排查：容器、进程、日志、资源占用。诊断问题先收集证据再给结论。禁止访问外网。",
    permissions: ["read", "bash"],
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
const initialMembers: Member[] = [
  { name: "pm-li", label: "李然", title: "产品经理" },
  { name: "dev-wang", label: "王工", title: "后端工程师" },
  { name: "design-chen", label: "陈曦", title: "设计师" },
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

function parseTaskInfo(part: ApiPart): TaskInfo | undefined {
  if (part.tool !== "task") return undefined
  return {
    description: part.state?.input?.description,
    subagent: part.state?.input?.subagent_type,
    status: part.state?.status,
    childId: part.state?.output?.match(/<task id="([^"]+)"/)?.[1],
  }
}

function toolLabel(part: ApiPart) {
  return `${part.tool ?? "tool"} · ${part.state?.status ?? "running"}${part.state?.error ? ` · ${part.state.error}` : ""}`
}

function normalizeMessages(messages: ApiMessage[]): Message[] {
  return messages.flatMap<Message>((message, index) => {
    const info = message.info ?? {}
    const textParts = (message.parts ?? []).filter((part) => part.type === "text" && part.text)
    const reasoningParts = (message.parts ?? []).filter((part) => part.type === "reasoning" && part.text)
    const toolParts = (message.parts ?? []).filter((part) => part.type === "tool")
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
    toolParts.forEach((tool, toolIndex) => {
      const task = parseTaskInfo(tool)
      result.push({
        id: (index + 1) * 1000 + toolIndex + 1,
        sourceId: info.id,
        sourcePartId: tool.id,
        role: "tool",
        agent: info.agent ?? tool.tool ?? "task",
        text: task ? (task.description ?? toolLabel(tool)) : toolLabel(tool),
        task,
        time: "now",
      })
    })
    return result
  })
}

function mergeMessages(current: Message[], remote: Message[], optimisticId: number) {
  const optimistic = current.find((message) => message.id === optimisticId)
  return optimistic && remote.every((message) => message.text !== optimistic.text) ? [optimistic, ...remote] : remote
}

function App() {
  const [view, setView] = useState<View>("session")
  const [agents, setAgents] = useState(loadAgents)
  const [members, setMembers] = useState(() => loadStored<Member[]>("session-team-members", initialMembers))
  const [sessions, setSessions] = useState(() => loadStored<SessionEntry[]>("session-team-sessions", []))
  const [messages, setMessages] = useState(initialMessages)
  const [questions, setQuestions] = useState<QuestionRequest[]>([])
  const [selectedAgent, setSelectedAgent] = useState("researcher")
  const [draft, setDraft] = useState("")
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [showAgentForm, setShowAgentForm] = useState(false)
  const [agentFormError, setAgentFormError] = useState<string | null>(null)
  const [showMemberForm, setShowMemberForm] = useState(false)
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
    window.localStorage.setItem("session-team-agents", JSON.stringify(agents))
  }, [agents])

  useEffect(() => {
    window.localStorage.setItem("session-team-members", JSON.stringify(members))
  }, [members])

  useEffect(() => {
    window.localStorage.setItem("session-team-sessions", JSON.stringify(sessions))
  }, [sessions])

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
              ...Object.fromEntries(agent.permissions.map((permission) => [permission, "allow"])),
              // 容器无外网，websearch 会挂死会话，统一禁用
              websearch: "deny",
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
          const partID = part.id
          setMessages((current) => {
            const index = current.findIndex((message) => message.role === "tool" && message.sourcePartId === partID)
            if (index >= 0)
              return current.map((message, messageIndex) =>
                messageIndex === index
                  ? { ...message, text: task ? (task.description ?? label) : label, task }
                  : message,
              )
            return [
              ...current,
              {
                id: nextMessageId(),
                sourceId: part.messageID,
                sourcePartId: partID,
                role: "tool",
                agent: part.tool ?? "tool",
                text: task ? (task.description ?? label) : label,
                task,
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

      if (event.type === "question.asked" || event.type === "question.replied" || event.type === "question.rejected") {
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

  function sendMessage() {
    if (!draft.trim() || running) return
    const now = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    const text = draft.trim()
    const mentionedName = text.match(/(?:^|\s)@([a-zA-Z0-9_-]+)/)?.[1]
    const mentionedAgent = primaryAgents.find((agent) => agent.name === mentionedName)
    // 扣子语义：@ 才派发任务，不 @ 仅记录为项目背景
    const targetAgent = mentionedAgent?.name ?? null
    const messageId = Date.now()
    setMessages((current) => [...current, { id: messageId, role: "user", text, time: now }])
    setDraft("")
    if (!targetAgent) {
      void sendToApi(text, messageId, null)
      return
    }
    setRunning(true)
    setRunningAgent(targetAgent)
    runningAgentRef.current = targetAgent
    setSelectedAgent(targetAgent)
    void sendToApi(text, messageId, targetAgent)
  }

  async function sendToApi(text: string, optimisticId: number, targetAgent: string | null) {
    try {
      if (!sessionId) throw new Error("Session 尚未创建")
      const path = targetAgent ? `/session/${sessionId}/prompt_async` : `/session/${sessionId}/message`
      await apiRequest(path, {
        method: "POST",
        body: JSON.stringify({
          parts: [{ type: "text", text }],
          ...(targetAgent
            ? { agent: targetAgent, model: { providerID: "zhipuai", modelID: "glm-5.1" } }
            : { noReply: true }),
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
    setConnection("connecting")
    setView("session")
  }

  function selectSession(id: string) {
    if (id === sessionId) return
    window.localStorage.setItem("session-team-demo-id", id)
    setMessages([])
    setQuestions([])
    setConnection("connecting")
    setSessionId(id)
    setView("session")
  }

  useEffect(() => {
    if (!sessionId || connection !== "connected") return
    void syncSessionAgents(sessionId, agents).catch(() => undefined)
  }, [agents, sessionId, connection])

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
        permissions: mode === "primary" ? ["read", "task"] : ["read"],
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
            <button
              className={`session-row ${entry.id === sessionId && view === "session" ? "active" : ""}`}
              type="button"
              key={entry.id}
              onClick={() => selectSession(entry.id)}
            >
              <span className={`session-dot ${entry.id === sessionId ? "live" : ""}`} />
              <span className="session-copy">
                <strong>{entry.title}</strong>
                <small>{entry.id.slice(0, 12)}</small>
              </span>
            </button>
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
                className="modal-textarea"
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
            {agentFormError && <p className="modal-error">{agentFormError}</p>}
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

function TaskCard({ task, parentSessionId }: { task: TaskInfo; parentSessionId: string }) {
  const running = task.status === "running" || task.status === "pending"
  const [open, setOpen] = useState(running)
  const [childId, setChildId] = useState(task.childId)
  const [childMessages, setChildMessages] = useState<Message[]>([])

  useEffect(() => {
    if (running) setOpen(true)
  }, [running])
  useEffect(() => {
    if (task.childId) setChildId(task.childId)
  }, [task.childId])

  useEffect(() => {
    if (!open) return
    let stopped = false
    let timer = 0
    async function load() {
      let cid = childId
      if (!cid) {
        try {
          const children = await apiRequest<Array<{ id: string; title?: string }>>(
            `/session/${parentSessionId}/children`,
          )
          const match =
            children.find((child) => task.description && child.title?.startsWith(task.description)) ??
            children[children.length - 1]
          if (match) {
            cid = match.id
            setChildId(cid)
          }
        } catch {
          // 子会话尚未创建，下一轮继续
        }
      }
      if (cid) {
        try {
          const remote = await apiRequest<ApiMessage[]>(`/session/${cid}/message`)
          if (!stopped) setChildMessages(normalizeMessages(remote))
        } catch {
          // 转录拉取失败，下一轮继续
        }
      }
      if (!stopped && running) timer = window.setTimeout(load, 2000)
    }
    void load()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [open, childId, running, parentSessionId, task.description])

  const visibleMessages = childMessages.filter((message) => message.role !== "user")
  return (
    <div className={`task-card ${running ? "running" : ""}`}>
      <button type="button" className="task-card-head" onClick={() => setOpen((current) => !current)}>
        <ListTree size={14} />
        <span className="task-desc">{task.description ?? "子任务"}</span>
        {task.subagent && <em>@{task.subagent}</em>}
        <span className={`task-status ${task.status ?? "running"}`}>
          {running ? "执行中" : task.status === "completed" ? "已完成" : (task.status ?? "")}
        </span>
        <ChevronDown size={12} className={`task-chevron ${open ? "open" : ""}`} />
      </button>
      {open && (
        <div className="task-card-body">
          {visibleMessages.map((message) =>
            message.role === "tool" ? (
              <div className="subtask-tool" key={message.id}>
                {message.text}
              </div>
            ) : (
              <div className="subtask-msg" key={message.id}>
                <span className="subtask-agent">{message.agent}</span>
                {message.reasoning && (
                  <details className="subtask-reasoning">
                    <summary>思考过程</summary>
                    <div>{message.reasoning}</div>
                  </details>
                )}
                {message.text && (
                  <div className="markdown-content">
                    <Streamdown plugins={streamdownPlugins}>{message.text}</Streamdown>
                  </div>
                )}
              </div>
            ),
          )}
          {running && visibleMessages.length === 0 && <div className="subtask-loading">子任务执行中…</div>}
        </div>
      )}
    </div>
  )
}

function Conversation(props: {
  messages: Message[]
  sessionId: string
  selectedAgent: string
  runningAgent: string | null
  primaryAgents: Agent[]
  members: Member[]
  draft: string
  updateDraft: (value: string) => void
  mentionQuery: string | null
  selectMention: (name: string) => void
  sendMessage: () => void
  stopMessage: () => void
  running: boolean
  questions: QuestionRequest[]
  onAnswered: () => void
}) {
  const mentionAgents = props.primaryAgents.filter((agent) => agent.name.includes(props.mentionQuery ?? ""))
  const mentionMembers = props.members.filter(
    (member) => member.name.includes(props.mentionQuery ?? "") || member.label.includes(props.mentionQuery ?? ""),
  )
  const showMentionMenu = props.mentionQuery !== null && (mentionAgents.length > 0 || mentionMembers.length > 0)
  const lastMessage = props.messages[props.messages.length - 1]
  const streamingContent =
    lastMessage?.role === "assistant" && !lastMessage.finish && Boolean(lastMessage.reasoning || lastMessage.text)
  const showThinking = props.running && !streamingContent && props.questions.length === 0
  return (
    <div className="conversation-layout min-h-0 flex-1">
      <section className="panel conversation-panel flex min-h-0 flex-1 flex-col">
        <div className="panel-heading shrink-0">
          <div>
            <span className="panel-kicker">LIVE TRANSCRIPT</span>
            <h2>对话现场</h2>
          </div>
          <span className="live-label">
            <span className="pulse" /> streaming
          </span>
        </div>
        <div className="message-list min-h-0 flex-1 overflow-y-auto">
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
                        <Streamdown animated={!message.finish} plugins={streamdownPlugins}>
                          {message.text}
                        </Streamdown>
                      </div>
                    )}
                  </>
                ) : message.role === "tool" && message.task ? (
                  <TaskCard task={message.task} parentSessionId={props.sessionId} />
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
        <div className="composer shrink-0">
          <div className="composer-editor">
            {showMentionMenu && (
              <div className="mention-menu">
                <div className="mention-hint">@ Agent 派发任务 · @ 成员提醒参与</div>
                {mentionAgents.map((agent) => (
                  <button
                    type="button"
                    className="mention-option"
                    key={agent.name}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => props.selectMention(agent.name)}
                  >
                    <span className="mention-avatar">{agent.name.slice(0, 1).toUpperCase()}</span>
                    <span>
                      <strong>{agent.name}</strong>
                      <small>{agent.label}</small>
                    </span>
                    <em>Agent</em>
                  </button>
                ))}
                {mentionMembers.map((member) => (
                  <button
                    type="button"
                    className="mention-option"
                    key={member.name}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => props.selectMention(member.name)}
                  >
                    <span className="mention-avatar member">{member.label.slice(0, 1)}</span>
                    <span>
                      <strong>{member.label}</strong>
                      <small>@{member.name}</small>
                    </span>
                    <em>成员</em>
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
              placeholder="不 @ 仅记录为项目背景，@ Agent 才会派发任务..."
            />
          </div>
          <div className="composer-footer">
            <span>
              Enter 发送 <b>·</b> Shift Enter 换行 <b>·</b> @ 派发 = prompt_async <b>·</b> 不 @ = noReply 仅记录
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
    </div>
  )
}

function Team({
  agents,
  setShowAgentForm,
  onRemove,
}: {
  agents: Agent[]
  setShowAgentForm: (value: boolean) => void
  onRemove: (name: string) => void
}) {
  return (
    <div className="team-view">
      <div className="team-heading">
        <div>
          <span className="panel-kicker">GLOBAL AGENTS / {String(agents.length).padStart(2, "0")}</span>
          <h2>Agent 团队</h2>
          <p>Agent 团队是全局能力，可在任意 Session 中 @ 调度。</p>
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
              <button type="button" className="card-delete" title="删除 Agent" onClick={() => onRemove(agent.name)}>
                <Trash2 size={13} />
              </button>
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
          {agents.map((agent, index) => (
            <Fragment key={agent.name}>
              {index > 0 && <span className="graph-line" />}
              <div className={`graph-node ${agent.mode === "primary" ? "primary" : "sub"}`}>
                <b>{agent.name}</b>
                <small>{agent.mode}</small>
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}

function Members({
  members,
  setShowMemberForm,
  onRemove,
}: {
  members: Member[]
  setShowMemberForm: (value: boolean) => void
  onRemove: (name: string) => void
}) {
  return (
    <div className="team-view">
      <div className="team-heading">
        <div>
          <span className="panel-kicker">GLOBAL MEMBERS / {String(members.length).padStart(2, "0")}</span>
          <h2>成员管理</h2>
          <p>成员可被 @ 提醒参与讨论，相关消息作为项目背景沉淀。</p>
        </div>
        <button type="button" className="add-button" onClick={() => setShowMemberForm(true)}>
          + 添加成员
        </button>
      </div>
      <div className="agent-grid">
        {members.map((member) => (
          <article className="agent-card member" key={member.name}>
            <div className="agent-card-top">
              <div className="agent-avatar member">{member.label.slice(0, 1)}</div>
              <div className="agent-title">
                <h3>{member.label}</h3>
                <span>@{member.name}</span>
              </div>
              <span className="mode-badge member">{member.title}</span>
              <button type="button" className="card-delete" title="删除成员" onClick={() => onRemove(member.name)}>
                <Trash2 size={13} />
              </button>
            </div>
            <div className="agent-card-foot">
              <span>
                <span className="pulse green" /> online
              </span>
              <span className="dispatch-note">@ 提醒参与，不触发任务</span>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

export default App
