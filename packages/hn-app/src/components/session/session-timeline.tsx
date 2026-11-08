/**
 * 会话时间线（React 版）。
 * 源：session-turn.tsx + ChatArea 的 turn 切片逻辑（sliceTurnMessages）：
 * 以 user 消息为界切 turn；user 渲染气泡，assistant 按 byMessageCreated 序渲染 parts。
 * 底部状态行来自 useTurnPhase（工具执行中/思考中/卡顿提示）。
 */
import { useLayoutEffect, useMemo, type ReactNode } from "react"
import type { Message, Part } from "@/types/opencode"
import { byMessageCreated, isToolPartStalledByError } from "@/shared/util/session"
import { extractAttachmentContext } from "@/features/requirement/attachments/build-attachment-context-text"
import { useStickToBottom } from "@/hooks/use-stick-to-bottom"
import { MessagePart } from "./message-part"
import { Markdown } from "./markdown"
import { cn } from "@/lib/utils"
import { Loader2 } from "lucide-react"
import { sessionErrorText } from "@/lib/session-error"

/** 以 user 消息为界切 turn：每个 turn = [user, ...紧随的 assistant 消息] */
export function sliceTurnMessages(allMsgs: Message[]): Message[][] {
  const turns: Message[][] = []
  let current: Message[] | null = null
  for (const m of [...allMsgs].sort(byMessageCreated)) {
    if (m.role === "user") {
      if (current) turns.push(current)
      current = [m]
    } else {
      current = current ?? []
      current.push(m)
    }
  }
  if (current) turns.push(current)
  return turns
}

/**
 * 是否存在正在流式输出的思考块。
 * 为真时思考态已由块内「思考中 + 三点」表达，底部状态行不再重复渲染；
 * 流式但尚未产出文本时同样成立（块内标题行已在表达该状态）。
 */
export function hasStreamingReasoningPart(parts: Record<string, Part[]>): boolean {
  for (const list of Object.values(parts)) {
    for (const part of list) {
      if (part.type !== "reasoning") continue
      const streaming = part.time ? !part.time.end : true
      if (streaming) return true
    }
  }
  return false
}

export function SessionTimeline({
  messages,
  parts,
  working,
  phaseLabel,
  executionError,
  children,
  footer,
  onFileLink,
  onImagePreview,
  className,
  sessionId,
  directory,
}: {
  messages: Message[]
  parts: Record<string, Part[]>
  working: boolean
  phaseLabel?: string
  /** 本轮执行失败但没有任何 assistant 消息可承载错误（例如模型调用直接失败）。 */
  executionError?: unknown
  /** 与消息同宽、共享滚动的待回答问题。 */
  children?: ReactNode
  /** 消息之后的独立区域（如草稿卡片），不与对话内容混排。 */
  footer?: ReactNode
  /** 沙箱文件链接点击（预览弹窗由页面层持有） */
  onFileLink?: (href: string) => void
  /** 图片 part 点击放大（灯箱由页面层持有） */
  onImagePreview?: (target: { url: string; name?: string }) => void
  className?: string
  sessionId?: string
  directory?: string
}) {
  const turns = useMemo(() => sliceTurnMessages(messages), [messages])
  const { anchorRef, pinned, overflowing, scrollToBottom } = useStickToBottom([messages.length, parts, working])
  const latestUserID = turns.at(-1)?.find((message) => message.role === "user")?.id

  // 新用户消息（含乐观消息）恢复跟随；AI 增量和同一消息的快照同步不抢滚动。
  useLayoutEffect(() => {
    if (latestUserID) scrollToBottom()
  }, [latestUserID, scrollToBottom])

  const hasStreamingReasoning = useMemo(() => hasStreamingReasoningPart(parts), [parts])

  return (
    <div data-slot="session-timeline" className={cn("mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-6", className)}>
      {turns.map((turn, ti) => {
        const userMsg = turn.find((m) => m.role === "user")
        const assistantMsgs = turn.filter((m) => m.role === "assistant")
        return (
          <div key={userMsg?.id ?? `assistant-turn-${ti}`} data-slot="chat-turn" className="hb-fade-up flex flex-col gap-3">
            {userMsg && (
              <>
                {/* 附件（对齐源：user 消息的 file part 也渲染为附件卡片/图片） */}
                {userFiles(parts[userMsg.id] ?? []).length > 0 && (
                  <div className="flex flex-wrap justify-end gap-2">
                    {userFiles(parts[userMsg.id] ?? []).map((p) => (
                      <div key={p.id} className="max-w-[85%]">
                        <MessagePart
                          part={p}
                          onFileLink={onFileLink}
                          onImagePreview={onImagePreview}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {displayText(parts[userMsg.id] ?? []) && (
                  <div className="flex justify-end">
                    <div data-chat-role="user" className="bg-muted text-foreground max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm leading-relaxed shadow-xs">
                      <Markdown content={displayText(parts[userMsg.id] ?? [])} onFileLink={onFileLink} />
                    </div>
                  </div>
                )}
              </>
            )}
            {assistantMsgs.map((m) => {
              const msgParts = parts[m.id] ?? []
              const stalled = isToolPartStalledByError(msgParts)
              return (
                <div key={m.id} data-chat-role="assistant" className="flex min-w-0 flex-col">
                  {(msgParts.length ? msgParts : []).map((p) => (
                    <MessagePart key={p.id} part={p} onFileLink={onFileLink} onImagePreview={onImagePreview} sessionId={sessionId} directory={directory} />
                  ))}
                  {m.role === "assistant" && m.error != null && (
                    <div role="alert" className="my-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                      <p className="font-medium">执行失败{m.modelID ? ` · ${m.modelID}` : ""}</p>
                      <p className="mt-1 break-words">{sessionErrorText(m.error)}</p>
                    </div>
                  )}
                  {working && stalled && (
                    <div className="text-muted-foreground my-1 flex items-center gap-2 text-xs">
                      <Loader2 className="size-3.5 animate-spin" />
                      <span>该轮工具全部异常结束，若长时间无新消息可重试发送</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}

      {children}
      {/* 有流式思考块时，思考态已由块内「思考中」表达，底部不再重复一行 */}
      {working && phaseLabel && !hasStreamingReasoning && (
        <div className="text-muted-foreground flex items-center gap-2 text-[13px]">
          <span className="hb-thinking-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <span>{phaseLabel}</span>
        </div>
      )}
      {/* 失败轮次可能一条 assistant 消息都没有；不显示就会「发出去后什么也没有」 */}
      {!working && executionError != null && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          <p className="font-medium">执行失败</p>
          <p className="mt-1 break-words">{sessionErrorText(executionError)}</p>
        </div>
      )}
      <div ref={anchorRef} />
      {/* 独立区域（草稿卡片等）放在状态行之后，避免插在对话与「思考中」之间 */}
      {footer}
      {/* 用户上滚后不再强制跟随，提供一个回到最新的入口 */}
      {/* 外层始终保留，避免显隐改变 flex gap 后触发底部滚动反馈循环。 */}
      <div className="pointer-events-none sticky bottom-2 z-10 h-0 shrink-0 self-center">
        {overflowing && !pinned && (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="回到底部"
            className="pointer-events-auto absolute bottom-0 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border bg-background px-3 py-1.5 text-xs shadow-sm hover:bg-muted"
          >
            回到底部 ↓
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * user 消息正文（显示用）：附件的 `[Attached file] name/url/mime` 是发给模型的上下文，
 * 已由上面的附件卡片表达，正文里不再重复展示（源 extractAttachmentContext 语义）。
 * 仅当该消息确实带 file part 时才剥离，避免误删用户自己写的同名字样。
 */
export function displayText(msgParts: Part[]): string {
  const text = msgParts
    // synthetic 是发给模型的隐藏上下文（如工作区就绪提示），不在气泡里展示
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && !p.synthetic)
    .map((p) => p.text)
    .join("\n")
  const hasFiles = msgParts.some((p) => p.type === "file")
  if (!hasFiles) return text
  return extractAttachmentContext(text).mainText
}

/** user 消息里的附件 part（image/file），用于在气泡上方渲染缩略图/文件卡片 */
function userFiles(msgParts: Part[]): Extract<Part, { type: "file" }>[] {
  return msgParts.filter((p): p is Extract<Part, { type: "file" }> => p.type === "file")
}
