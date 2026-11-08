import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { errors } from "../../lib/errors.js"
import { saasFetch } from "../../lib/saas.js"

/** 读取探索会话的消息与模型；只读，不修改会话。 */
export async function sessionHistory(sessionId: string) {
  const response = await saasFetch(`/api/session/${encodeURIComponent(sessionId)}/message?order=desc&limit=100`)
  if (!response.ok) throw errors.upstream(502, "无法读取探索记录")
  const session = await saasFetch(`/api/session/${encodeURIComponent(sessionId)}`)
  if (!session.ok) throw errors.upstream(502, "无法读取探索会话模型")
  const sessionBody = (await session.json()) as { data?: { model?: unknown } }
  const history = (await response.json()) as { data?: Array<{ type?: string; model?: unknown }> }
  const candidate =
    sessionBody.data?.model ??
    history.data?.find((message) => message.type === "assistant" && message.model)?.model
  let model: Model.Ref | undefined
  try {
    if (candidate) model = Schema.decodeUnknownSync(Model.Ref)(candidate)
  } catch {
    // 旧消息模型不可解码时使用服务默认模型
  }
  return { history, model }
}
