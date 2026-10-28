/** 静态文件请求判定（原 utils/file.util.ts：有扩展名且非 .html） */
export function isFileRequest(baseUrl: string): boolean {
  const last = baseUrl.slice(baseUrl.lastIndexOf("/"))
  const dot = last.lastIndexOf(".")
  if (dot === -1) return false
  const extension = last.slice(dot).toLowerCase()
  return extension !== "" && extension !== ".html"
}

/** 扩展名 → Content-Type（原 mime-types.lookup 的常用子集） */
const MIME_MAP: Record<string, string> = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".otf": "font/otf",
  ".map": "application/json",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".zip": "application/zip",
}

export function lookupMimeType(extensionWithDot: string): string {
  return MIME_MAP[extensionWithDot.toLowerCase()] || "application/octet-stream"
}
