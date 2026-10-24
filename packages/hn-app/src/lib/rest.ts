/**
 * OpenCode SaaS REST 客户端（去 SDK 化，直连 REST API）。
 * 端点：GET /session/{id}/message · POST /session/{id}/prompt_async ·
 *       POST /session/{id}/abort · POST /session/{id}/command ·
 *       GET /event（SSE）· GET /file/content · GET /provider
 * 所有请求自动带 directory 查询参数（沙箱工作目录）。
 */
import { opencodeSaasBaseUrl } from "@/utils/opencode-saas-base"
import { authEnabled } from "./auth"
import { timelineMessages, type SessionMessage } from "./session-messages"
import { baseFetchRaw } from "./base-api"

export function restBaseUrl(): string {
  return opencodeSaasBaseUrl().replace(/\/+$/, "")
}

export type RestOptions = {
  directory?: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  method?: "GET" | "POST" | "PUT" | "DELETE"
  signal?: AbortSignal
}

export function restUrl(path: string, opts: RestOptions = {}): string {
  const url = new URL(`${restBaseUrl()}${path}`)
  if (opts.directory) url.searchParams.set("directory", opts.directory)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

export async function rest<T = unknown>(
  path: string,
  opts: RestOptions = {},
): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET")
  const res = await fetch(restUrl(path, opts), {
    method,
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`OpenCode API ${method} ${path} 失败: ${res.status} ${text}`)
  }
  // 部分端点（prompt_async/abort 等）返回空 body
  const text = await res.text().catch(() => "")
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

// ── 业务封装 ──
// ── 会话管理 ──

export async function sessionCreate(opts: { directory?: string; body?: Record<string, unknown> } = {}) {
  // V2 统一包一层 data；调用方拿到的仍是会话对象本身。
  const body = await rest<{ data: { id: string; [key: string]: unknown } }>("/api/session", {
    method: "POST",
    directory: opts.directory,
    body: opts.body ?? {},
  })
  return body.data
}

export async function sessionList(opts: { directory?: string } = {}) {
  const body = await rest<{ data: unknown[] }>("/api/session", { directory: opts.directory })
  return body.data
}

export function sessionGet(sessionID: string, opts: { directory?: string } = {}) {
  return rest<Record<string, unknown>>(`/api/session/${encodeURIComponent(sessionID)}`, {
    directory: opts.directory,
  })
}


/** 消息列表响应：[{ message, parts }] */
export type SessionMessageItem = {
  message: Record<string, unknown> & { id: string; sessionID: string; role: string }
  parts: Record<string, unknown>[]
}

type V2Content =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool"
      id: string
      name: string
      state: { status: "streaming" | "running" | "completed" | "error"; input?: Record<string, unknown>; content?: unknown; error?: unknown }
    }


export async function sessionMessages(sessionID: string, opts: { directory?: string; limit?: number } = {}) {
  const body = await rest<{ data?: SessionMessage[] }>(`/api/session/${encodeURIComponent(sessionID)}/message`, {
    directory: opts.directory,
    query: { limit: opts.limit ?? 200 },
  })
  const data = Array.isArray(body?.data) ? body.data : []
  return { data: timelineMessages(sessionID, data) }
}

/**
 * V2 `/prompt` 只接收 `text`；调用方仍按 V1 的 `parts` 组装，这里做一次转换。
 * `agent` / `variant` 在 V2 是会话级选择，payload 里不接受，故不转发。
 */
export function sessionPromptAsync(
  sessionID: string,
  body: Record<string, unknown>,
  opts: { directory?: string } = {},
) {
  const parts = Array.isArray(body.parts)
    ? (body.parts as Array<{ type?: string; text?: string; synthetic?: boolean; url?: string; filename?: string; mime?: string }>)
    : []
  const text = parts.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n\n")
  // 附件（图片/文件）走 V2 的 files: FileAttachment[]，不能静默丢弃。
  const files = parts.flatMap((part) =>
    part.type === "file" && typeof part.url === "string"
      ? [{ uri: part.url, ...(part.filename === undefined ? {} : { name: part.filename }) }]
      : [],
  )
  const model = body.model as { providerID?: string; modelID?: string } | undefined
  return rest(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
    method: "POST",
    directory: opts.directory,
    body: {
      text,
      ...(model?.providerID && model.modelID ? { model: { providerID: model.providerID, id: model.modelID } } : {}),
      ...(typeof body.messageID === "string" ? { id: body.messageID } : {}),
      ...(files.length === 0 ? {} : { files }),
      metadata: {},
    },
  })
}

/**
 * V2 命令载荷是 `{name, text, files?}`；调用方仍按 V1 的 `{command, arguments, parts}` 组装，
 * 这里做一次转换（与 sessionPromptAsync 同理）。
 */
export function sessionCommand(
  sessionID: string,
  body: Record<string, unknown>,
  opts: { directory?: string } = {},
) {
  const name = typeof body.name === "string"
    ? body.name
    : typeof body.command === "string" ? body.command.replace(/^\//, "") : ""
  const parts = Array.isArray(body.parts)
    ? (body.parts as Array<{ type?: string; text?: string; url?: string; filename?: string }>)
    : []
  const text = typeof body.arguments === "string"
    ? body.arguments
    : parts.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n\n")
  const files = parts.flatMap((part) =>
    part.type === "file" && typeof part.url === "string"
      ? [{ uri: part.url, ...(part.filename === undefined ? {} : { name: part.filename }) }]
      : [],
  )
  return rest(`/api/session/${encodeURIComponent(sessionID)}/command`, {
    method: "POST",
    directory: opts.directory,
    body: { name, text, ...(files.length === 0 ? {} : { files }), metadata: {} },
  })
}

/** V2 命令目录（含内置命令与项目命令），用于 `/` 前缀解析。 */
export function commandList(opts: { directory?: string } = {}) {
  return rest<{ data: Array<{ name: string; description?: string }> }>("/api/command", {
    directory: opts.directory,
  })
}

export function sessionAbort(sessionID: string, opts: { directory?: string } = {}) {
  // V2 用 interrupt 取代 V1 的 abort。
  return rest(`/api/session/${encodeURIComponent(sessionID)}/interrupt`, {
    method: "POST",
    directory: opts.directory,
  })
}

export function sessionStatus(opts: { directory?: string } = {}) {
  return rest<Record<string, { type: string; [key: string]: unknown }>>("/api/session/active", {
    directory: opts.directory,
  })
}

/**
 * 兼容包装：V1 的 `/file/content` 在本仓库不存在，统一委托给 `readSandboxFile`
 * （会话沙箱 → location 级 fs/read 两级通道）。
 */
export async function fileContent(
  path: string,
  opts: { directory?: string; sessionId?: string } = {},
) {
  const file = await readSandboxFile(path, { directory: opts.directory, sessionId: opts.sessionId })
  return { type: file.binary ? "binary" : "text", content: file.content }
}

/**
 * 读取沙箱文件（双通道，兼容两种部署形态）。
 *
 * 通道 A（本仓 SaaS 网关，docs/test-cases/sandbox/files-api.md 定义的 V2 权威端点）：
 *   `GET /api/session/:sessionID/fs/read/<相对 workspace 路径>` → 原始字节 + Content-Type
 * 通道 B（opencode 上游 v2 API，本地 14096 实例实测可用）：
 *   `GET /file/content?path=<绝对路径>` → `{ type, content }`
 *
 * 本地实测：14096 未挂载 `/api/*` 网关（请求落到 SPA 兜底返回 text/html），
 * 故按 content-type 判定通道 A 是否真实可用，不可用时静默回退通道 B。
 */
export type SandboxFilePayload = {
  /** 文本内容，或二进制时的 base64 */
  content: string
  mime: string
  binary: boolean
  source: "fs-read" | "file-content"
}

export async function readSandboxFile(
  path: string,
  opts: { sessionId?: string; directory?: string; mime?: string; base?: string } = {},
): Promise<SandboxFilePayload> {
  // 网关模式：经 hn-base-server 读取（带归属校验与 Bearer）
  if (authEnabled && opts.sessionId) {
    try {
      const query = new URLSearchParams({ path })
      const res = await baseFetchRaw(
        `/api/sessions/${encodeURIComponent(opts.sessionId)}/fs/content?${query.toString()}`,
      )
      if (res.ok) {
        const contentType = (res.headers.get("content-type") ?? "").toLowerCase()
        if (contentType.includes("application/json")) {
          const data = (await res.json()) as { content?: string; type?: string }
          const isText = !data?.type || data.type === "text"
          return {
            content: typeof data?.content === "string" ? data.content : "",
            mime: opts.mime ?? (isText ? "text/plain" : "application/octet-stream"),
            binary: !isText,
            source: "file-content",
          }
        }
        const buffer = await res.arrayBuffer()
        const binary = !contentType.startsWith("text/")
        return {
          content: binary ? toBase64(buffer) : new TextDecoder().decode(buffer),
          mime: contentType || opts.mime || "application/octet-stream",
          binary,
          source: "fs-read",
        }
      }
    } catch {
      // 网关不可达时回退直连链路（开发/混合部署）
    }
  }

  // 通道 A
  if (opts.sessionId) {
    const relative = relativeToWorkspace(path)
    if (relative) {
      const url = `${opts.base ?? opencodeSaasBaseUrl()}/api/session/${opts.sessionId}/fs/read/${encodePathSegments(relative)}`
      try {
        const res = await fetch(url)
        const contentType = res.headers.get("content-type") ?? ""
        // SPA 兜底也是 text/html：视为通道未挂载
        if (res.ok && !contentType.includes("text/html")) {
          const buffer = await res.arrayBuffer()
          const binary = !!contentType && !contentType.startsWith("text/")
          return {
            content: binary ? toBase64(buffer) : new TextDecoder().decode(buffer),
            mime: contentType || "text/plain",
            binary,
            source: "fs-read",
          }
        }
      } catch {
        // 通道 A 不可达 → 走通道 B
      }
    }
  }

  // 通道 B：V2 的 location 级读取（无会话沙箱时用），路径相对 location。
  const absolute = path.split(/[?#]/)[0] ?? path
  const relative = opts.directory && absolute.startsWith(`${opts.directory.replace(/\/+$/, "")}/`)
    ? absolute.slice(opts.directory.replace(/\/+$/, "").length + 1)
    : absolute.replace(/^\/+/, "")
  try {
    const url = new URL(`${opts.base ?? opencodeSaasBaseUrl()}/api/fs/read/${encodePathSegments(relative)}`)
    if (opts.directory) url.searchParams.set("directory", opts.directory)
    const res = await fetch(url.toString())
    const contentType = res.headers.get("content-type") ?? ""
    if (res.ok && !contentType.includes("text/html")) {
      const buffer = await res.arrayBuffer()
      const binary = !!contentType && !contentType.startsWith("text/")
      return {
        content: binary ? toBase64(buffer) : new TextDecoder().decode(buffer),
        mime: contentType || opts.mime || "text/plain",
        binary,
        source: "fs-read",
      }
    }
  } catch {
    // 落到最后的空结果
  }
  return { content: "", mime: opts.mime ?? "text/plain", binary: false, source: "file-content" }
}

/** 绝对路径 → workspace 相对路径；不在 /workspace 下返回 null */
export function relativeToWorkspace(path: string): string | null {
  const clean = path.split(/[?#]/)[0] ?? ""
  const idx = clean.indexOf("/workspace/")
  if (idx === -1) return null
  return clean.slice(idx + "/workspace/".length)
}

function encodePathSegments(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")
}

function toBase64(buffer: ArrayBuffer): string {
  let binary = ""
  const bytes = new Uint8Array(buffer)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * V2 模型目录：`GET /api/model` 返回扁平模型列表（V1 的 `/provider` 在本仓库不存在）。
 * 调用方按 providerID 分组即可，无需另一套 provider 结构。
 */
export function providerList(opts: { directory?: string } = {}) {
  return rest<{ data: Array<Record<string, unknown> & { id: string; providerID: string }> }>("/api/model", {
    directory: opts.directory,
  })
}

/** SSE 事件流（EventSource，GET /event?directory=...） */
export function subscribeEvents(
  onEvent: (event: { type: string; properties: Record<string, unknown> }) => void,
  opts: { directory?: string } = {},
): () => void {
  const es = new EventSource(restUrl("/api/event", { directory: opts.directory }))
  es.onmessage = (msg) => {
    try {
      // V2 帧是 {type, data}；应用层沿用 {type, properties}，在此归一化。
      const parsed = JSON.parse(msg.data) as { type?: string; data?: Record<string, unknown>; properties?: Record<string, unknown> }
      if (!parsed?.type) return
      const properties = parsed.properties ?? parsed.data
      if (properties && typeof properties === "object") onEvent({ type: parsed.type, properties })
    } catch {
      // 非 JSON 心跳/噪声忽略
    }
  }
  return () => es.close()
}
