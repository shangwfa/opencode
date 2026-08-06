import { useEffect, useRef, useState } from "react"
import {
  ArrowUp,
  Square,
  X,
} from "lucide-react"
import { Streamdown } from "streamdown"
import type { Agent, Message, QueuedMessage, Member, ModelRef, ModelOption, QuestionRequest, PermissionRequest } from "../types"
import { streamdownPlugins } from "../constants"
import { ReasoningBlock } from "../components/ReasoningBlock"
import { QuestionCard } from "../components/QuestionCard"
import { TaskCard } from "../components/TaskCard"
import { PermissionCard } from "../components/PermissionCard"
import { FileCard } from "../components/FileCard"
import { FilePreviewModal } from "../components/FilePreviewModal"
import { ModelSelect } from "../components/ModelSelect"

export function Conversation(props: {
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
  permissions: PermissionRequest[]
  onPermissionResolved: () => void
  model: ModelRef
  modelOptions: ModelOption[]
  onModelChange: (model: ModelRef) => void
  queue: QueuedMessage[]
  onCancelQueued: (id: number) => void
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
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const previewFile = previewPath
    ? [...props.messages].reverse().find((message) => message.file?.filePath === previewPath)?.file ?? null
    : null
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [props.messages, props.questions, props.permissions, showThinking])
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
                {message.pending && <em className="pending-badge">排队中</em>}
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
                ) : message.role === "tool" && message.file ? (
                  <FileCard file={message.file} onPreview={() => setPreviewPath(message.file!.filePath)} />
                ) : message.error ? (
                  <div className="error-card">{message.text}</div>
                ) : (
                  message.text
                )}
              </div>
            </article>
          ))}
          {props.questions.map((question) => (
            <QuestionCard key={question.id} request={question} onAnswered={props.onAnswered} />
          ))}
          {props.permissions.map((perm) => (
            <PermissionCard key={perm.id} request={perm} onResolved={props.onPermissionResolved} />
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
          <div ref={bottomRef} />
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
          {props.queue.length > 0 && (
            <div className="queue-bar">
              {props.queue.map((item) => (
                <span className="queue-chip" key={item.id}>
                  <b>@{item.agent}</b>
                  {item.text.length > 24 ? `${item.text.slice(0, 24)}…` : item.text}
                  <i role="button" title="取消排队" onClick={() => props.onCancelQueued(item.id)}>
                    <X size={11} />
                  </i>
                </span>
              ))}
            </div>
          )}
          <div className="composer-footer">
            <span>
              Enter 发送 <b>·</b> Shift Enter 换行 <b>·</b> @ 派发 <b>·</b> 运行中 @ 发送 = 排队 <b>·</b> 不 @ = 仅记录
            </span>
            <ModelSelect model={props.model} options={props.modelOptions} onChange={props.onModelChange} />
            {props.running ? (
              <button type="button" className="stop-button" onClick={props.stopMessage} title="停止执行">
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="send-button"
                onClick={props.sendMessage}
                disabled={!props.draft.trim()}
                title="发送"
              >
                <ArrowUp size={16} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </section>
      {previewFile && (
        <FilePreviewModal file={previewFile} sessionId={props.sessionId} onClose={() => setPreviewPath(null)} />
      )}
    </div>
  )
}
