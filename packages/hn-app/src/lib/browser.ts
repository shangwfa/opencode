import type { BrowserWorkspace as B } from "@opencode/schema/browser-workspace"
import type { Form } from "@opencode/schema/form"
import { baseFetch, baseFetchRaw, requireBaseUrl } from "./base-api"

export type BrowserSession = B.SessionInfo
export type BrowserTarget = B.Target
export type BrowserScript = B.ScriptInfo
export type BrowserVersion = B.Version
export type ScriptSource = { content: string } | { sessionId: string; fileName: string }

const root = "/api/browser"
const session = (id: string) => `${root}/sessions/${encodeURIComponent(id)}`
function request<T>(path: string, method = "GET", body?: unknown) {
  requireBaseUrl()
  return baseFetch<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

export const browserApi = {
  sessions: () => request<{ items: BrowserSession[] }>(`${root}/sessions`),
  create: (body: { title: string; scriptId?: string }) =>
    request<{
      session: { id: string }
      status: "preparing" | "ready" | "failed"
      ready: boolean
      error: string | null
    }>(`${root}/sessions`, "POST", body),
  status: (id: string) =>
    request<{ sessionId: string; status: "preparing" | "ready" | "failed"; error: string | null }>(
      `${session(id)}/browser`,
    ),
  remove: (id: string) => request(session(id), "DELETE"),
  start: (id: string) => request(`${session(id)}/start`, "POST"),
  stop: (id: string) => request(`${session(id)}/stop`, "POST"),
  forms: (id: string) => request<{ data: Form.Info[] }>(`${session(id)}/forms`),
  reply: (id: string, form: string, answer: Form.Answer) =>
    request(`${session(id)}/forms/${encodeURIComponent(form)}/reply`, "POST", { answer }),
  targets: (id: string) => request<{ items: BrowserTarget[] }>(`${session(id)}/targets`),
  openTab: (id: string, url: string) => request<BrowserTarget>(`${session(id)}/targets`, "POST", { url }),
  closeTab: (id: string, target: string) => request(`${session(id)}/targets/${encodeURIComponent(target)}`, "DELETE"),
  command: <T = Record<string, unknown>>(
    id: string,
    target: string,
    method: string,
    params: Record<string, unknown> = {},
  ) => request<T>(`${session(id)}/targets/${encodeURIComponent(target)}/command`, "POST", { method, params }),
  frames: (id: string, target: string, signal: AbortSignal) =>
    baseFetchRaw(`${session(id)}/targets/${encodeURIComponent(target)}/frames`, {
      signal,
      headers: { accept: "text/event-stream" },
    }),
  files: (id: string) =>
    request<{ data: Array<{ name?: string; path: string; type: string }> }>(`${session(id)}/files`),
  file: (id: string, name: string) => request<{ content: string }>(`${session(id)}/files/${encodeURIComponent(name)}`),
  scripts: (query = "") => request<{ items: BrowserScript[] }>(`${root}/scripts?q=${encodeURIComponent(query)}`),
  script: (id: string) =>
    request<{ script: BrowserScript; versions: Omit<BrowserVersion, "content">[]; content: string }>(
      `${root}/scripts/${encodeURIComponent(id)}`,
    ),
  version: (id: string, version: number) =>
    request<BrowserVersion>(`${root}/scripts/${encodeURIComponent(id)}/versions/${version}`),
  publish: (body: {
    name: string
    description: string
    visibility: "private" | "public"
    source: ScriptSource
    changelog: string
  }) => request<BrowserScript>(`${root}/scripts`, "POST", body),
  append: (id: string, body: { expectedVersion: number; source: ScriptSource; changelog: string }) =>
    request(`${root}/scripts/${encodeURIComponent(id)}/versions`, "POST", body),
  update: (id: string, body: { name?: string; description?: string; visibility?: "private" | "public" }) =>
    request(`${root}/scripts/${encodeURIComponent(id)}`, "PATCH", body),
  deleteScript: (id: string) => request(`${root}/scripts/${encodeURIComponent(id)}`, "DELETE"),
}

export function browserPrompt(text: string, review: boolean, scriptPath?: string | null) {
  return [
    scriptPath ? `读取并执行浏览器脚本 ${scriptPath}，按以下要求补充参数。` : "",
    review ? `UI走查：${text.trim()}` : text.trim(),
  ]
    .filter(Boolean)
    .join("\n")
}

export function normalizeBrowserUrl(value: string) {
  if (
    /^[a-z][a-z\d+.-]*:/i.test(value.trim()) &&
    !/^https?:\/\//i.test(value.trim()) &&
    !/^[\w.-]+:\d+(?:\/|$)/.test(value.trim())
  )
    throw new Error("只允许 HTTP 或 HTTPS 地址")
  const url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`)
  if (!/^https?:$/.test(url.protocol) || !value.trim() || /\s/.test(value.trim()))
    throw new Error("请输入有效的 HTTP 或 HTTPS 地址")
  return url.href
}

/** SSE 块可跨网络 chunk；同时兼容 CRLF 与多行 data。 */
export async function readBrowserFrames(response: Response, onFrame: (frame: unknown) => void) {
  if (!response.ok || !response.body) throw new Error(`浏览器画面连接失败（${response.status}）`)
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (!data) continue
        try {
          onFrame(JSON.parse(data))
        } catch {
          /* 忽略非 JSON 心跳 */
        }
      }
    }
  } finally {
    await reader.cancel()
  }
}
