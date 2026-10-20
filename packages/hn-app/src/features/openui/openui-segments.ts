import { isOpenUIRenderingEnabled } from "./openui-render-preference"

export type OpenUIMessageSegment =
  | { type: "markdown"; content: string }
  | { type: "openui"; content: string; raw: string; closed: boolean }

const OPEN_FENCE = /^[ \t]{0,3}```(?:openui-lang|openui)[ \t]*(?:\r?\n|$)/gim

export function splitOpenUIMessage(text: string, options?: { streaming?: boolean }): OpenUIMessageSegment[] {
  const segments: OpenUIMessageSegment[] = []
  let cursor = 0
  OPEN_FENCE.lastIndex = 0

  while (cursor < text.length) {
    OPEN_FENCE.lastIndex = cursor
    const opening = OPEN_FENCE.exec(text)
    if (!opening) {
      const content = text.slice(cursor)
      if (content) segments.push({ type: "markdown", content })
      break
    }

    const before = text.slice(cursor, opening.index)
    if (before) segments.push({ type: "markdown", content: before })

    const contentStart = OPEN_FENCE.lastIndex
    const close = text.indexOf("```", contentStart)
    if (close === -1) {
      segments.push({
        type: "openui",
        content: text.slice(contentStart),
        raw: text.slice(opening.index),
        closed: false,
      })
      cursor = text.length
      break
    }

    const end = close + 3
    segments.push({
      type: "openui",
      content: text.slice(contentStart, close),
      raw: text.slice(opening.index, end),
      closed: true,
    })
    cursor = end
  }

  if (options?.streaming) {
    return segments.filter((segment, index) => {
      if (segment.type !== "markdown") return true
      const previous = segments[index - 1]
      if (previous?.type !== "openui" || !previous.closed) return true
      const candidate = segment.content.trim()
      return !candidate || !previous.content.trimEnd().endsWith(candidate)
    })
  }

  return segments.length ? segments : [{ type: "markdown", content: text }]
}

export function hasOpenUIFence(text: string) {
  OPEN_FENCE.lastIndex = 0
  return OPEN_FENCE.test(text)
}

export function shouldRenderOpenUIMessage(role: "assistant" | "user", text: string) {
  return isOpenUIRenderingEnabled() && role === "assistant" && hasOpenUIFence(text)
}

function compactFirstLine(source: string) {
  return (source.split(/\r?\n/, 1)[0] ?? "").replace(/\s/g, "")
}

export function isOfficialOpenUIRoot(source: string) {
  return compactFirstLine(source).startsWith("root=Card(")
}

export function canBecomeOfficialOpenUIRoot(source: string) {
  const line = compactFirstLine(source)
  if (!line) return true
  return "root=Card(".startsWith(line) || line.startsWith("root=Card(")
}
