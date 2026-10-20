/**
 * 侧栏底部用户区：当前用户 + 登出。
 * 未启用认证（未配置 VITE_HN_BASE_URL）时不渲染。
 */
import { useNavigate } from "react-router"
import { LogOut } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { authEnabled, signOut, useAuth } from "@/lib/auth"

/**
 * 用户区。
 * - vertical：64px 图标栏（头像在上、登出在下）
 * - horizontal：宽侧栏（头像 + 邮箱 + 登出同一行，避免大片留白）
 */
export function UserMenu({ layout = "vertical" }: { layout?: "vertical" | "horizontal" }) {
  const navigate = useNavigate()
  const { loading, user, refresh } = useAuth()
  if (!authEnabled || loading) return null

  const initial = (user?.email ?? user?.name ?? "?").slice(0, 1).toUpperCase()

  const handleSignOut = async () => {
    await signOut()
    await refresh()
    navigate("/login", { replace: true })
  }

  if (layout === "horizontal") {
    return (
      <div className="flex w-full items-center gap-2 border-t px-3 py-2.5">
        <span
          className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
          title={user?.email ?? "当前用户"}
        >
          {initial}
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]">
          {user?.email ?? "未登录"}
        </span>
        {user && (
          <button
            type="button"
            onClick={() => void handleSignOut()}
            aria-label="登出"
            title="登出"
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors"
          >
            <LogOut className="size-3.5" strokeWidth={1.9} />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col items-center gap-2 border-t p-2 pt-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="bg-muted flex size-8 items-center justify-center rounded-full text-[11px] font-semibold"
            aria-label={user?.email ?? "当前用户"}
          >
            {initial}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8} className="text-xs">
          {user?.email ?? "未登录"}
        </TooltipContent>
      </Tooltip>
      {user && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              aria-label="登出"
              className="flex size-8 items-center justify-center rounded-lg text-foreground/55 transition-colors hover:bg-foreground/[0.05] hover:text-foreground/80"
            >
              <LogOut className="size-4 shrink-0" strokeWidth={1.9} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8} className="text-xs">
            登出
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
