import { createContext, useCallback, useContext, useEffect, useState } from "react"
import { Link, NavLink, Outlet, useLocation } from "react-router"
import {
  ArrowUpRight,
  Code2,
  History,
  Home,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { browserApi, type BrowserSession } from "@/lib/browser"
import { authEnabled } from "@/lib/auth"
import { cn } from "@/lib/utils"

const WorkspaceContext = createContext<{ sessions: BrowserSession[]; refresh: () => Promise<void> }>({
  sessions: [],
  refresh: async () => {},
})
export const useBrowserWorkspace = () => useContext(WorkspaceContext)

export function CdpLayout() {
  const [sessions, setSessions] = useState<BrowserSession[]>([])
  const [error, setError] = useState("")
  const [collapsed, setCollapsed] = useState(false)
  const { pathname } = useLocation()
  const refresh = useCallback(async () => {
    try {
      const res = await browserApi.sessions()
      setSessions(res.items)
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])
  useEffect(() => {
    if (authEnabled) void refresh()
  }, [pathname, refresh])
  if (!authEnabled)
    return (
      <div className="mx-auto max-w-xl p-10">
        <h1 className="text-xl font-semibold">Browser Use</h1>
        <p role="alert" className="mt-4 text-sm text-muted-foreground">
          请配置 VITE_HN_BASE_URL 并登录基础服务。浏览器任务和脚本库需要服务端鉴权及
          PostgreSQL，不能使用无鉴权的直连模式。
        </p>
      </div>
    )
  return (
    <WorkspaceContext.Provider value={{ sessions, refresh }}>
      <div className="flex h-full min-w-0">
        <aside
          className={cn(
            "flex shrink-0 flex-col border-r bg-muted/20 transition-[width]",
            collapsed ? "w-12" : "hidden w-60 md:flex",
          )}
        >
          <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
            {!collapsed && (
              <Link to="/cdp" className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
                <Monitor className="size-4" />
                Browser Use
              </Link>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={collapsed ? "展开浏览器导航" : "收起浏览器导航"}
              onClick={() => setCollapsed((v) => !v)}
            >
              {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            </Button>
          </div>
          {!collapsed && (
            <>
              <div className="space-y-1 p-3">
                {[
                  { path: "/cdp", name: "开始任务", icon: Home },
                  { path: "/cdp/sessions", name: "历史任务", icon: History },
                  { path: "/cdp/scripts", name: "脚本库", icon: Code2 },
                ].map(({ path, name, icon: Icon }) => (
                  <NavLink
                    key={path}
                    to={path}
                    end={path === "/cdp"}
                    className={({ isActive }) =>
                      cn(
                        "flex h-9 items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors",
                        isActive
                          ? "bg-background font-medium shadow-xs ring-1 ring-border"
                          : "text-muted-foreground hover:bg-muted",
                      )
                    }
                  >
                    <Icon className="size-4" />
                    {name}
                  </NavLink>
                ))}
              </div>
              <div className="mx-4 mt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>最近任务</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label="刷新最近任务"
                  onClick={() => void refresh()}
                >
                  <RefreshCw className="size-3" />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {error && (
                  <p role="alert" className="break-words px-3 py-2 text-xs text-destructive">
                    {error}
                  </p>
                )}
                {!error && sessions.length === 0 && (
                  <p className="px-3 py-5 text-xs text-muted-foreground">你的浏览器任务将显示在这里</p>
                )}
                {sessions.slice(0, 20).map((session) => (
                  <NavLink
                    key={session.id}
                    to={`/cdp/session/${session.id}`}
                    title={session.title}
                    className={({ isActive }) =>
                      cn(
                        "mb-1 flex items-center gap-2 rounded-lg px-3 py-2 text-[13px]",
                        isActive ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60",
                      )
                    }
                  >
                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
                    <span className="shrink-0 text-[11px] tabular-nums">
                      {new Date(session.timeCreated).toLocaleDateString(undefined, {
                        month: "numeric",
                        day: "numeric",
                      })}
                    </span>
                  </NavLink>
                ))}
              </div>
              <div className="border-t p-3">
                <Button variant="outline" className="w-full justify-start gap-2" asChild>
                  <Link to="/cdp">
                    <Plus className="size-4" />
                    新任务
                    <ArrowUpRight className="ml-auto size-3 text-muted-foreground" />
                  </Link>
                </Button>
              </div>
            </>
          )}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <nav
            className="flex h-11 shrink-0 items-center gap-4 border-b px-4 text-xs md:hidden"
            aria-label="浏览器导航"
          >
            <Link to="/cdp">开始任务</Link>
            <Link to="/cdp/sessions">历史任务</Link>
            <Link to="/cdp/scripts">脚本库</Link>
          </nav>
          <Outlet />
        </div>
      </div>
    </WorkspaceContext.Provider>
  )
}
