import { useCallback, useEffect, useRef, useState } from "react"
import {
  createSession,
  deleteSession,
  fetchSkillsCatalog,
  listMessages,
  listQuestions,
  listSessionSkills,
  listSessions,
  MODEL,
  registerSkill,
  sendMessageAsync,
  unregisterSkill,
  type CatalogEntry,
  type Message,
  type MessagePart,
  type ModelRef,
  type QuestionRequest,
  type Session,
  type SessionSkill,
} from "./api"
import { subscribeEvents, type PartDeltaProps, type PartUpdatedProps } from "./sse"
import { SessionsSidebar } from "./components/SessionsSidebar"
import { ChatView } from "./components/ChatView"
import { SkillsPanel } from "./components/SkillsPanel"

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [registered, setRegistered] = useState<SessionSkill[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [questions, setQuestions] = useState<QuestionRequest[]>([])
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState<ModelRef>(MODEL)
  const [skillsOpen, setSkillsOpen] = useState(true)
  const directoryRef = useRef<string | null>(null)

  // ── 初始化：加载会话列表 + 技能目录 ──
  useEffect(() => {
    Promise.all([refreshSessions(), fetchSkillsCatalog().then(setCatalog)]).catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshSessions = useCallback(async () => {
    try {
      const list = await listSessions()
      const sorted = [...list].sort(
        (a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0),
      )
      setSessions(sorted)
      setCurrentId((prev) => prev ?? sorted[0]?.id ?? null)
    } catch {
      // 服务端不可达时保持空列表
    }
  }, [])

  // 没有会话时自动创建一个
  useEffect(() => {
    if (sessions.length === 0 && currentId === null) {
      createSession("New Chat")
        .then((s) => {
          setCurrentId(s.id)
          refreshSessions()
        })
        .catch(console.error)
    }
  }, [sessions, currentId, refreshSessions])

  // ── 当前会话的注册技能与消息 ──
  const refreshRegistered = useCallback(async () => {
    if (!currentId) return
    try {
      setRegistered(await listSessionSkills(currentId))
    } catch {
      setRegistered([])
    }
  }, [currentId])

  const refreshMessages = useCallback(async () => {
    if (!currentId) return
    try {
      setMessages(await listMessages(currentId))
    } catch {
      setMessages([])
    }
  }, [currentId])

  const refreshQuestions = useCallback(async () => {
    if (!currentId) return
    try {
      const all = await listQuestions()
      setQuestions(all.filter((q) => q.sessionID === currentId))
    } catch {
      setQuestions([])
    }
  }, [currentId])

  useEffect(() => {
    refreshRegistered()
    refreshMessages()
    refreshQuestions()
  }, [refreshRegistered, refreshMessages, refreshQuestions])

  // ── SSE 订阅（当前会话切换时重连）──
  useEffect(() => {
    if (!currentId) return

    let close: (() => void) | null = null
    let cancelled = false

    // 先拿 directory 再订阅
    fetch(`/opencode/session/${currentId}`)
      .then((r) => r.json())
      .then((session) => {
        if (cancelled) return
        const dir = session.directory ?? "/workspace"
        directoryRef.current = dir

        close = subscribeEvents(dir, (event) => {
          if (cancelled) return
          const props = event.properties as Record<string, unknown>
          const sessionID = props.sessionID as string | undefined

          // session.updated / session.idle 会影响会话列表（标题等），不限于当前会话
          if (event.type === "session.updated" || event.type === "session.idle") {
            refreshSessions()
            if (event.type === "session.idle" && sessionID === currentId) {
              refreshMessages().then(() => setBusy(false))
            }
            return
          }

          // 其他事件只处理当前会话
          if (sessionID !== currentId) return

          switch (event.type) {
            case "message.part.delta": {
              // 流式增量：追加 delta 到对应 part
              const p = props as unknown as PartDeltaProps
              setMessages((prev) =>
                prev.map((m) => {
                  const mid = m.info?.id ?? m.id
                  if (mid !== p.messageID) return m
                  return {
                    ...m,
                    parts: m.parts.map((part) => {
                      if (part.id !== p.partID || part.type !== "text") return part
                      return { ...part, text: (part.text ?? "") + p.delta }
                    }),
                  }
                }),
              )
              break
            }

            case "message.part.updated": {
              // 完整 part 更新（tool 状态流转、text 完成）
              const p = props as unknown as PartUpdatedProps
              if (!p.part?.id) break
              setMessages((prev) => {
                const exists = prev.some((m) => {
                  const mid = m.info?.id ?? m.id
                  return mid === p.part.messageID
                })
                if (!exists) {
                  // 新消息：拉取全量（messageID 未知归属，简单起见触发刷新）
                  refreshMessages()
                  return prev
                }
                return prev.map((m) => {
                  const mid = m.info?.id ?? m.id
                  if (mid !== p.part.messageID) return m
                  const idx = m.parts.findIndex((part) => part.id === p.part.id)
                  if (idx >= 0) {
                    const next = [...m.parts]
                    next[idx] = { ...next[idx], ...p.part } as MessagePart
                    return { ...m, parts: next }
                  }
                  return { ...m, parts: [...m.parts, p.part as MessagePart] }
                })
              })
              break
            }

            case "message.updated": {
              // 新消息创建：拉取全量保证一致性
              refreshMessages()
              break
            }

            case "question.asked": {
              refreshQuestions()
              break
            }

            case "question.replied":
            case "question.rejected": {
              refreshQuestions()
              refreshMessages()
              break
            }
          }
        })
      })
      .catch(console.error)

    return () => {
      cancelled = true
      close?.()
    }
  }, [currentId, refreshMessages, refreshQuestions, refreshSessions])

  // ── 会话操作 ──
  const handleNewSession = useCallback(async () => {
    const s = await createSession("New Chat")
    await refreshSessions()
    setCurrentId(s.id)
    setMessages([])
    setBusy(false)
  }, [refreshSessions])

  const handleDeleteSession = useCallback(
    async (id: string) => {
      await deleteSession(id)
      const next = sessions.filter((s) => s.id !== id)
      setSessions(next)
      if (currentId === id) setCurrentId(next[0]?.id ?? null)
    },
    [sessions, currentId],
  )

  // ── 技能操作 ──
  const handleRegister = useCallback(
    async (key: string) => {
      if (!currentId) return
      const { fetchSkillBundle } = await import("./api")
      const bundle = await fetchSkillBundle(key)
      await registerSkill(currentId, bundle)
      await refreshRegistered()
    },
    [currentId, refreshRegistered],
  )

  const handleUnregister = useCallback(
    async (name: string) => {
      if (!currentId) return
      await unregisterSkill(currentId, name)
      await refreshRegistered()
    },
    [currentId, refreshRegistered],
  )

  // ── 发送 ──
  const handleSend = useCallback(
    async (text: string, skills: string[]) => {
      if (!currentId || busy) return
      setBusy(true)
      setMessages((prev) => [
        ...prev,
        { id: `tmp-${Date.now()}`, role: "user", parts: [{ type: "text", text }] },
      ])
      try {
        await sendMessageAsync(currentId, text, { skills, model })
        // SSE 会自动驱动后续更新，无需轮询
      } catch (e) {
        setBusy(false)
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: "assistant",
            parts: [{ type: "text", text: `发送失败: ${String(e)}` }],
          },
        ])
      }
    },
    [currentId, busy, model],
  )

  // ── question 回答后刷新 ──
  const handleAnswered = useCallback(() => {
    setQuestions([])
    refreshMessages()
  }, [refreshMessages])

  return (
    <div className="flex h-full bg-[#f5f6f8]">
      <SessionsSidebar
        sessions={sessions}
        currentId={currentId}
        onSelect={setCurrentId}
        onNew={handleNewSession}
        onDelete={handleDeleteSession}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <ChatView
          messages={messages}
          busy={busy}
          registered={registered}
          questions={questions}
          model={model}
          sessionId={currentId ?? ""}
          onModelChange={setModel}
          onAnswered={handleAnswered}
          onSend={handleSend}
          onToggleSkills={() => setSkillsOpen((v) => !v)}
        />
      </main>
      {skillsOpen && (
        <SkillsPanel
          catalog={catalog}
          registered={registered}
          onRegister={handleRegister}
          onUnregister={handleUnregister}
          onClose={() => setSkillsOpen(false)}
        />
      )}
    </div>
  )
}
