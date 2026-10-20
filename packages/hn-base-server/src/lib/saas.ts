/**
 * opencode SaaS 客户端（服务级凭证）。
 * SaaS 仅内网可达；base-server 是唯一调用方。
 *
 * 创建会话：POST /api/session（{data:{id}}）
 * 沙箱命令：POST /api/session/:id/shell（{command}），结果在
 *           GET /api/experimental/session/:id/log 的 shell.ended 事件（exit 与 output 同级）
 */
import { env } from "../config/env.js"
import { errors } from "./errors.js"

function authHeader(): string {
  const raw = `opencode:${env.saasPassword}`
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`
}

export async function saasFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set("authorization", authHeader())
  try {
    return await fetch(`${env.saasUrl.replace(/\/+$/, "")}${path}`, { ...init, headers })
  } catch (error) {
    throw errors.internal(`无法连接执行服务：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function saasJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await saasFetch(path, init)
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`SaaS ${path} 返回 ${res.status}: ${text.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

/** 会话元信息（SaaS 的 Session 结构，只取我们需要的字段） */
export type SaasSession = {
  id: string
  title?: string | null
  parentID?: string | null
  directory?: string
  time?: { created?: number; updated?: number }
  [key: string]: unknown
}

function isJson(res: Response): boolean {
  const type = (res.headers.get("content-type") ?? "").toLowerCase()
  return type.includes("application/json")
}

export { isJson }

/** 创建会话：V2 优先，legacy 回退 */
export async function saasCreateSession(input: {
  directory: string
  title?: string
  agent?: string
}): Promise<string> {
  // directory 只认 body.location：query 会被忽略，回落到镜像默认目录
  // /app/packages/opencode，导致 shell/文件工具与预期工作区不一致
  const body = JSON.stringify({
    ...(input.title ? { title: input.title } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    location: { directory: input.directory },
  })

  const v2 = await saasFetch(`/api/session?directory=${encodeURIComponent(input.directory)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
  if (v2.ok && isJson(v2)) {
    const data = (await v2.json().catch(() => null)) as { data?: { id?: string }; id?: string } | null
    const id = data?.data?.id ?? data?.id
    if (id) return id
  }
  const text = await v2.text().catch(() => "")
  throw errors.internal(`创建会话失败（${v2.status}）：${text.slice(0, 160)}`)
}

/** V1 消息体（网关入参） */
export type V1MessageBody = {
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean }>
  agent?: string
  model?: { providerID: string; modelID: string }
  messageID?: string
  [key: string]: unknown
}

/** `session.prompt` 只认 `{ text, ... }`，不接受 parts 数组；text 按序合并（含隐藏上下文）。 */
export function toV2PromptBody(body: V1MessageBody): Record<string, unknown> {
  const texts = (body.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
  return {
    ...(body.messageID ? { id: body.messageID } : {}),
    ...(texts.length > 0 ? { text: texts.join("\n\n") } : {}),
    // 模型引用：Model.Ref 是 { id, providerID }，网关入参的 modelID 需换名
    ...(body.model ? { model: { id: body.model.modelID, providerID: body.model.providerID } } : {}),
  }
}

type ShellEnded = { status?: string; exit?: number; output?: { output?: string } }

/** 轮询 V2 session.log，等待指定命令的 shell.ended（最多 90s） */
async function waitForShellEndV2(
  sessionId: string,
  command: string,
  timeoutMs = 90_000,
): Promise<ShellEnded | undefined> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await saasFetch(
        `/api/experimental/session/${encodeURIComponent(sessionId)}/log?follow=false&after=0`,
      )
      if (res.ok && !(res.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
        // replay 可能以 SSE 返回，也可能是 JSON 数组
        const text = await res.text()
        const events: Array<{ type?: string; data?: { shell?: ShellEnded & { command?: string }; output?: { output?: string } } }> = []
        const trimmed = text.trim()
        if (trimmed.startsWith("[")) {
          try {
            events.push(...(JSON.parse(trimmed) as typeof events))
          } catch {
            /* ignore */
          }
        } else {
          for (const line of text.split("\n")) {
            if (!line.startsWith("data:")) continue
            try {
              events.push(JSON.parse(line.slice(5).trim()))
            } catch {
              /* 忽略非 JSON 心跳 */
            }
          }
        }
        const ended = events.find(
          (event) => event.type === "session.shell.ended" && event.data?.shell?.command === command,
        )
        if (ended?.data?.shell) return { ...ended.data.shell, output: ended.data.output }
      }
    } catch {
      /* 网络抖动，继续重试 */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return undefined
}

/**
 * 在会话工作目录执行一条 shell 命令。
 * 沙箱命令在会话沙箱内执行；绝不落到 SaaS 宿主文件系统。
 */
export async function saasRunShell(
  sessionId: string,
  command: string,
  options: { agent?: string; successMarker?: string; messageID?: string } = {},
): Promise<{ exit: number; output: string }> {
  // V2
  const v2 = await saasFetch(`/api/session/${encodeURIComponent(sessionId)}/shell`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(options.messageID ? { id: options.messageID } : {}),
      command,
    }),
  })
  if (v2.ok && !(v2.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
    const ended = await waitForShellEndV2(sessionId, command)
    if (ended) {
      return { exit: typeof ended.exit === "number" ? ended.exit : 1, output: ended.output?.output ?? "" }
    }
    throw errors.internal("沙箱命令已提交，但未取得执行结果")
  }

  // legacy shell 在旧镜像中使用 SaaS 本地进程，不能用于会话沙箱初始化。
  throw errors.internal("执行服务沙箱命令接口不可用，命令未执行")

}
