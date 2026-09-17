import { useState } from "react"
import { Play } from "lucide-react"
import type { Message, MessagePart } from "../api"
import { messageRole } from "../api"
import { MarkdownText } from "./MarkdownText"
import { ToolCallCard } from "./ToolCallCard"
import { HtmlPreview } from "./HtmlPreview"

interface MessageBubbleProps {
  message: Message
  streaming?: boolean
  sessionId?: string
}

// 从文本中提取 HTML 文件路径（/workspace/xxx.html 或相对路径）
const HTML_PATH_RE = /(?:\/workspace\/)?((?:[\w.-]+\/)*[\w.-]+\.html)\b/g

export function extractHtmlPaths(text: string): string[] {
  const paths = new Set<string>()
  for (const m of text.matchAll(HTML_PATH_RE)) {
    paths.add(m[1])
  }
  return [...paths]
}

export function MessageBubble({ message, streaming = false, sessionId }: MessageBubbleProps) {
  const isUser = messageRole(message) === "user"

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] space-y-2`}>
        {message.parts.map((part, i) => (
          <Part key={i} part={part} isUser={isUser} streaming={streaming} sessionId={sessionId} />
        ))}
      </div>
    </div>
  )
}

function Part({
  part,
  isUser,
  streaming,
  sessionId,
}: {
  part: MessagePart
  isUser: boolean
  streaming: boolean
  sessionId?: string
}) {
  if (part.type === "text" && part.text?.trim()) {
    const htmlPaths = !isUser && sessionId ? extractHtmlPaths(part.text) : []
    return (
      <div
        className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "whitespace-pre-wrap bg-blue-600 text-white"
            : "border border-gray-200 bg-white text-gray-800 shadow-sm"
        }`}
      >
        {isUser ? part.text : <MarkdownText animated={streaming}>{part.text}</MarkdownText>}
        {!isUser && htmlPaths.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {htmlPaths.map((p) => (
              <HtmlPreviewButton key={p} sessionId={sessionId!} filePath={p} />
            ))}
          </div>
        )}
      </div>
    )
  }

  if (part.type === "reasoning" && part.text?.trim()) {
    return (
      <details className="rounded-xl border border-gray-200 bg-gray-50 text-xs text-gray-500">
        <summary className="cursor-pointer select-none px-3 py-2 font-medium text-gray-400">
          Reasoning
        </summary>
        <div className="whitespace-pre-wrap px-3 pb-3 leading-relaxed">{part.text}</div>
      </details>
    )
  }

  if (part.type === "tool") {
    return <ToolCallCard part={part} />
  }

  return null
}

function HtmlPreviewButton({ sessionId, filePath }: { sessionId: string; filePath: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-100"
      >
        <Play className="h-3 w-3" />
        预览 {filePath.split("/").pop()}
      </button>
      {open && (
        <HtmlPreview sessionId={sessionId} filePath={filePath} onClose={() => setOpen(false)} />
      )}
    </>
  )
}
