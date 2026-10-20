import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router"
import {
  AlertCircle,
  ArrowRight,
  Check,
  Code2,
  Database,
  HardDrive,
  ListChecks,
  Loader2,
  MapPin,
  Megaphone,
  MessagesSquare,
  Palette,
  PlugZap,
  RefreshCw,
  Search,
  Shapes,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AlertNotice } from "@/components/settings/settings-ui"
import { ConnectorMark } from "@/components/connectors/connector-mark"
import { hnApi } from "@/lib/base-api"
import {
  authLabel,
  categoryCounts,
  categoryLabel,
  categoryName,
  configuredServices,
  connectorStats,
  fallbackProviders,
  filterProviders,
  isNoAuth,
  pickRecommended,
  type ConnectorCategory,
  type ConnectorConnection,
  type ConnectorProvider,
  type ConnectorScope,
} from "@/lib/connectors"
import { usingBaseServer } from "@/lib/session-source"
import { cn } from "@/lib/utils"

const categoryIcons: Record<string, typeof Database> = {
  Data: Database,
  Productivity: ListChecks,
  "Developer Tools": Code2,
  Marketing: Megaphone,
  Communication: MessagesSquare,
  AI: Sparkles,
  Finance: Wallet,
  "Design & Media": Palette,
  Security: ShieldCheck,
  Location: MapPin,
  Social: Users,
  Storage: HardDrive,
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const scopes: Array<{ id: ConnectorScope; label: string }> = [
  { id: "all", label: "全部" },
  { id: "configured", label: "已配置" },
  { id: "no_auth", label: "免配置" },
]

function CategoryIcon({ category }: { category: string }) {
  const Icon = categoryIcons[category] ?? Shapes
  return <Icon className="size-3.5" />
}

function Stat({ icon: Icon, label, value, detail }: { icon: typeof PlugZap; label: string; value: string | number; detail: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground flex size-7 items-center justify-center rounded-md border bg-muted/30">
          <Icon className="size-3.5" />
        </span>
        <span className="text-muted-foreground text-[10px]">个人空间</span>
      </div>
      <p className="mt-5 text-[24px] leading-none font-semibold tracking-tight tabular-nums">{value}</p>
      <p className="mt-2 text-[12px] font-medium">{label}</p>
      <p className="text-muted-foreground mt-1 text-[11px]">{detail}</p>
    </div>
  )
}

function ProviderButton({
  provider,
  connectionCount,
  onOpen,
}: {
  provider: ConnectorProvider
  connectionCount: number
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-w-0 items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-left transition-colors hover:border-foreground/20 hover:bg-muted/30"
    >
      <ConnectorMark service={provider.service} name={provider.displayName} iconUrl={provider.iconUrl} homepageUrl={provider.homepageUrl} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[12.5px] font-medium">{provider.displayName}</span>
          {connectionCount > 0 ? (
            <span className="text-muted-foreground shrink-0 rounded border px-1 py-0.5 text-[9px]">已配置 {connectionCount}</span>
          ) : isNoAuth(provider) ? (
            <span className="text-muted-foreground shrink-0 rounded border px-1 py-0.5 text-[9px]">免配置</span>
          ) : null}
        </span>
        <span className="text-muted-foreground mt-1 block truncate text-[11px]">
          {provider.description || `${categoryLabel(provider)} · ${authLabel(provider.authTypes)}`}
        </span>
      </span>
      <span className="text-muted-foreground shrink-0 text-[10px]">{authLabel(provider.authTypes).split(" · ")[0]}</span>
      <ArrowRight className="text-muted-foreground size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
    </button>
  )
}

export function ConnectorsPage() {
  const enabled = usingBaseServer()
  const [tab, setTab] = useState<"overview" | "catalog">("overview")
  const [providers, setProviders] = useState<ConnectorProvider[]>([])
  const [categories, setCategories] = useState<ConnectorCategory[]>([])
  const [connections, setConnections] = useState<ConnectorConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [catalogError, setCatalogError] = useState("")
  const [connectionsError, setConnectionsError] = useState("")
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("")
  const [scope, setScope] = useState<ConnectorScope>("all")
  const [visibleCount, setVisibleCount] = useState(60)
  const [allCategories, setAllCategories] = useState(false)
  const navigate = useNavigate()

  const loadConnections = useCallback(async () => {
    try {
      const result = await hnApi.connectorConnections()
      setConnections(result.connections ?? [])
      setConnectionsError("")
    } catch (error) {
      setConnections([])
      setConnectionsError(messageOf(error))
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setCatalogError("")
    const [providerResult, categoryResult, connectionResult] = await Promise.allSettled([
      hnApi.connectorProviders(),
      hnApi.connectorCategories(),
      hnApi.connectorConnections(),
    ])
    if (providerResult.status === "fulfilled") {
      setProviders(providerResult.value.providers ?? [])
    } else {
      setProviders(fallbackProviders)
      setCatalogError(messageOf(providerResult.reason))
    }
    if (categoryResult.status === "fulfilled") {
      setCategories(categoryResult.value.categories ?? [])
    } else {
      setCategories(categoryCounts(providerResult.status === "fulfilled" ? providerResult.value.providers ?? [] : fallbackProviders))
    }
    if (connectionResult.status === "fulfilled") {
      setConnections(connectionResult.value.connections ?? [])
      setConnectionsError("")
    } else {
      setConnections([])
      setConnectionsError(messageOf(connectionResult.reason))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!enabled) {
      setProviders(fallbackProviders)
      setCategories(categoryCounts(fallbackProviders))
      setLoading(false)
      return
    }
    void load()
  }, [enabled, load])

  useEffect(() => {
    setVisibleCount(60)
  }, [query, category, scope])

  const configured = useMemo(() => configuredServices(connections), [connections])
  const stats = useMemo(() => connectorStats(providers, connections), [providers, connections])
  const sortedCategories = useMemo(() => [...categories].sort((a, b) => b.providerCount - a.providerCount), [categories])
  const topCategories = allCategories ? sortedCategories : sortedCategories.slice(0, 8)
  const recommended = useMemo(() => pickRecommended(providers, 4), [providers])
  const filtered = useMemo(
    () => filterProviders(providers, { query, category, scope, configured }),
    [providers, query, category, scope, configured],
  )
  const visible = filtered.slice(0, visibleCount)
  const connectionCount = (service: string) => connections.filter((item) => item.service === service && item.status !== "deleted").length
  const openProvider = (provider: ConnectorProvider) => navigate(`/connectors/${encodeURIComponent(provider.service)}`)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-8 py-8">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[22px] leading-tight font-semibold tracking-tight">连接器</h1>
            <p className="text-muted-foreground mt-1.5 text-[13px]">连接第三方应用，为开发会话提供真实工具与数据能力。</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="gap-1.5">
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
        </header>

        <div className="mb-6 flex items-center gap-6 border-b" role="tablist" aria-label="连接器视图">
          {[{ id: "overview", label: "概览" }, { id: "catalog", label: "应用连接" }].map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id as typeof tab)}
              className={cn(
                "relative -mb-px border-b-2 px-0.5 py-2.5 text-[12px] transition-colors",
                tab === item.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
          <span className="text-muted-foreground ml-auto text-[11px]">{stats.connections} 个已配置连接</span>
        </div>

        {!enabled && (
          <AlertNotice tone="warn" icon={<AlertCircle className="size-4" />}>
            当前未配置网关地址，展示内置连接器目录；连接操作需要启用 hn-base-server。
          </AlertNotice>
        )}
        {catalogError && (
          <AlertNotice tone="warn" icon={<AlertCircle className="size-4" />}>
            连接器服务暂不可用，当前展示内置目录快照。{catalogError}
          </AlertNotice>
        )}
        {connectionsError && !catalogError && (
          <div className="text-muted-foreground mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px]">
            连接状态读取失败：{connectionsError}
          </div>
        )}

        {loading ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-24 text-sm">
            <Loader2 className="size-4 animate-spin" /> 读取连接器目录…
          </div>
        ) : tab === "overview" ? (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat icon={PlugZap} label="已配置连接" value={stats.connections} detail={`${stats.active} 个当前可用`} />
              <Stat icon={Shapes} label="可连接应用" value={stats.providers} detail="来自连接器目录" />
              <Stat icon={ListChecks} label="应用分类" value={stats.categories} detail="按使用场景浏览" />
              <Stat icon={Sparkles} label="免配置应用" value={stats.noAuth} detail="无需账号即可调用" />
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
              <section className="overflow-hidden rounded-xl border bg-card">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <div>
                    <h2 className="text-[13px] font-medium">推荐连接</h2>
                    <p className="text-muted-foreground mt-0.5 text-[11px]">从常用应用开始，为会话补充真实数据</p>
                  </div>
                  <button type="button" onClick={() => setTab("catalog")} className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px]">
                    连接应用 <ArrowRight className="size-3" />
                  </button>
                </div>
                {recommended.map((provider) => {
                  const count = connectionCount(provider.service)
                  return (
                    <div key={provider.service} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
                      <ConnectorMark service={provider.service} name={provider.displayName} iconUrl={provider.iconUrl} homepageUrl={provider.homepageUrl} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-[12.5px] font-medium">{provider.displayName}</p>
                          <span className="text-muted-foreground shrink-0 text-[10px]">{categoryLabel(provider)}</span>
                        </div>
                        <p className="text-muted-foreground mt-1 truncate text-[11px]">{provider.description || authLabel(provider.authTypes)}</p>
                      </div>
                      <Button size="sm" variant={count ? "outline" : "secondary"} onClick={() => openProvider(provider)} className="shrink-0 gap-1">
                        {count ? <><Check className="size-3" />管理</> : <>去连接 <ArrowRight className="size-3" /></>}
                      </Button>
                    </div>
                  )
                })}
              </section>

              <section className="rounded-xl border bg-card p-4">
                <h2 className="text-[13px] font-medium">使用方式</h2>
                <div className="mt-4 space-y-4">
                  {[
                    ["01", "浏览目录", "按分类或关键词找到需要的第三方应用。"],
                    ["02", "连接账号", "凭据由连接器服务加密保存，不会写入聊天内容。"],
                    ["03", "接入会话", "Connector MCP 接入会话后，Agent 可通过工具查询和操作这些应用。"],
                  ].map(([step, title, detail]) => (
                    <div key={step} className="flex gap-3">
                      <span className="text-muted-foreground font-mono text-[10px]">{step}</span>
                      <div>
                        <p className="text-[12px] font-medium">{title}</p>
                        <p className="text-muted-foreground mt-0.5 text-[11px] leading-relaxed">{detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-muted-foreground mt-5 border-t pt-3 text-[11px] leading-relaxed">
                  连接属于个人连接空间，不会自动共享给其他成员。删除后，相关会话将无法继续使用该账号。
                </div>
              </section>
            </div>

            <section className="overflow-hidden rounded-xl border bg-card">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <div>
                  <h2 className="text-[13px] font-medium">我的连接</h2>
                  <p className="text-muted-foreground mt-0.5 text-[11px]">最近配置的账号与当前状态</p>
                </div>
                <button type="button" onClick={() => setTab("catalog")} className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px]">
                  查看全部 <ArrowRight className="size-3" />
                </button>
              </div>
              {connections.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <p className="text-[12px] font-medium">还没有连接</p>
                  <p className="text-muted-foreground mt-1 text-[11px]">从应用连接页选择一个服务，完成账号授权后即可在这里看到。</p>
                  <Button size="sm" variant="outline" className="mt-3" onClick={() => setTab("catalog")}>浏览应用</Button>
                </div>
              ) : (
                connections.slice(0, 6).map((connection) => {
                  const provider = providers.find((item) => item.service === connection.service)
                  return (
                    <div key={connection.id} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
                      <ConnectorMark service={connection.service} name={provider?.displayName ?? connection.service} iconUrl={provider?.iconUrl} homepageUrl={provider?.homepageUrl} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-medium">{connection.alias || provider?.displayName || connection.service}</p>
                        <p className="text-muted-foreground mt-0.5 text-[11px]">{provider?.displayName ?? connection.service} · {connection.authType}</p>
                      </div>
                      <span className={cn("flex items-center gap-1.5 text-[11px]", connection.engineStatus === "active" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>
                        <span className={cn("size-1.5 rounded-full", connection.engineStatus === "active" ? "bg-emerald-500" : "bg-amber-500")} />
                        {connection.engineStatus === "active" ? "可用" : "需处理"}
                      </span>
                      {provider && <Button size="sm" variant="ghost" onClick={() => openProvider(provider)}>管理</Button>}
                    </div>
                  )
                })
              )}
            </section>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索应用、能力或场景"
                aria-label="搜索连接器应用"
                className="h-10 pl-9 text-[13px]"
              />
            </div>

            <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {topCategories.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={category === item.id}
                  onClick={() => setCategory(category === item.id ? "" : item.id)}
                  className={cn(
                    "flex min-w-0 flex-col rounded-xl border px-3 py-3 text-left transition-colors",
                    category === item.id ? "border-foreground/25 bg-muted/60" : "bg-card hover:bg-muted/30",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground"><CategoryIcon category={item.id} /></span>
                    <span className="truncate text-[12px] font-medium">{categoryName(item.id)}</span>
                    <span className="text-muted-foreground ml-auto text-[10px] tabular-nums">{item.providerCount}</span>
                  </span>
                  <span className="text-muted-foreground mt-2 text-[11px]">{categoryDescription(item.id)}</span>
                </button>
              ))}
            </div>
            {sortedCategories.length > 8 && (
              <div className="flex justify-center">
                <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setAllCategories((value) => !value)}>
                  {allCategories ? "收起分类" : `更多分类（${sortedCategories.length - 8}）`}
                </Button>
              </div>
            )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/30 p-1">
                {scopes.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={scope === item.id}
                    onClick={() => setScope(item.id)}
                    className={cn(
                      "rounded-md px-2.5 py-1.5 text-[11px] transition-colors",
                      scope === item.id ? "bg-background font-medium shadow-xs" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item.label}
                    {item.id === "configured" && <span className="ml-1 tabular-nums">{stats.connections}</span>}
                  </button>
                ))}
              </div>
              <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
                显示 {filtered.length} / {providers.length}
                {(query || category || scope !== "all") && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => { setQuery(""); setCategory(""); setScope("all") }}>
                    清除筛选
                  </Button>
                )}
              </div>
            </div>

            {visible.length === 0 ? (
              <div className="rounded-xl border border-dashed px-6 py-16 text-center">
                <p className="text-[13px] font-medium">没有匹配的应用</p>
                <p className="text-muted-foreground mt-1 text-[11px]">换一个关键词或清除分类筛选。</p>
              </div>
            ) : (
              <>
                <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                  {visible.map((provider) => (
                    <ProviderButton
                      key={provider.service}
                      provider={provider}
                      connectionCount={connectionCount(provider.service)}
                      onOpen={() => openProvider(provider)}
                    />
                  ))}
                </div>
                {visible.length < filtered.length && (
                  <div className="flex justify-center">
                    <Button variant="outline" size="sm" onClick={() => setVisibleCount((count) => count + 60)}>
                      加载更多（剩余 {filtered.length - visible.length}）
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

    </div>
  )
}

function categoryDescription(category: string): string {
  const descriptions: Record<string, string> = {
    Data: "数据仓库、数据库、BI 与存储",
    Productivity: "项目、任务、日程和自动化",
    "Developer Tools": "代码、部署、云服务和监控",
    Marketing: "广告、内容、线索和增长数据",
    Communication: "消息、邮件、会议、文档与知识",
    AI: "模型、Agent、检索和媒体生成",
    Finance: "股票、期货、行情、持仓和交易",
    "Design & Media": "设计、图片、视频和素材",
    Security: "身份、合规、风控与审计",
    Location: "地图、地址、物流和天气",
    Social: "社交平台与社区内容",
    Storage: "文件、云盘与对象存储",
    "Data & Analytics": "指标、报表与分析平台",
    Infrastructure: "云资源、部署与运维",
    Design: "界面、图标与视觉设计",
    "E-commerce": "店铺、订单与商品数据",
    Documents: "文档、笔记与知识库",
    "Documents & Content": "内容管理与协作",
    Media: "图片、音视频与素材",
    Analytics: "数据采集与行为分析",
  }
  return descriptions[category] ?? "第三方应用与工具"
}
