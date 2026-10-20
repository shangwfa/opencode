/**
 * 消息 part 渲染（React 版）。
 * 源：xybot-front-opencode-ui src/ui/components/message-part.tsx 的 chat 必需面：
 * - reasoning → 可折叠「思考过程」块（箭头右置）
 * - tool → 图标 + 工具名/命令摘要 + 右侧状态，点击展开详情（Shell 用执行语义图标）
 * - text → Markdown（合成 part 带 [合成] 标记）
 * 文件树/媒体预览等特殊 tool 视图随工作区模块迁移（见 MIGRATION.md）。
 */
import { useEffect, useRef, useState } from "react"
import {
  ChevronRight,
  Lightbulb,
  SquareTerminal,
  PenLine,
  FilePenLine,
  Search,
  FileText,
  Loader2,
  CheckCircle2,
  XCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Markdown } from "./markdown"
import type { Part } from "@/types/opencode"

type ToolMeta = {
  icon: typeof SquareTerminal
  label: string
  summary: (p: Extract<Part, { type: "tool" }>) => string
}

/** 工具呈现（对齐源 icon 语义；shell 用执行图标避免与折叠箭头混淆） */
function toolMeta(p: Extract<Part, { type: "tool" }>): ToolMeta {
  const tool = p.tool.toLowerCase()
  const cmd =
    typeof p.state.input?.command === "string"
      ? (p.state.input.command as string)
      : typeof p.state.input?.cmd === "string"
        ? (p.state.input.cmd as string)
        : undefined
  if (tool === "bash" || tool === "shell") {
    return {
      // SquareTerminal：终端语义（方块包裹，不与折叠箭头混淆）
      icon: SquareTerminal,
      label: "Shell",
      summary: (part) =>
        (part.state.input?.command as string) ??
        (part.state.input?.cmd as string) ??
        (part.state.metadata?.summary as string) ??
        "",
    }
  }
  if (tool === "edit" || tool === "patch") {
    return {
      icon: PenLine,
      label: p.tool,
      summary: (part) => (part.state.input?.filePath as string) ?? (part.state.input?.path as string) ?? "",
    }
  }
  if (tool === "write") {
    return {
      icon: FilePenLine,
      label: "Write",
      summary: (part) => (part.state.input?.filePath as string) ?? (part.state.input?.path as string) ?? "",
    }
  }
  if (tool === "grep" || tool === "glob" || tool === "find") {
    return {
      icon: Search,
      label: p.tool,
      summary: (part) => (part.state.input?.pattern as string) ?? "",
    }
  }
  if (tool === "read") {
    return {
      icon: FileText,
      label: "Read",
      summary: (part) => (part.state.input?.filePath as string) ?? (part.state.input?.path as string) ?? "",
    }
  }
  return {
    icon: SquareTerminal,
    label: p.tool,
    summary: (part) => cmd ?? (part.state.input?.filePath as string) ?? "",
  }
}

function ToolStatusIcon({ status }: { status: string }) {
  if (status === "running" || status === "pending")
    return <Loader2 className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
  if (status === "error") return <XCircle className="text-destructive size-3.5 shrink-0" />
  return <CheckCircle2 className="text-muted-foreground/70 size-3.5 shrink-0" />
}

export function MessagePart({
  part,
  onFileLink,
  onImagePreview,
}: {
  part: Part
  onFileLink?: (href: string) => void
  onImagePreview?: (target: { url: string; name?: string }) => void
}) {
  if (part.type === "step-start" || part.type === "step-finish") return null
  if (part.type === "reasoning") return <ReasoningBlock part={part} />
  if (part.type === "tool") return <ToolBlock part={part} onFileLink={onFileLink} />
  // synthetic 是发给模型的隐藏上下文，不渲染
  if (part.type === "text") return part.synthetic ? null : <TextBlock part={part} onFileLink={onFileLink} />
  if (part.type === "file")
    return <FilePartBlock part={part} onFileLink={onFileLink} onImagePreview={onImagePreview} />
  // snapshot / agent / patch / subtask / retry / compaction：不渲染或后续按需视图
  return null
}

/**
 * file part 渲染（对齐源 message-part.tsx + message-file.ts 的 kind()/typeLabel 语义）：
 * - `image/*` → 渲染图片，点击放大（源 ImagePreview）
 * - 其余 → 文件 chip；沙箱路径可点开预览（onFileLink）
 */
function FilePartBlock({
  part,
  onFileLink,
  onImagePreview,
}: {
  part: Extract<Part, { type: "file" }>
  onFileLink?: (href: string) => void
  onImagePreview?: (target: { url: string; name?: string }) => void
}) {
  const mime = part.mime ?? ""
  const name = part.filename ?? "文件"
  const url = part.url ?? ""

  if (mime.startsWith("image/") && url) {
    return (
      <div className="my-2">
        <button
          type="button"
          className="group relative block overflow-hidden rounded-lg border"
          onClick={() => onImagePreview?.({ url, name })}
          aria-label={"预览 " + name}
        >
          <img
            src={url}
            alt={name}
            className="max-h-72 max-w-full cursor-zoom-in object-contain transition-opacity group-hover:opacity-90"
          />
          <span className="absolute right-2 bottom-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
            {name}
          </span>
        </button>
      </div>
    )
  }

  const isSandboxPath = url.startsWith("file://") || url.startsWith("/")
  const clickable = isSandboxPath && !!onFileLink
  return (
    <div className="my-1">
      <button
        type="button"
        disabled={!clickable}
        onClick={() => clickable && onFileLink?.(url)}
        className={cn(
          "text-muted-foreground hover:bg-muted/70 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors",
          clickable && "cursor-pointer",
        )}
        title={clickable ? "点击预览" : url}
      >
        <FileText className="size-3.5 shrink-0" />
        <span className="truncate">{name}</span>
      </button>
    </div>
  )
}

function ReasoningBlock({
  part,
}: {
  part: Extract<Part, { type: "reasoning" }>
}) {
  // 流式中（time.end 未写入）→ 自动展开；输出完成 → 自动收起；用户手动开合优先
  const streaming = part.time ? !part.time.end : true
  const [everStreamed, setEverStreamed] = useState(streaming)
  const [userOverride, setUserOverride] = useState<boolean | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (streaming) {
      setEverStreamed(true)
      setUserOverride(null)
    } else if (everStreamed) {
      // 完成即自动收起
      setUserOverride(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming])

  // 流式期间内容贴底
  useEffect(() => {
    if (streaming && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [part.text, streaming])

  const open = userOverride ?? (streaming && everStreamed)
  const hasText = !!part.text?.trim()
  if (!hasText && !streaming) return null

  return (
    <div className="my-1">
      <button
        type="button"
        className="text-muted-foreground hover:bg-muted/60 hover:text-foreground -ml-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors"
        onClick={() => setUserOverride(!open)}
      >
        <Lightbulb className="size-3.5 shrink-0" />
        <span className="text-[13px] font-medium">{streaming ? "思考中" : "思考过程"}</span>
        {streaming && (
          <span className="hb-thinking-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
        )}
        <span className="flex-1" />
        <ChevronRight className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")} />
      </button>
      {/* 尚无正文时只留标题行（避免空竖线），到达内容后随流式逐行出现 */}
      {open && hasText && (
        <div
          ref={bodyRef}
          className={cn(
            "text-muted-foreground border-border/70 mt-1 ml-2 border-l py-1 pl-3.5 text-[13px] leading-relaxed whitespace-pre-wrap",
            streaming && "max-h-48 overflow-y-auto",
          )}
        >
          {part.text}
        </div>
      )}
    </div>
  )
}

function ToolBlock({
  part,
  onFileLink,
}: {
  part: Extract<Part, { type: "tool" }>
  onFileLink?: (href: string) => void
}) {
  const [open, setOpen] = useState(false)
  const meta = toolMeta(part)
  const Icon = meta.icon
  const status = part.state.status
  const summary = meta.summary(part)
  const output =
    typeof part.state.output === "string"
      ? part.state.output
      : part.state.output != null
        ? JSON.stringify(part.state.output, null, 2)
        : undefined

  return (
    <div className="group/tool my-1">
      <button
        type="button"
        className="hover:bg-muted/70 flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-md">
          <Icon className="text-muted-foreground size-3.5" />
        </span>
        <span className="text-foreground shrink-0 text-[13px] font-medium">{meta.label}</span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-[13px]">{summary}</span>
        <ToolStatusIcon status={status} />
      </button>
      {open && (
        <div className="bg-muted/40 mt-1 ml-[34px] overflow-hidden rounded-lg border">
          <ToolOutput
            text={output || JSON.stringify(part.state.input ?? {}, null, 2)}
            onFileLink={onFileLink}
          />
        </div>
      )}
    </div>
  )
}

/** 工具输出里的沙箱文件链接（file:///workspace/x.html）渲染为可点击按钮 */
const FILE_HREF_RE =
  /file:\/\/\/[^\s"'<>)\]，。；：、]+|(?<![\w:/.-])\/(?:workspace|root|tmp|home)\/[^\s"'<>)\]，。；：、`]+?\.(?:html?|md|png|jpe?g|gif|webp|svg|avif|ico|json|csv|txt|pdf)\b/gi

function ToolOutput({ text, onFileLink }: { text: string; onFileLink?: (href: string) => void }) {
  const nodes: React.ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  FILE_HREF_RE.lastIndex = 0
  while ((match = FILE_HREF_RE.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    const raw = match[0]
    const href = raw.startsWith("file://") ? raw : `file://${raw}`
    nodes.push(
      onFileLink ? (
        <button
          key={`${href}-${match.index}`}
          type="button"
          onClick={() => onFileLink(href)}
          className="text-foreground mx-0.5 inline underline decoration-border underline-offset-2 hover:decoration-foreground"
          title="点击预览沙箱文件"
        >
          {raw}
        </button>
      ) : (
        <span key={`${href}-${match.index}`}>{raw}</span>
      ),
    )
    cursor = match.index + href.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))

  return (
    <pre className="text-muted-foreground max-h-72 overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {nodes}
    </pre>
  )
}

function TextBlock({
  part,
  onFileLink,
}: {
  part: Extract<Part, { type: "text" }>
  onFileLink?: (href: string) => void
}) {
  if (!part.text?.trim()) return null
  return (
    <div className="my-1.5 first:mt-0">
      {part.synthetic && <Badge className="mr-1.5 align-middle text-[10px]">合成</Badge>}
      <Markdown content={part.text} onFileLink={onFileLink} />
    </div>
  )
}

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border border-transparent bg-secondary px-1.5 py-0.5 text-secondary-foreground",
        className,
      )}
    >
      {children}
    </span>
  )
}
