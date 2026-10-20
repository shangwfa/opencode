/**
 * 聊天发送管线（React 版，纯 REST）。
 * 源：xybot-front-opencode-ui src/components/prompt-input/submit.ts 的 sendFollowupDraft。
 * 语义 1:1：slash 命令走 POST /session/{id}/command；普通消息走
 * POST /session/{id}/prompt_async（乐观插入用户消息 + parts，失败回滚 + busy/idle 状态切换）。
 * [MIGRATION] 上游 worktree / 新会话创建 / 排队（shouldQueue）路径属上游会话壳，随会话壳迁移。
 */
import type { Message, Part } from "@/types/opencode"
import { Identifier } from "@/utils/id"
import { buildRequestParts } from "./build-request-parts"
import { isInlineSupportedMime } from "./files"
import type { ContextItem, ImageAttachmentPart, Prompt } from "@/context/prompt"
import { attachArtifactCausedByMessageId } from "@/features/requirement/artifact-generation-context"
import { serializePromptText } from "./session-reference-adapter"
import { sessionPromptAsync, sessionCommand, sessionAbort } from "@/lib/rest"

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  selectionContextText?: string
  runtimeContextText?: string
}

export type FollowupSendInput = {
  /** REST 封装注入（便于测试替换） */
  client: {
    promptAsync: typeof sessionPromptAsync
    command: typeof sessionCommand
  }
  data: {
    optimisticAdd: (input: { sessionID: string; message: Message; parts: Part[] }) => void
    optimisticRemove: (input: { sessionID: string; messageID: string }) => void
    setSessionStatus: (sessionID: string, status: { type: "busy" | "idle" }) => void
    /** 可选：slash 命令表（有命令匹配时走 session.command） */
    commands?: { name: string }[]
  }
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
  userInfo?: { userName: string; userId: string }
  noReply?: boolean
}

const draftImages = (prompt: Prompt) =>
  prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

function parseSlashCommand(text: string) {
  const match = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
  if (!match) return
  return {
    name: match[1],
    arguments: match[2] ?? "",
  }
}

export async function sendFollowupDraft(input: FollowupSendInput): Promise<boolean> {
  const text = serializePromptText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const syntheticText =
    input.draft.selectionContextText?.trim() && !text.trimStart().startsWith("/")
      ? input.draft.selectionContextText.trim()
      : undefined

  const setBusy = () => {
    if (!input.optimisticBusy) return
    input.data.setSessionStatus(input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    input.data.setSessionStatus(input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const parsedCommand = parseSlashCommand(text)
  const cmd = parsedCommand?.name
  if (cmd && parsedCommand && input.data.commands?.some((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

      await input.client.command(
        input.draft.sessionID,
        {
          command: cmd,
          arguments: parsedCommand.arguments,
          agent: input.draft.agent,
          model: `${input.draft.model.providerID}/${input.draft.model.modelID}`,
          variant: input.draft.variant,
          parts: images
            .filter((a) => a.dataUrl && isInlineSupportedMime(a.mime))
            .map((attachment) => ({
              id: Identifier.ascending("part"),
              type: "file" as const,
              mime: attachment.mime,
              url: attachment.dataUrl,
              filename: attachment.filename,
            })),
        },
        { directory: input.draft.sessionDirectory },
      )
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const runtimeContextText = attachArtifactCausedByMessageId(
    input.draft.runtimeContextText,
    messageID,
  )
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    text,
    syntheticText,
    runtimeContextText,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  } as Message

  const add = () =>
    input.data.optimisticAdd({
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.data.optimisticRemove({
      sessionID: input.draft.sessionID,
      messageID,
    })

  setBusy()
  add()

  try {
    if (!(await wait())) {
      setIdle()
      remove()
      return false
    }

    if (input.userInfo) {
      // SaaS 通道（携带用户身份）：prompt_async REST 接口
      await sessionPromptAsync(
        input.draft.sessionID,
        {
          parts: requestParts,
          model: input.draft.model,
          agent: input.draft.agent,
          messageID,
          variant: input.draft.variant,
          userName: input.userInfo.userName,
          userId: input.userInfo.userId,
          noReply: input.noReply,
        },
        { directory: input.draft.sessionDirectory },
      )
    } else {
      await input.client.promptAsync(
        input.draft.sessionID,
        {
          agent: input.draft.agent,
          model: input.draft.model,
          messageID,
          parts: requestParts,
          variant: input.draft.variant,
          noReply: input.noReply,
        },
        { directory: input.draft.sessionDirectory },
      )
    }
    if (input.noReply) {
      input.data.setSessionStatus(input.draft.sessionID, { type: "idle" })
    }
    return true
  } catch (err) {
    setIdle()
    remove()
    throw err
  }
}

/** abort（POST /session/{id}/abort；失败静默，对齐源 .catch(() => {})） */
export async function abortSession(sessionID: string, opts: { directory?: string } = {}) {
  if (!sessionID) return
  try {
    await sessionAbort(sessionID, opts)
  } catch {
    // 静默
  }
}
