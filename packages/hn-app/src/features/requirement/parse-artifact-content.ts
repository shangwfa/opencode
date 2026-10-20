import type { FileContent } from "@/types/opencode"

const partText = (value: unknown) => {
  if (!value || typeof value !== "object") return ""
  const part = value as Record<string, unknown>
  if (part.type !== "text") return ""
  if (typeof part.text === "string") return part.text
  if (typeof part.content === "string") return part.content
  return ""
}

const fromObject = (obj: Record<string, unknown>): string | undefined => {
  if (obj.type === "text" && typeof obj.content === "string") return obj.content
  if (typeof obj.content === "string" && !obj.type) return obj.content
  if (Array.isArray(obj.parts)) {
    const text = obj.parts.map(partText).filter(Boolean).join("\n\n")
    if (text) return text
  }
  return undefined
}

/** Normalize file/API body into markdown plain text for artifact display. */
export function parseArtifactContent(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ""

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return raw

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed === "string") return parsed
    if (Array.isArray(parsed)) {
      const text = parsed.map(partText).filter(Boolean).join("\n\n")
      if (text) return text
      return raw
    }
    if (parsed && typeof parsed === "object") {
      const text = fromObject(parsed as Record<string, unknown>)
      if (text !== undefined) return text
    }
  } catch {
    return raw
  }

  return raw
}

export function fileContentToMarkdown(data: FileContent | undefined): string | undefined {
  if (!data) return undefined
  if (data.type === "binary") return undefined
  return parseArtifactContent(data.content)
}
