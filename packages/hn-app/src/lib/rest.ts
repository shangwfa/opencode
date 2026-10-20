/**
 * OpenCode SaaS REST 客户端（去 SDK 化，直连 REST API）。
 * 端点：GET /session/{id}/message · POST /session/{id}/prompt_async ·
 *       POST /session/{id}/abort · POST /session/{id}/command ·
 *       GET /event（SSE）· GET /file/content · GET /provider
 * 所有请求自动带 directory 查询参数（沙箱工作目录）。
 */
import { opencodeSaasBaseUrl } from "@/utils/opencode-saas-base"
import { authEnabled } from "./auth"
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

export function sessionCreate(opts: { directory?: string; body?: Record<string, unknown> } = {}) {
  return rest<{ id: string; [key: string]: unknown }>("/session", {
    method: "POST",
    directory: opts.directory,
    body: opts.body ?? {},
  })
}

export function sessionList(opts: { directory?: string } = {}) {
  return rest<unknown[]>("/session", { directory: opts.directory })
}

export function sessionGet(sessionID: string, opts: { directory?: string } = {}) {
  return rest<Record<string, unknown>>(`/session/${encodeURIComponent(sessionID)}`, {
    directory: opts.directory,
  })
}


/** 消息列表响应：[{ message, parts }] */
export type SessionMessageItem = {
  message: Record<string, unknown> & { id: string; sessionID: string; role: string }
  parts: Record<string, unknown>[]
}

export function sessionMessages(sessionID: string, opts: { directory?: string; limit?: number } = {}) {
  return rest<{ info?: unknown; data?: SessionMessageItem[] | unknown[] }>(
    `/session/${encodeURIComponent(sessionID)}/message`,
    { directory: opts.directory, query: { limit: opts.limit ?? 200 } },
  )
}

export function sessionPromptAsync(
  sessionID: string,
  body: Record<string, unknown>,
  opts: { directory?: string } = {},
) {
  return rest(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
    method: "POST",
    directory: opts.directory,
    body,
  })
}

export function sessionCommand(
  sessionID: string,
  body: Record<string, unknown>,
  opts: { directory?: string } = {},
) {
  return rest(`/session/${encodeURIComponent(sessionID)}/command`, {
    method: "POST",
    directory: opts.directory,
    body,
  })
}

export function sessionAbort(sessionID: string, opts: { directory?: string } = {}) {
  return rest(`/session/${encodeURIComponent(sessionID)}/abort`, {
    method: "POST",
    directory: opts.directory,
  })
}

export function sessionStatus(opts: { directory?: string } = {}) {
  return rest<Record<string, { type: string; [key: string]: unknown }>>("/session/status", {
    directory: opts.directory,
  })
}

export function fileContent(
  path: string,
  opts: { directory?: string; sessionId?: string } = {},
) {
  return rest<{ type: string; content?: string }>(
    `/file/content`,
    { directory: opts.directory, query: { path, sessionID: opts.sessionId } },
  )
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

  // 通道 B
  // 实测（本地 14096）：`/file/content` 的 `sessionID` 是定位沙箱的**必需**参数 ——
  // 带 sessionID 返回 126151 字节，缺它返回 `{type:"text",content:""}`（静默空内容）。
  // 注意：若该 session 的沙箱已被销毁/重建，文件也会读为空（沙箱无持久卷）。
  const res = await fileContent(path, { directory: opts.directory, sessionId: opts.sessionId })
  const content = typeof res?.content === "string" ? res.content : ""
  const isText = !res?.type || res.type === "text"
  return {
    content,
    mime: opts.mime ?? (isText ? "text/plain" : "application/octet-stream"),
    binary: !isText,
    source: "file-content",
  }
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

export function providerList(opts: { directory?: string } = {}) {
  return rest<unknown>("/provider", { directory: opts.directory })
}

/** SSE 事件流（EventSource，GET /event?directory=...） */
export function subscribeEvents(
  onEvent: (event: { type: string; properties: Record<string, unknown> }) => void,
  opts: { directory?: string } = {},
): () => void {
  const es = new EventSource(restUrl("/event", { directory: opts.directory }))
  es.onmessage = (msg) => {
    try {
      const parsed = JSON.parse(msg.data) as { type: string; properties: Record<string, unknown> }
      if (parsed?.type) onEvent(parsed)
    } catch {
      // 非 JSON 心跳/噪声忽略
    }
  }
  return () => es.close()
}
