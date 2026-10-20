import type { Message } from "@/types/opencode"

/**
 * 平台编排消息前缀。
 *
 * 需求创建编排（base-server `POST /api/requirements/prepare`）需要在沙箱里
 * 拉代码、切分支。V2 的 `session.shell` 只产生 shell 事件，不会进入会话时间线；
 * 但 legacy 协议会把 shell 记成一条 user 消息并触发一次 agent 工具调用。
 *
 * 为了让「创建需求/创建会话/准备工作区」这类系统操作在 chat 中不可见，
 * base-server 会给编排消息固定前缀 `msg_prepare_*`。前端在数据层统一过滤：
 * 前缀消息本身 + 由它触发的 assistant 消息（parentID 指向前缀消息）。
 */
export const SYSTEM_MESSAGE_PREFIX = "msg_prepare"

export function isSystemMessageID(id?: string): boolean {
  return Boolean(id?.startsWith(SYSTEM_MESSAGE_PREFIX))
}

/** 系统编排消息：编排 shell 本身，或由它触发的回复。 */
export function isSystemMessage(message: Message): boolean {
  if (isSystemMessageID(message.id)) return true
  return message.role === "assistant" && isSystemMessageID(message.parentID)
}

/**
 * legacy 协议的 shell 消息固定文案。
 *
 * V1/legacy 的 `POST /session/:id/shell` 会写入一条 user 消息，文本就是这句话，
 * 随后由 agent 真正执行命令。历史会话没有 `msg_prepare_*` 前缀，靠这句话兜底识别。
 */
export const LEGACY_SHELL_SENTINEL = "The following tool was executed by the user"

export function isLegacyShellText(text?: string): boolean {
  return text?.trim() === LEGACY_SHELL_SENTINEL
}
