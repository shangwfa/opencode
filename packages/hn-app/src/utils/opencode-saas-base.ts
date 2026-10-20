/**
 * OpenCode SaaS base URL。
 * 优先级：微前端注入的 window.YD.API_URL → VITE_OPENCODE_API_URL → 本地 SaaS（本仓库 docker，v2 API）。
 */
export function opencodeSaasBaseUrl(): string {
  return (
    (typeof window !== "undefined" ? window.YD?.API_URL : undefined)?.trim() ||
    (import.meta.env.VITE_OPENCODE_API_URL as string | undefined)?.trim() ||
    "http://localhost:14096"
  )
}
