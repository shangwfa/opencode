import { useEffect, useState } from "react"
import { Link } from "react-router"
import { ArrowUpRight, Boxes, FolderInput, MessagesSquare, RefreshCw, Server } from "lucide-react"
import { opencodeSaasBaseUrl } from "@/utils/opencode-saas-base"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type Health = { healthy?: boolean; version?: string }

function useOpenCodeHealth() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const load = () => {
    setError(null)
    setLoading(true)
    // 本仓库 SaaS 没有 /global/health（会落到 SPA 的 HTML），服务身份在 GET /api/info。
    // 只有拿到带 version 的 JSON 才算健康，避免把 200 的 HTML 误判为可用。
    fetch(`${opencodeSaasBaseUrl()}/api/info`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const body: unknown = await r.json()
        if (typeof body !== "object" || body === null || typeof (body as { version?: unknown }).version !== "string")
          throw new Error("非预期的服务响应")
        return body as { version: string }
      })
      .then((info) => setHealth({ healthy: true, version: info.version }))
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])
  return { health, error, loading, reload: load }
}

export function HomePage() {
  const { health, error, loading, reload } = useOpenCodeHealth()

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-8 py-12">
        <header className="mb-10">
          <h1 className="text-[26px] leading-tight font-semibold tracking-tight">OpenCode Chat</h1>
          <p className="text-muted-foreground mt-2 text-sm">应用 · 自由对话 · 项目接入</p>
        </header>

        {/* SaaS 连接状态 */}
        <Card className="mb-8 gap-0 py-0">
          <div className="flex items-center gap-5 px-5 py-4">
            <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
              <Server className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">OpenCode SaaS</span>
                <StatusPill
                  state={error ? "error" : health?.healthy ? "ok" : health ? "warn" : loading ? "loading" : "idle"}
                  text={
                    error
                      ? "连接失败"
                      : health?.healthy
                        ? `healthy · ${health.version ?? "-"}`
                        : health
                          ? "unhealthy"
                          : loading
                            ? "检测中…"
                            : "未检测"
                  }
                />
              </div>
              <p className="text-muted-foreground mt-1 truncate text-xs">
                {opencodeSaasBaseUrl()}
                <span className="ml-2 opacity-70">（运行时读取 window.YD.API_URL）</span>
              </p>
            </div>
            <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={reload} disabled={loading}>
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              重新检测
            </Button>
          </div>
        </Card>

        {/* 功能入口 */}
        <div className="grid gap-3 md:grid-cols-3">
          <EntryCard
            to="/apps"
            icon={Boxes}
            title="应用"
            desc="每个应用拥有自己的需求列表，在工作台内完成需求开发"
          />
          <EntryCard
            to="/free-chat"
            icon={MessagesSquare}
            title="自由对话"
            desc="无阶段约束的会话模式，会话列表与消息时间线"
          />
          <EntryCard
            to="/project-intake"
            icon={FolderInput}
            title="项目接入"
            desc="仓库 ↔ 应用映射、intake 确认任务（迁移中）"
          />
        </div>
      </div>
    </div>
  )
}

function StatusPill({ state, text }: { state: "ok" | "warn" | "error" | "loading" | "idle"; text: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        state === "ok" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        state === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        state === "error" && "bg-destructive/10 text-destructive",
        (state === "loading" || state === "idle") && "bg-muted text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "ok" && "bg-emerald-500",
          state === "warn" && "bg-amber-500",
          state === "error" && "bg-destructive",
          (state === "loading" || state === "idle") && "bg-muted-foreground/50",
        )}
      />
      {text}
    </span>
  )
}

function EntryCard({
  to,
  icon: Icon,
  title,
  desc,
}: {
  to: string
  icon: typeof Boxes
  title: string
  desc: string
}) {
  return (
    <Link
      to={to}
      className="group bg-card flex flex-col gap-3 rounded-xl border p-4 transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-sm"
    >
      <div className="flex items-center gap-2.5">
        <div className="bg-muted text-muted-foreground group-hover:bg-foreground group-hover:text-background flex size-8 items-center justify-center rounded-lg transition-colors">
          <Icon className="size-4" />
        </div>
        <span className="text-sm font-medium">{title}</span>
        <ArrowUpRight className="text-muted-foreground ml-auto size-4 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <p className="text-muted-foreground text-[13px] leading-relaxed">{desc}</p>
    </Link>
  )
}