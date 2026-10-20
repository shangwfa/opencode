/**
 * Prompt 数据模型类型（自 context/prompt.tsx 抽取）。
 * Solid 版的完整 store（327 行：persist / cursor / set）随会话壳迁移补齐；
 * 本模块先承载类型契约，供 composer 纯逻辑（build-request-parts / history 等）使用。
 */
import type { FileSelection } from "@/context/file"

interface PartBase {
  content: string
  start: number
  end: number
}

export interface TextPart extends PartBase {
  type: "text"
}

export interface FileAttachmentPart extends PartBase {
  type: "file"
  path: string
  selection?: FileSelection
}

export interface AgentPart extends PartBase {
  type: "agent"
  name: string
}

export interface MentionPart extends PartBase {
  type: "mention"
  id: string
  name: string
  nickName: string
  fsUserId: string
}

export interface SessionReferencePart extends PartBase {
  type: "session"
  sessionId: string
  title: string
}

export interface ImageAttachmentPart {
  type: "image"
  id: string
  filename: string
  mime: string
  dataUrl: string
  ossUrl?: string
  workspacePath?: string
  /** 上传失败标记（sync + OSS fallback 均失败时设为 true） */
  uploadError?: boolean
}

export type ContentPart =
  | TextPart
  | FileAttachmentPart
  | AgentPart
  | MentionPart
  | SessionReferencePart
  | ImageAttachmentPart
export type Prompt = ContentPart[]

export type FileContextItem = {
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export type ContextItem = FileContextItem

export const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]
