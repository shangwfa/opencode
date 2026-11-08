import type { AutomationInstruction as I } from "@opencode/schema/automation-instruction"
import { errors } from "../../lib/errors.js"
import { saasFetch } from "../../lib/saas.js"
import { instructionStepPrompt } from "./contract.js"

export type Progress =
  | { state: "pending" }
  | { state: "succeeded"; output: string }
  | { state: "failed"; error: string; interrupted?: boolean }

/** 每次运行使用独立的结果路径，不把上次遗留的文件当作本次产物。 */
export function runVerificationPath(runId: string, path: string) {
  if (!/^irun_[a-zA-Z0-9-]+$/.test(runId)) throw new Error("运行编号无效")
  return `output/automation/${runId}/${path}`
}

type Message = {
  type?: string
  promptMessageID?: string
  content?: Array<{ type?: string; text?: string }>
  error?: unknown
  finish?: string
  time?: { created?: number; completed?: number }
}

/**
 * 指令由会话中的 AI 执行，工具权限沿用会话配置。
 * promptId 是本次运行的唯一归属，避免把同一会话其他轮次的结果算进本应用。
 * 每次只派发一个步骤，步骤之间由 worker 串行推进。
 */
export async function sendInstructionPrompt(
  sessionId: string,
  definition: I.Definition,
  instruction: I.Instruction,
  index: number,
  total: number,
  parameters: Record<string, string>,
  promptId: string,
  runId: string,
) {
  const artifact = definition.verification
    ? `如本步骤需要产出校验文件，请写入 /workspace/${runVerificationPath(runId, definition.verification.path)}。`
    : ""
  const response = await saasFetch(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: promptId,
      text: instructionStepPrompt(definition, instruction, index, total, parameters, artifact),
      // 运行已按应用定义逐步执行，不再逐条询问工具权限；
      // 高风险业务动作在发起运行前由用户在界面上确认（requiresConfirmation）。
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      ...(definition.model ? { model: definition.model } : {}),
    }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw errors.upstream(502, `无法启动应用执行（${response.status}）：${text.slice(0, 200)}`)
  }
  await response.body?.cancel()
  return promptId
}

/** 只读最近消息并按 promptMessageID 归属；工具未结算时可能暂时没有完成时间。 */
export function readProgress(messages: readonly Message[], promptId: string): Progress {
  const candidates = messages
    .filter((item) => item.type === "assistant" && item.promptMessageID === promptId)
    .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))
  const message = candidates[0]
  if (!message) return { state: "pending" }
  if (message.error) {
    // 中断/看门狗中止不是应用缺陷：只结束本次运行，交给调用方决定是否重试。
    const interrupted = (message.error as { type?: string })?.type === "aborted"
    return { state: "failed", error: JSON.stringify(message.error).slice(0, 4000), interrupted }
  }
  if (!message.time?.completed) return { state: "pending" }
  // 同一轮可能产生多条 assistant 消息（每次工具调用一条）；tool-calls 表示回合未结束。
  if (message.finish === "tool-calls") return { state: "pending" }
  const output = (message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("\n\n")
    .trim()
  return { state: "succeeded", output: output.slice(0, 32_000) || "执行完成，但没有返回文字结果" }
}

/** 会话整体失败（例如模型额度或上游错误）时没有 assistant 归属消息，也必须结束运行。 */
export function failureFromSession(
  messages: readonly Message[],
  outcome: string | undefined,
  since: number,
): { error: string; interrupted: boolean } | undefined {
  if (outcome !== "failed" && outcome !== "interrupted") return undefined
  const interrupted = outcome === "interrupted"
  const failed = messages
    .filter((item) => item.error && (item.time?.created ?? 0) >= since)
    .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))[0]
  const fallback = interrupted ? "执行被用户中断，未自动重试" : "会话执行失败"
  return { error: failed ? JSON.stringify(failed.error).slice(0, 4000) : fallback, interrupted }
}

/** 读取 /workspace 内的产物文本；不存在返回 null，供结果校验使用。 */
export async function readSessionFile(sessionId: string, path: string) {
  const encoded = path.split("/").map(encodeURIComponent).join("/")
  const response = await saasFetch(`/api/session/${encodeURIComponent(sessionId)}/fs/read/${encoded}`, {
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) return null
  return (await response.text()).slice(0, 64 * 1024)
}

export async function pollProgress(sessionId: string, promptId: string, since = 0) {
  const response = await saasFetch(
    `/api/session/${encodeURIComponent(sessionId)}/message?order=desc&limit=100`,
    { signal: AbortSignal.timeout(10_000) },
  )
  if (!response.ok) throw new Error(`无法读取执行进度（${response.status}）`)
  const body = (await response.json()) as { data?: Message[] }
  const messages = body.data ?? []
  const progress = readProgress(messages, promptId)
  if (progress.state !== "pending") return progress
  const session = await saasFetch(`/api/session/${encodeURIComponent(sessionId)}`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!session.ok) return progress
  const outcome = ((await session.json()) as { data?: { outcome?: string } }).data?.outcome
  const failure = failureFromSession(messages, outcome, since)
  return failure ? ({ state: "failed", ...failure } as const) : progress
}
