import { Schema } from "effect"
import type { Model } from "@opencode/schema/model"
import { saasCreateSession, saasFetch } from "./saas.js"

export type StructuredJob = { sessionId: string; promptId: string }
export type StructuredOutcome<S extends Schema.ConstraintDecoder<unknown, never>> =
  | { status: "pending" }
  | { status: "ready"; value: S["Type"] }
  | { status: "failed"; error: string }

/**
 * 结构化 AI 推理：在独立临时会话中执行，只返回符合 schema 的结果。
 * 不接触用户正在操作的会话，也不保留临时会话。
 */
export async function structured<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  text: string,
  model?: Model.Ref,
): Promise<S["Type"]> {
  const job = await startStructured(schema, text, model)
  try {
    return await collectStructuredUntil(schema, job, Number(process.env.STRUCTURED_AI_TIMEOUT_MS ?? 10 * 60 * 1000))
  } finally {
    await disposeStructured(job.sessionId)
  }
}

/** 发起一次结构化推理，返回可观察的临时会话与 promptId（不等待结果，便于前端实时订阅该会话）。 */
export async function startStructured<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  text: string,
  model?: Model.Ref,
): Promise<StructuredJob> {
  const doc = Schema.toJsonSchemaDocument(schema)
  const sessionId = await saasCreateSession({ directory: "/workspace", title: "自动化应用定义与修复" })
  const promptId = `msg_${crypto.randomUUID().replaceAll("-", "")}`
  const response = await saasFetch(`/api/session/${sessionId}/prompt`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: promptId,
      text,
      ...(model ? { model } : {}),
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
      format: { type: "json_schema", schema: { ...doc.schema, $defs: doc.definitions } },
    }),
  })
  if (!response.ok) {
    await disposeStructured(sessionId)
    throw new Error(`AI 请求失败（${response.status}）`)
  }
  await response.body?.cancel()
  return { sessionId, promptId }
}

/**
 * 把 provider 原始错误整理成一句可读、可操作的中文提示，不把内部 JSON 甩给用户。
 * 保留错误码供排查；额度/鉴权/限流等给出下一步动作。
 */
export function providerErrorSummary(raw: unknown): string {
  const error = (raw ?? {}) as Record<string, unknown>
  const nested = (error.error ?? error.data ?? {}) as Record<string, unknown>
  const message = typeof error.message === "string" ? error.message : typeof nested.message === "string" ? nested.message : ""
  const code = error.status ?? error.statusCode ?? nested.status ?? nested.statusCode
  const kind = `${String(error.type ?? "")} ${String(error.name ?? "")} ${message}`.toLowerCase()
  if (/quota|usage limit|rate.?limit|insufficient|429/.test(kind) || code === 429)
    return `模型额度已用完或触发限流（${code ?? 429}）。请切换模型或稍后再试，然后点「让 AI 修复此步」重试。`
  if (/auth|unauthorized|login|invalid.?key|401|403/.test(kind) || code === 401 || code === 403)
    return "模型未授权或密钥失效，请检查提供商登录状态后重试。"
  if (/timeout|overload|unavailable|5\d\d/.test(kind) || (typeof code === "number" && code >= 500))
    return `模型服务暂时不可用${code ? `（${code}）` : ""}，请稍后点「让 AI 修复此步」重试。`
  const brief = message.replace(/^https?:\/\/\S+\s*/g, "").trim().slice(0, 160)
  return brief ? `模型未能生成有效结果：${brief}${code ? `（${code}）` : ""}` : "模型未能生成有效结果，请稍后重试。"
}

/** 轮询一次结构化结果；未完成返回 pending，供上层继续等待。 */
export async function pollStructured<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  job: StructuredJob,
): Promise<StructuredOutcome<S>> {
  const result = await saasFetch(`/api/session/${job.sessionId}/message?order=desc&limit=100`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!result.ok) return { status: "pending" }
  const body = (await result.json()) as {
    data?: Array<{ type: string; promptMessageID?: string; structured?: unknown; error?: unknown; time?: { completed?: number } }>
  }
  const messages = body.data ?? []
  const answer = messages.find((m) => m.type === "assistant" && m.promptMessageID === job.promptId && m.structured !== undefined)
  if (answer) {
    try {
      return { status: "ready", value: Schema.decodeUnknownSync(schema)(answer.structured) }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { status: "failed", error: `AI 返回的结构不符合要求：${detail.slice(0, 300)}` }
    }
  }
  const failed = messages.find((m) => m.type === "assistant" && m.promptMessageID === job.promptId && m.error)
  if (failed) return { status: "failed", error: providerErrorSummary(failed.error) }
  return { status: "pending" }
}

/** 阻塞等待（供 repair 等无需实时观察的路径复用）。 */
async function collectStructuredUntil<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  job: StructuredJob,
  budgetMs: number,
): Promise<S["Type"]> {
  const end = Date.now() + budgetMs
  while (Date.now() < end) {
    const outcome = await pollStructured(schema, job)
    if (outcome.status === "ready") return outcome.value
    if (outcome.status === "failed") throw new Error(outcome.error)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error("AI 生成超时，请稍后重试")
}

/** 释放只用于推理的临时会话；清理失败不抛出，避免覆盖生成结果。 */
export async function disposeStructured(sessionId: string): Promise<void> {
  await saasFetch(`/api/session/${sessionId}/abort`, { method: "POST", signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
  await saasFetch(`/api/session/${sessionId}`, { method: "DELETE", signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
}

