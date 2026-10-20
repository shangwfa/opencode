/**
 * 会话引用 pill（React 版）。
 * 源：session-reference-adapter.ts；唯一 Solid 点是图标渲染（lucide-solid render）
 * → lucide-react + createRoot/flushSync 同步产出 DOM，pill 结构/序列化语义 1:1。
 */
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Cable } from "lucide-react"
import type { Prompt, SessionReferencePart } from "@/context/prompt"

export const SESSION_REFERENCE_PREFIX = "关联会话"
export const SESSION_REFERENCE_FALLBACK_TITLE = "未命名会话"

const SESSION_REFERENCE_PILL_CLASS =
  "mx-0.5 inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 align-middle text-[13px] font-medium bg-primary/10 text-primary"
const SESSION_REFERENCE_LABEL_CLASS = "max-w-64 truncate"

export type LucideIconProps = {
  size?: number
  strokeWidth?: number
  class?: string
  className?: string
  "aria-hidden"?: boolean | "true" | "false"
}

export function SessionReferenceIcon(props: LucideIconProps) {
  return <Cable size={props.size ?? 14} strokeWidth={props.strokeWidth ?? 2} className={props.class ?? props.className} aria-hidden={props["aria-hidden"]} />
}

export type SessionReferenceInput = {
  sessionId: string
  title?: string | null
}

export type SessionReferencePillOptions = {
  className?: string
  labelClassName?: string
  icon?: LucideIconProps
}

export type SessionReferenceElement = HTMLElement & {
  dataset: DOMStringMap & { type: "session" }
}

function createPart(input: SessionReferenceInput, start = 0): SessionReferencePart | undefined {
  const sessionId = input.sessionId.trim()
  if (!sessionId) return
  const title = input.title?.trim() || SESSION_REFERENCE_FALLBACK_TITLE
  return {
    type: "session",
    sessionId,
    title,
    content: title,
    start,
    end: start + title.length,
  }
}

function createIconElement(props: LucideIconProps = {}): Node | undefined {
  const host = document.createElement("span")
  const root = createRoot(host)
  flushSync(() => {
    root.render(<SessionReferenceIcon {...props} />)
  })
  const icon = host.firstElementChild?.cloneNode(true)
  root.unmount()
  return icon
}

function createPillElement(
  part: SessionReferencePart,
  options: SessionReferencePillOptions = {},
): HTMLElement | undefined {
  const normalized = createPart(part, part.start)
  if (!normalized) return

  const pill = document.createElement("span")
  pill.dataset.type = "session"
  pill.dataset.sessionId = normalized.sessionId
  pill.dataset.title = normalized.title
  pill.setAttribute("aria-label", `关联会话：${pill.dataset.title}`)
  pill.title = `${pill.dataset.title} (${pill.dataset.sessionId})`
  pill.className = options.className ?? SESSION_REFERENCE_PILL_CLASS
  pill.contentEditable = "false"
  pill.style.userSelect = "text"
  pill.style.cursor = "default"

  const icon = createIconElement({ class: "size-3.5 shrink-0", "aria-hidden": true, ...options.icon })
  if (icon) pill.append(icon)

  const label = document.createElement("span")
  label.className = options.labelClassName ?? SESSION_REFERENCE_LABEL_CLASS
  label.textContent = pill.dataset.title
  pill.append(label)
  return pill
}

function isElement(node: Node): node is SessionReferenceElement {
  return node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.type === "session"
}

function parseElement(element: HTMLElement, start = 0): SessionReferencePart | undefined {
  if (!isElement(element)) return
  return createPart(
    {
      sessionId: element.dataset.sessionId ?? "",
      title: element.dataset.title || element.textContent,
    },
    start,
  )
}

function serialize(part: Pick<SessionReferencePart, "sessionId">): string {
  const sessionId = part.sessionId.trim()
  return sessionId ? `${SESSION_REFERENCE_PREFIX} ${sessionId}:` : ""
}

export const sessionReferenceAdapter = {
  createPart,
  createPillElement,
  isElement,
  parseElement,
  serialize,
}

export const formatSessionReference = serialize

export function serializePromptText(prompt: Prompt): string {
  return prompt
    .map((part) => {
      if (part.type === "image") return ""
      if (part.type === "session") return sessionReferenceAdapter.serialize(part)
      return part.content
    })
    .join("")
}
