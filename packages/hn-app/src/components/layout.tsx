import { Link, NavLink, Outlet, useLocation } from "react-router"
import { cn } from "@/lib/utils"
import {
  LayoutDashboard,
  FolderInput,
  Boxes,
  Bot,
  Monitor,
  MessagesSquare,
  Home,
  Terminal,
  GitBranch,
  Cable,
} from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { UserMenu } from "@/components/user-menu"

/** 分组：主流程 / 辅助工具（分隔线在两组之间，与 ChatGPT 图标栏一致） */
const navGroups: { to: string; label: string; icon: typeof Home }[][] = [
  [
    { to: "/", label: "首页", icon: Home },
    { to: "/free-chat", label: "自由对话", icon: MessagesSquare },
  ],
  [
    { to: "/project-intake", label: "项目接入", icon: FolderInput },
    { to: "/apps", label: "应用", icon: Boxes },
    { to: "/connectors", label: "连接器", icon: Cable },
    { to: "/dashboard", label: "仪表盘", icon: LayoutDashboard },
    { to: "/git-providers", label: "Git 服务连接", icon: GitBranch },
    { to: "/agent-registry", label: "Agent 注册表", icon: Bot },
    { to: "/cdp", label: "浏览器 CDP", icon: Monitor },
  ],
]

/**
 * L1 全局导航：常驻图标栏（参考 ChatGPT / Codex 桌面端）。
 * - 固定 64px 宽，只显示图标；名称通过右侧 tooltip 提示（折叠图标栏的共识做法）
 * - 选中态为圆角方块底色；两组之间用分隔线划分主流程与工具
 * - 不提供展开态：入口恒定，位置不跳动
 *
 * 注意：NavLink 的 className 必须是**字符串**——函数式 className 被 Radix Slot
 * （TooltipTrigger asChild）原样透传时会把函数源码写进 DOM，导致类名失效。
 */
export function AppLayout() {
  const { pathname } = useLocation()
  const isActiveOf = (to: string) =>
    to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`)

  return (
    <div className="bg-muted/30 flex h-screen overflow-hidden">
      <TooltipProvider delayDuration={200}>
        <aside className="bg-muted/70 flex w-16 shrink-0 flex-col">
          <div className="flex h-14 shrink-0 items-center justify-center border-b">
            <Link to="/" aria-label="OpenCode Chat" className="flex items-center">
              <span className="bg-foreground flex size-7 items-center justify-center rounded-lg">
                <Terminal className="size-3.5 text-background" strokeWidth={2.2} />
              </span>
            </Link>
          </div>

          <nav className="flex flex-1 flex-col items-center gap-1 overflow-y-auto p-2">
            {navGroups.map((group, gi) => (
              <div key={gi} className="flex w-full flex-col items-center gap-1">
                {gi > 0 && <div className="my-1.5 h-px w-6 bg-border" aria-hidden />}
                {group.map(({ to, label, icon: Icon }) => {
                  const active = isActiveOf(to)
                  return (
                    <Tooltip key={to}>
                      <TooltipTrigger asChild>
                        <NavLink
                          to={to}
                          end={to === "/"}
                          aria-label={label}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "flex size-8 items-center justify-center rounded-lg transition-colors",
                            active
                              ? "bg-foreground/10 text-foreground"
                              : "text-foreground/55 hover:bg-foreground/[0.05] hover:text-foreground/80",
                          )}
                        >
                          {/* 16px 与站内其它图标统一；侧栏只有 64px 宽，图标再大就会显得压迫 */}
                          <Icon
                            strokeWidth={active ? 2.1 : 1.9}
                            className="size-4 shrink-0"
                          />
                        </NavLink>
                      </TooltipTrigger>
                      <TooltipContent side="right" sideOffset={8} className="text-xs">
                        {label}
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            ))}
          </nav>

          <UserMenu />
        </aside>
      </TooltipProvider>

      <main className="bg-background min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
