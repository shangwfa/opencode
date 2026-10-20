export const ATTACHMENT_MARKER = "[Attached file]"

export interface AttachmentInfo {
  filename: string
  url: string
  mime: string
  path?: string
}

export function buildAttachmentContextText(items: AttachmentInfo[]): string {
  if (!items.length) return ""

  const lines = [ATTACHMENT_MARKER, ""]
  items.forEach((item, index) => {
    if (index > 0) lines.push("")
    lines.push(`File ${index + 1}`)
    lines.push(`- name: ${item.filename}`)
    if (item.path) lines.push(`- path: ${item.path}`)
    lines.push(`- url: ${item.url}`)
    lines.push(`- mime: ${item.mime}`)
  })

  return lines.join("\n")
}

export function extractAttachmentContext(text: string): {
  mainText: string
  attachmentText?: string
} {
  const marker = ATTACHMENT_MARKER
  const idx = text.indexOf(`\n\n${marker}`)
  if (idx !== -1) {
    return {
      mainText: text.slice(0, idx),
      attachmentText: text.slice(idx + 2),
    }
  }
  if (text.startsWith(marker)) {
    return { mainText: "", attachmentText: text }
  }
  return { mainText: text }
}

export interface ParsedAttachmentNode {
  index: number
  name?: string
  url?: string
  mime?: string
  path?: string
}

export function parseAttachmentContextText(text: string): ParsedAttachmentNode[] | undefined {
  if (!text.startsWith(ATTACHMENT_MARKER)) return undefined

  const nodes: ParsedAttachmentNode[] = []
  const lines = text.split("\n")
  let currentNode: ParsedAttachmentNode | undefined

  for (const line of lines) {
    const nodeMatch = line.match(/^File (\d+)$/)
    if (nodeMatch) {
      if (currentNode) nodes.push(currentNode)
      currentNode = { index: parseInt(nodeMatch[1], 10) }
      continue
    }

    if (!currentNode) continue

    const fieldMatch = line.match(/^- ([\w-]+): (.*)$/)
    if (fieldMatch) {
      const [, key, value] = fieldMatch
      switch (key) {
        case "name":
          currentNode.name = value
          break
        case "url":
          currentNode.url = value
          break
        case "mime":
          currentNode.mime = value
          break
        case "path":
          currentNode.path = value
          break
      }
    }
  }

  if (currentNode) nodes.push(currentNode)
  return nodes.length > 0 ? nodes : undefined
}
