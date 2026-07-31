import { useEffect, useRef, useState } from "react"
import { PanelRight } from "lucide-react"
import type { Message, ModelRef, QuestionRequest, SessionSkill } from "../api"
import { WelcomeScreen } from "./WelcomeScreen"
import { MessageBubble } from "./MessageBubble"
import { Composer } from "./Composer"
import { QuestionCard } from "./QuestionCard"

interface ChatViewProps {
  messages: Message[]
  busy: boolean
  registered: SessionSkill[]
  questions: QuestionRequest[]
  model: ModelRef
  sessionId: string
  onModelChange: (model: ModelRef) => void
  onAnswered: () => void
  onSend: (text: string, skills: string[]) => Promise<void>
  onToggleSkills: () => void
}

export function ChatView({
  messages,
  busy,
  registered,
  questions,
  model,
  sessionId,
  onModelChange,
  onAnswered,
  onSend,
  onToggleSkills,
}: ChatViewProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, busy, questions])

  const toggleSkill = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const hasMessages = messages.length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-gray-200/70 bg-white px-5 py-3">
        <h1 className="text-sm font-semibold text-gray-800">AI Chat</h1>
        <button
          onClick={onToggleSkills}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-500 transition-colors hover:bg-gray-50"
        >
          <PanelRight className="h-3.5 w-3.5" />
          技能配置 {registered.length > 0 && `(${registered.length})`}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {!hasMessages ? (
          <WelcomeScreen
            onPrompt={(text) => onSend(text, [...selected])}
          />
        ) : (
          <div className="mx-auto max-w-4xl space-y-4 px-4 py-6">
            {messages.map((msg, i) => (
              <MessageBubble
                key={msg.info?.id ?? msg.id ?? i}
                message={msg}
                streaming={busy && i === messages.length - 1}
                sessionId={sessionId}
              />
            ))}
            {questions.map((q) => (
              <QuestionCard key={q.id} request={q} onAnswered={onAnswered} />
            ))}
            {busy && (
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <span className="flex gap-1">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:300ms]" />
                </span>
                思考中
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Composer */}
      <Composer
        busy={busy}
        registered={registered}
        selected={selected}
        model={model}
        onModelChange={onModelChange}
        onToggleSkill={toggleSkill}
        onSend={(text) => onSend(text, [...selected])}
      />
    </div>
  )
}
