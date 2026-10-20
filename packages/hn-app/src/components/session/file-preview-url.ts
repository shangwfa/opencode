/**
 * 沙箱文件预览：链接解析与预览类型判定（纯函数）。
 *
 * 背景事实（本地 SaaS v2 实测）：
 * - `GET /file/content?path=...` 可用，返回 `{ type, content }`
 * - 端口代理（`/api/session/:id/endpoint|proxy/:port`）在当前部署不可用（落到 SPA）
 * 因此 HTML 产物预览走「读内容 + 前端渲染」，相对路径资源无法解析（沙箱文件不经 HTTP 暴露）。
 */

/** 绝对路径的父目录（`/file/content` 以 directory 参数寻址） */
export function parentDirectoryOf(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? ""
  const index = clean.lastIndexOf("/")
  if (index <= 0) return "/"
  return clean.slice(0, index)
}

const FILE_PROTOCOL = "file://"

export type SandboxFileRef = {
  /** 沙箱绝对路径，如 /workspace/demo.html */
  path: string
  /** 文件名（含扩展名） */
  filename: string
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico"])
const MARKDOWN_EXT = new Set(["md", "markdown"])
const TEXT_EXT = new Set([
  "txt",
  "json",
  "yaml",
  "yml",
  "toml",
  "ts",
  "tsx",
  "js",
  "jsx",
  "css",
  "scss",
  "html",
  "htm",
  "csv",
  "log",
  "sh",
  "sql",
  "xml",
  "py",
  "go",
  "rs",
  "java",
])

export type PreviewKind = "html" | "image" | "markdown" | "text" | "unsupported"

/** 取文件名（含扩展名） */
export function filenameOf(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? ""
  const parts = clean.split("/")
  return parts[parts.length - 1] ?? clean
}

function extensionOf(path: string): string {
  const name = filenameOf(path)
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return ""
  return name.slice(dot + 1).toLowerCase()
}

/**
 * 解析消息里出现的沙箱文件引用：
 * - `file:///workspace/demo.html` / `file://localhost/workspace/demo.html` → /workspace/demo.html
 * - 纯绝对路径（/workspace/demo.html）也识别，交给调用方决定
 */
export function parseSandboxFileHref(href: string | undefined | null): SandboxFileRef | null {
  const raw = (href ?? "").trim()
  if (!raw) return null

  let path: string
  if (raw.toLowerCase().startsWith(FILE_PROTOCOL)) {
    let rest = raw.slice(FILE_PROTOCOL.length)
    try {
      rest = decodeURIComponent(rest)
    } catch {
      // 非法百分号编码时按原样处理
    }
    // file://localhost/x → /x；file:///x → /x
    if (rest.startsWith("localhost/")) rest = rest.slice("localhost".length)
    if (!rest.startsWith("/")) return null
    path = rest
  } else if (raw.startsWith("/")) {
    path = raw
  } else {
    return null
  }

  path = path.split("#")[0]!.split("?")[0]!
  if (!path || path === "/") return null
  const filename = filenameOf(path)
  if (!filename) return null
  return { path, filename }
}

/** 按扩展名决定预览方式 */
export function previewKindOf(path: string): PreviewKind {
  const ext = extensionOf(path)
  if (!ext) return "unsupported"
  if (ext === "html" || ext === "htm") return "html"
  if (IMAGE_EXT.has(ext)) return "image"
  if (MARKDOWN_EXT.has(ext)) return "markdown"
  if (TEXT_EXT.has(ext)) return "text"
  return "unsupported"
}

/** 是否是可预览的沙箱文件引用（Markdown 链接拦截用） */
export function isPreviewableFileHref(href: string | undefined | null): boolean {
  const ref = parseSandboxFileHref(href)
  if (!ref) return false
  return previewKindOf(ref.path) !== "unsupported"
}

/** 图片等二进制：file/content 返回 text 时无法预览，这里给统一的 MIME 推断 */
export function guessMimeType(path: string): string {
  const ext = extensionOf(path)
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
    ico: "image/x-icon",
    html: "text/html",
    htm: "text/html",
    md: "text/markdown",
    json: "application/json",
    csv: "text/csv",
  }
  return map[ext] ?? "text/plain"
}