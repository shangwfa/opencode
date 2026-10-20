/**
 * 认证守卫：
 *  - 未配置 VITE_HN_BASE_URL → 直接放行（开发模式，保持直连 SaaS 的现状）
 *  - 已配置 → 未登录跳 /login
 */
import type { ReactNode } from "react"
import { Navigate, useLocation } from "react-router"
import { Loader2 } from "lucide-react"
import { authEnabled, useAuth } from "@/lib/auth"

export function AuthGate({ children }: { children: ReactNode }) {
  const { loading, user } = useAuth()
  const location = useLocation()

  if (!authEnabled) return <>{children}</>

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> 加载会话…
      </div>
    )
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <>{children}</>
}
