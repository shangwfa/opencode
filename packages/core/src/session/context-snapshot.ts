import { createHash } from "node:crypto"
import type { ContentPart, LLMRequest, ToolEntry } from "@opencode/ai"
import { SessionContextInsights } from "@opencode/schema/session-context-insights"

export const MaxItemBytes = 256 * 1024
export const MaxSnapshotBytes = 4 * 1024 * 1024
export const MaxItems = 2000

const json = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** Metadata the browser needs to render a part without opening its body. */
const partMeta = (
  part: ContentPart,
): { media?: NonNullable<SessionContextInsights.Item["media"]>; tool?: NonNullable<SessionContextInsights.Item["tool"]> } => {
  if (part.type === "media") return { media: { mediaType: part.mediaType, ...(part.filename === undefined ? {} : { filename: part.filename }) } }
  if (part.type === "tool-call") return { tool: { name: part.name, callID: part.id } }
  if (part.type === "tool-result")
    return { tool: { name: part.name, callID: part.id, ...(part.result.type === "error" ? { failed: true } : {}) } }
  return {}
}

const projectPart = (part: ContentPart): { value: unknown; opaque: boolean } => {
  switch (part.type) {
    case "text":
      return { value: { type: part.type, text: part.text }, opaque: false }
    case "reasoning":
      return { value: { type: part.type, text: part.text }, opaque: part.encrypted !== undefined }
    case "media":
      return { value: { type: part.type, mediaType: part.mediaType, filename: part.filename }, opaque: true }
    case "compaction":
      return {
        value: { type: part.type, provider: part.provider, text: part.text },
        opaque: part.encrypted !== undefined,
      }
    case "effort":
      return { value: { type: part.type, effort: part.effort, previous: part.previous }, opaque: false }
    case "tool-call":
      return {
        value: { type: part.type, id: part.id, name: part.name, namespace: part.namespace, input: part.input },
        opaque: false,
      }
    case "tool-result": {
      if (part.result.type !== "content")
        return { value: { type: part.type, id: part.id, name: part.name, result: part.result }, opaque: false }
      let opaque = false
      const value = part.result.value.map((content) => {
        if (content.type === "text") return { type: content.type, text: content.text }
        opaque = true
        return { type: content.type, mime: content.mime, name: content.name }
      })
      return { value: { type: part.type, id: part.id, name: part.name, result: { type: "content", value } }, opaque }
    }
  }
}

export interface Snapshot {
  readonly items: ReadonlyArray<SessionContextInsights.Item>
  readonly contents: ReadonlyMap<string, string>
  readonly composition: SessionContextInsights.Composition
  readonly estimatedTokens: number
  readonly incomplete: boolean
}

/**
 * The skill catalog is rendered by our own SkillInstructions layer. Both markers must be present,
 * so prompt text that merely quotes one of them is not relabelled.
 */
const skillCatalog = (text: string | undefined) =>
  text !== undefined &&
  text.includes("Skills provide specialized instructions and workflows for specific tasks.") &&
  text.includes("<available_skills>")

/** This is the semantic model call, not provider-native wire data or an exact tokenizer. */
export const snapshot = (
  request: LLMRequest,
  source?: (name: string) => string | undefined,
): Snapshot => {
  const items: SessionContextInsights.Item[] = []
  const contents = new Map<string, string>()
  const composition = { system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0 }
  let bytesKept = 0
  let incomplete = false
  const add = (
    category: SessionContextInsights.Category,
    name: string,
    text: string | undefined,
    opaque = false,
    source?: string,
    origin?: SessionContextInsights.Item["origin"],
    meta: ReturnType<typeof partMeta> = {},
  ) => {
    if (items.length >= MaxItems) {
      incomplete = true
      return
    }
    const estimatedTokens = text === undefined ? 0 : Math.ceil(text.length / 4) + 4
    const bytes = text === undefined ? 0 : Buffer.byteLength(text)
    const hash = text === undefined ? undefined : createHash("sha256").update(text).digest("hex")
    const tooLarge =
      bytes > MaxItemBytes || (hash !== undefined && !contents.has(hash) && bytesKept + bytes > MaxSnapshotBytes)
    const omitted =
      text === undefined ? "unsupported-content" : tooLarge ? "size-limit" : opaque ? "opaque-content" : undefined
    incomplete ||= omitted !== undefined
    composition[category] += estimatedTokens
    items.push({
      index: items.length,
      category,
      name,
      estimatedTokens,
      bytes,
      ...(hash !== undefined && !tooLarge ? { hash } : {}),
      ...(omitted === undefined ? {} : { omitted }),
      ...(source === undefined ? {} : { source }),
      ...(origin === undefined ? {} : { origin }),
      ...meta,
    })
    if (hash !== undefined && text !== undefined && !tooLarge && !contents.has(hash)) {
      contents.set(hash, text)
      bytesKept += bytes
    }
  }

  for (const [index, part] of request.system.entries())
    add("system", `system:${index}`, part.text, false, undefined, skillCatalog(part.text) ? "skills" : undefined)
  const tools = (entries: ReadonlyArray<ToolEntry>, namespace = "") => {
    for (const tool of entries) {
      if (tool.type === "namespace") {
        add("tools", `${namespace}${tool.name}`, json({ name: tool.name, description: tool.description }))
        tools(tool.tools, `${namespace}${tool.name}.`)
      } else {
        add(
          "tools",
          `${namespace}${tool.name}`,
          json({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
          }),
          false,
          source?.(`${namespace}${tool.name}`),
        )
      }
    }
  }
  tools(request.tools)
  for (const [messageIndex, message] of request.messages.entries()) {
    const category = message.role === "system" ? "inject" : message.role
    for (const [partIndex, part] of message.content.entries()) {
      const projected = projectPart(part)
      const body = json(projected.value)
      add(
        category,
        `message:${messageIndex}:${partIndex}:${part.type}`,
        body,
        projected.opaque,
        undefined,
        category === "inject" && skillCatalog(body) ? "skills" : undefined,
        partMeta(part),
      )
    }
    if (message.native !== undefined) incomplete = true
  }
  return {
    items,
    contents,
    composition,
    estimatedTokens: Object.values(composition).reduce((a, b) => a + b, 0),
    incomplete,
  }
}
