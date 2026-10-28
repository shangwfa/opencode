/** Cookie 解析（原 utils/cookie.util.parseCookies 语义） */
export function parseCookies(cookieHeader: string | null | undefined): Record<string, string> {
  const map: Record<string, string> = {}
  if (!cookieHeader) return map
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=")
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    if (!key) continue
    let value = part.slice(idx + 1).trim()
    try {
      value = decodeURIComponent(value)
    } catch {
      // 保留原始值
    }
    map[key] = value
  }
  return map
}
