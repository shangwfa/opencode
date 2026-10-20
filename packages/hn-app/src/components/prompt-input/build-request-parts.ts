import { getFilename } from "@/shared/util/path"
import { type AgentPartInput, type FilePartInput, type Part, type TextPartInput } from "@/types/opencode"
import type { FileSelection } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import type { AgentPart, FileAttachmentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"
import { Identifier } from "@/utils/id"
import { createCommentMetadata, formatCommentNote } from "@/utils/comment-note"
import { buildAttachmentContextText } from "@/features/requirement/attachments/build-attachment-context-text"
import { resolveSandboxPath } from "@/api/requirement/sandbox-file"
import { isInlineSupportedMime } from "./files"

type PromptRequestPart = (TextPartInput | FilePartInput | AgentPartInput) & { id: string }

type ContextFile = {
  key: string
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

type BuildRequestPartsInput = {
  prompt: Prompt
  context: ContextFile[]
  images: ImageAttachmentPart[]
  text: string
  syntheticText?: string
  runtimeContextText?: string
  messageID: string
  sessionID: string
  sessionDirectory: string
}

  const fileQuery = (selection: FileSelection | undefined) =>
  selection ? `?start=${selection.startLine}&end=${selection.endLine}` : ""

const mention = /(^|[\s([{"'])@(\S+)/g

const parseCommentMentions = (comment: string) => {
  return Array.from(comment.matchAll(mention)).flatMap((match) => {
    const path = (match[2] ?? "").replace(/[.,!?;:)}\]"']+$/, "")
    if (!path) return []
    return [path]
  })
}

const isFileAttachment = (part: Prompt[number]): part is FileAttachmentPart => part.type === "file"
const isAgentAttachment = (part: Prompt[number]): part is AgentPart => part.type === "agent"

const toOptimisticPart = (part: PromptRequestPart, sessionID: string, messageID: string): Part => {
  if (part.type === "text") {
    return {
      id: part.id,
      type: "text",
      text: part.text,
      synthetic: part.synthetic,
      ignored: part.ignored,
      time: part.time,
      metadata: part.metadata,
      sessionID,
      messageID,
    }
  }
  if (part.type === "file") {
    return {
      id: part.id,
      type: "file",
      mime: part.mime,
      filename: part.filename,
      url: part.url,
      source: part.source,
      sessionID,
      messageID,
    }
  }
  return {
    id: part.id,
    type: "agent",
    name: part.name,
    source: part.source,
    sessionID,
    messageID,
  }
}

export function buildRequestParts(input: BuildRequestPartsInput) {
  const requestParts: PromptRequestPart[] = []

  const ossAttachments = input.images.filter((a) => !!a.ossUrl)

  const attachmentContextText = buildAttachmentContextText(
    ossAttachments.map((a) => ({
      filename: a.filename,
      url: a.ossUrl!,
      mime: a.mime,
      // [P0-2] 用 sessionDirectory 而非硬编码 /workspace，适配 worktree 等非默认路径
      path: a.workspacePath ? resolveSandboxPath(input.sessionDirectory, a.workspacePath) : undefined,
    })),
  )

  const combinedSynthetic = [input.syntheticText?.trim(), attachmentContextText]
    .filter(Boolean)
    .join("\n\n")
  const contextText = combinedSynthetic || undefined

  const text = contextText
    ? input.text.trim()
      ? `${input.text}\n\n${contextText}`
      : contextText
    : input.text

  requestParts.push({
    id: Identifier.ascending("part"),
    type: "text",
    text,
  })

  const runtimeContextText = input.runtimeContextText?.trim()
  if (runtimeContextText) {
    requestParts.push({
      id: Identifier.ascending("part"),
      type: "text",
      text: runtimeContextText,
      synthetic: true,
    })
  }

  const files = input.prompt.filter(isFileAttachment).map((attachment) => {
    const path = resolveSandboxPath(input.sessionDirectory, attachment.path)
    return {
      id: Identifier.ascending("part"),
      type: "file",
      mime: "text/plain",
      url: `file://${encodeFilePath(path)}${fileQuery(attachment.selection)}`,
      filename: getFilename(attachment.path),
      source: {
        type: "file",
        text: {
          value: attachment.content,
          start: attachment.start,
          end: attachment.end,
        },
        path,
      },
    } satisfies PromptRequestPart
  })

  const agents = input.prompt.filter(isAgentAttachment).map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "agent",
      name: attachment.name,
      source: {
        value: attachment.content,
        start: attachment.start,
        end: attachment.end,
      },
    } satisfies PromptRequestPart
  })

  const used = new Set(files.map((part) => part.url))
  const context = input.context.flatMap((item) => {
    const path = resolveSandboxPath(input.sessionDirectory, item.path)
    const url = `file://${encodeFilePath(path)}${fileQuery(item.selection)}`
    const comment = item.comment?.trim()
    if (!comment && used.has(url)) return []
    used.add(url)

    const filePart = {
      id: Identifier.ascending("part"),
      type: "file",
      mime: "text/plain",
      url,
      filename: getFilename(item.path),
    } satisfies PromptRequestPart

    if (!comment) return [filePart]

    const mentions = parseCommentMentions(comment).flatMap((path) => {
      const url = `file://${encodeFilePath(resolveSandboxPath(input.sessionDirectory, path))}`
      if (used.has(url)) return []
      used.add(url)
      return [
        {
          id: Identifier.ascending("part"),
          type: "file",
          mime: "text/plain",
          url,
          filename: getFilename(path),
        } satisfies PromptRequestPart,
      ]
    })

    return [
      {
        id: Identifier.ascending("part"),
        type: "text",
        text: formatCommentNote({ path: item.path, selection: item.selection, comment }),
        synthetic: true,
        metadata: createCommentMetadata({
          path: item.path,
          selection: item.selection,
          comment,
          preview: item.preview,
          origin: item.commentOrigin,
        }),
      } satisfies PromptRequestPart,
      filePart,
      ...mentions,
    ]
  })

  const images = input.images
    .filter((attachment) => attachment.dataUrl && isInlineSupportedMime(attachment.mime))
    .map((attachment) => {
      return {
        id: Identifier.ascending("part"),
        type: "file",
        mime: attachment.mime,
        url: attachment.dataUrl,
        filename: attachment.filename,
      } satisfies PromptRequestPart
    })

  requestParts.push(...files, ...context, ...agents, ...images)

  return {
    requestParts,
    optimisticParts: requestParts.map((part) => toOptimisticPart(part, input.sessionID, input.messageID)),
  }
}
