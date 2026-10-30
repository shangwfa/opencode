import { createContext, useCallback, useContext, useEffect, useState } from "react"
import { Link, NavLink, Outlet, useLocation } from "react-router"
import {
  Code2,
  History,
  Home,
  PanelLeft,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { browserApi, type BrowserSession } from "@/lib/browser"
import { authEnabled } from "@/lib/auth"
import { cn } from "@/lib/utils"
import { groupSessions } from "@/features/session/session-groups"
import { useSessionPanelCollapsed } from "@/hooks/use-session-panel"

const WorkspaceContext = createContext<{
  sessions: BrowserSession[]
  refresh: () => Promise<void>
  navigationCollapsed: boolean
  toggleNavigation: () => void
}>({
  sessions: [],
  refresh: async () => {},
  navigationCollapsed: false,
  toggleNavigation: () => {},
})
export const useBrowserWorkspace = () => useContext(WorkspaceContext)

export function BrowserNavigationToggle() {
  const { navigationCollapsed, toggleNavigation } = useBrowserWorkspace()
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={navigationCollapsed ? "展开浏览器导航" : "收起浏览器导航"}
      aria-expanded={!navigationCollapsed}
      title={navigationCollapsed ? "展开浏览器导航（⌘/Ctrl+B）" : "收起浏览器导航（⌘/Ctrl+B）"}
      onClick={toggleNavigation}
    ><PanelLeft className="size-4" /></Button>
  )
}

export function CdpLayout() {
  const [sessions, setSessions] = useState<BrowserSession[]>([])
  const [error, setError] = useState("")
  const { collapsed, toggle: toggleNavigation } = useSessionPanelCollapsed()
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
  const closeMobileNavigation = () => {
    if (window.matchMedia("(max-width: 767px)").matches) toggleNavigation()
  }
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
    <WorkspaceContext.Provider value={{ sessions, refresh, navigationCollapsed: collapsed, toggleNavigation }}>
      <div className="chat-workspace cdp-workspace relative flex h-full min-w-0">
        {!collapsed && <button type="button" className="chat-sidebar-backdrop" aria-label="关闭浏览器导航遮罩" onClick={toggleNavigation} />}
        <aside
          className={cn(
            "cdp-sidebar chat-sessions flex shrink-0 flex-col overflow-hidden transition-[width] duration-200 ease-out",
            collapsed ? "w-0" : "w-60",
          )}
          aria-label="浏览器导航栏"
          aria-hidden={collapsed}
          inert={collapsed}
        >
          <div className="cdp-sidebar-header flex h-14 shrink-0 items-center gap-2 px-3">
              <Link to="/cdp" className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold" onClick={closeMobileNavigation}>
                <span className="chat-ai-mark" aria-hidden />
                Browser Use
              </Link>
            <button type="button" className="chat-sessions-close" aria-label="关闭浏览器导航" onClick={toggleNavigation}><X className="size-4" /></button>
          </div>
          {!collapsed && (
            <>
              <nav className="cdp-section-nav space-y-1 p-3" aria-label="浏览器工作区导航">
                {[
                  { path: "/cdp", name: "开始任务", icon: Home },
                  { path: "/cdp/sessions", name: "历史任务", icon: History },
                  { path: "/cdp/scripts", name: "脚本库", icon: Code2 },
                ].map(({ path, name, icon: Icon }) => (
                  <NavLink
                    key={path}
                    to={path}
                    onClick={closeMobileNavigation}
                    end={path === "/cdp"}
                    className="flex h-9 items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors"
                  >
                    <Icon className="size-4" />
                    {name}
                  </NavLink>
                ))}
              </nav>
              <div className="cdp-recent-heading mx-4 mt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>最近任务</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {error && (
                  <div role="alert" className="px-3 py-2 text-xs text-destructive">
                    <p className="break-words">{error}</p>
                    <Button size="sm" variant="ghost" className="mt-1 h-7 px-2" onClick={() => void refresh()}>重试</Button>
                  </div>
                )}
                {!error && sessions.length === 0 && (
                  <p className="px-3 py-5 text-xs text-muted-foreground">你的浏览器任务将显示在这里</p>
                )}
                {groupSessions(sessions.slice(0, 20).map((session) => ({
                  id: session.id, title: session.title, time: { created: session.timeCreated },
                }))).map((group) => (
                  <section key={group.label} aria-label={group.label} className="chat-session-group">
                    <h3 className="chat-list-label">{group.label}</h3>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      {group.sessions.map((session) => (
                        <NavLink
                          key={session.id}
                          to={`/cdp/session/${session.id}`}
                          onClick={closeMobileNavigation}
                          title={session.title}
                          className="chat-session-item flex min-w-0 items-center text-left text-[13px] transition-colors"
                        >
                          <span className="min-w-0 flex-1 truncate">{session.title || "未命名任务"}</span>
                        </NavLink>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}
        </aside>
        <div className="cdp-main flex min-w-0 flex-1 flex-col overflow-hidden">
          <nav
            className="cdp-mobile-nav flex h-11 shrink-0 items-center gap-4 border-b px-4 text-xs md:hidden"
            aria-label="浏览器导航"
          >
            <NavLink to="/cdp" end>开始任务</NavLink>
            <NavLink to="/cdp/sessions">历史任务</NavLink>
            <NavLink to="/cdp/scripts">脚本库</NavLink>
          </nav>
          <Outlet />
        </div>
      </div>
    </WorkspaceContext.Provider>
  )
}
