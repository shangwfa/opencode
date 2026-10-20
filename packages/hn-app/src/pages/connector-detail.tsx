import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router"
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  Plus,
  Search,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConnectorDialog } from "@/components/connectors/provider-dialog"
import { ConnectorMark } from "@/components/connectors/connector-mark"
import { AppMcpPanel } from "@/components/connectors/app-mcp-panel"
import { useToast } from "@/components/toast"
import { hnApi } from "@/lib/base-api"
import {
  authLabel,
  categoryName,
  fallbackProviders,
  type ConnectorAction,
  type ConnectorConnection,
  type ConnectorProviderDetail,
} from "@/lib/connectors"
import { cn } from "@/lib/utils"

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const groups = [
  { id: "read", label: "读取接口", hint: "查询与读取数据" },
  { id: "write", label: "写入接口", hint: "创建或修改数据" },
  { id: "destructive", label: "危险操作", hint: "删除或不可逆操作" },
  { id: "other", label: "其他接口", hint: "未分类动作" },
]

function operationGroup(action: ConnectorAction): string {
  return action.operationType === "read" || action.operationType === "write" || action.operationType === "destructive"
    ? action.operationType
    : "other"
}

function statusText(status: string) {
  return status === "active" ? "可用" : status === "reauth_required" ? "需重新授权" : status === "error" ? "异常" : "已断开"
}

export function ConnectorDetailPage() {
  const { service = "" } = useParams()
  const toast = useToast()
  const [detail, setDetail] = useState<ConnectorProviderDetail | null>(null)
  const [connections, setConnections] = useState<ConnectorConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [showActions, setShowActions] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["read"]))
  const [dialog, setDialog] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const compact = fallbackProviders.find((item) => item.service === service)
  const provider = detail ?? compact

  const loadConnections = useCallback(async () => {
    try {
      const result = await hnApi.connectorConnections()
      setConnections(result.connections ?? [])
    } catch (cause) {
      toast({ variant: "destructive", title: "读取连接失败", description: messageOf(cause) })
    }
  }, [toast])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError("")
    void Promise.allSettled([hnApi.connectorProvider(service), hnApi.connectorConnections()]).then(([providerResult, connectionResult]) => {
      if (cancelled) return
      if (providerResult.status === "fulfilled") setDetail(providerResult.value)
      else setError(messageOf(providerResult.reason))
      if (connectionResult.status === "fulfilled") setConnections(connectionResult.value.connections ?? [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [service])

  const ownConnections = connections.filter((item) => item.service === service && item.status !== "deleted")
  const actions = detail?.actions ?? []
  const filteredActions = useMemo(() => {
    const value = query.trim().toLocaleLowerCase()
    if (!value) return actions
    return actions.filter((action) =>
      [action.name, action.id, action.description ?? "", ...(action.requiredScopes ?? [])].join(" ").toLocaleLowerCase().includes(value),
    )
  }, [actions, query])
  const visibleGroups = useMemo(
    () =>
      groups
        .map((group) => ({ ...group, actions: filteredActions.filter((action) => operationGroup(action) === group.id) }))
        .filter((group) => group.actions.length > 0),
    [filteredActions],
  )

  const toggleGroup = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied((current) => current === key ? null : current), 1500)
    } catch (cause) {
      toast({ variant: "destructive", title: "复制失败", description: messageOf(cause) })
    }
  }

  const copyAction = (action: ConnectorAction) => copyText(action.id, action.id)


  if (loading && !provider) {
    return <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />读取连接器…</div>
  }

  if (!provider) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-16 text-center">
        <p className="text-[14px] font-medium">未找到这个应用</p>
        <p className="text-muted-foreground mt-1 text-[12px]">{service}</p>
        <Button variant="outline" size="sm" className="mt-4" asChild><Link to="/connectors">返回连接器</Link></Button>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-8 py-8">
        <Link to="/connectors" className="text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-1.5 text-[12px]">
          <ArrowLeft className="size-3.5" />连接器
        </Link>

        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
          <div className="flex min-w-0 items-start gap-3">
            <ConnectorMark service={provider.service} name={provider.displayName} iconUrl={provider.iconUrl} homepageUrl={provider.homepageUrl} size="lg" />
            <div className="min-w-0">
              <h1 className="text-[20px] leading-tight font-semibold tracking-tight">{provider.displayName}</h1>
              <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="font-mono">{provider.service}</span>
                <span className="rounded border px-1.5 py-0.5">{authLabel(provider.authTypes)}</span>
                <span>{provider.categories.map(categoryName).join(" · ")}</span>
              </div>
              {provider.description && <p className="text-muted-foreground mt-2 max-w-2xl text-[12px] leading-relaxed">{provider.description}</p>}
            </div>
          </div>
          {provider.homepageUrl && (
            <a href={provider.homepageUrl} target="_blank" rel="noreferrer">
              <Button variant="ghost" size="sm" className="gap-1.5">官网 <ExternalLink className="size-3.5" /></Button>
            </a>
          )}
        </header>

        {error && (
          <div className="text-muted-foreground mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px]">
            接口定义读取失败：{error}
          </div>
        )}

        <AppMcpPanel key={service} service={service} actions={actions} connections={ownConnections} noAuth={provider.authTypes.includes("no_auth")} />

        <section className="mt-5 overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div>
              <h2 className="text-[13px] font-medium">连接 {provider.displayName}</h2>
              <p className="text-muted-foreground mt-0.5 text-[11px]">连接后可在启用 Connector 的会话中调用下方接口。</p>
            </div>
            <Button size="sm" onClick={() => setDialog(true)} className="gap-1"><Plus className="size-3.5" />添加账号</Button>
          </div>
          {ownConnections.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-[12px] font-medium">暂无连接</p>
              <p className="text-muted-foreground mt-1 text-[11px]">添加账号后，连接器会加密保存凭据。</p>
            </div>
          ) : (
            ownConnections.map((connection) => (
              <div key={connection.id} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
                <span className={cn("size-1.5 shrink-0 rounded-full", connection.engineStatus === "active" ? "bg-emerald-500" : "bg-amber-500")} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium">{connection.alias || provider.displayName}</p>
                  <p className="text-muted-foreground mt-0.5 text-[11px]">
                    {connection.authType === "oauth2" ? "OAuth" : connection.authType === "api_key" ? "API Key" : "自定义凭据"} · {statusText(connection.engineStatus)}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setDialog(true)}>管理</Button>
              </div>
            ))
          )}
        </section>

        <section className="mt-5 overflow-hidden rounded-xl border bg-card">
          <button
            type="button"
            onClick={() => setShowActions((value) => !value)}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
            aria-expanded={showActions}
          >
            <span className="flex items-center gap-2">
              {showActions ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              <span className="text-[13px] font-medium">全部接口定义</span>
              <span className="text-muted-foreground rounded border px-1.5 py-0.5 text-[10px] tabular-nums">{actions.length}</span>
            </span>
            <span className="text-muted-foreground text-[11px]">只读与写入动作，可按名称搜索</span>
          </button>

          {showActions && (
            <div className="border-t">
              <div className="border-b px-4 py-3">
                <div className="relative max-w-sm">
                  <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                  <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索接口名称或 scope" className="h-8 pl-8 text-[12px]" />
                </div>
              </div>
              {visibleGroups.length === 0 ? (
                <p className="text-muted-foreground px-4 py-10 text-center text-[12px]">没有匹配的接口定义。</p>
              ) : (
                visibleGroups.map((group) => (
                  <div key={group.id} className="border-b last:border-b-0">
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.id)}
                      className="bg-muted/20 flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
                      aria-expanded={expanded.has(group.id)}
                    >
                      <span className="flex items-center gap-2">
                        {expanded.has(group.id) ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                        <span className="text-[12px] font-medium">{group.label}</span>
                        <span className="text-muted-foreground text-[10px]">{group.hint}</span>
                      </span>
                      <span className="text-muted-foreground rounded border px-1.5 py-0.5 text-[10px] tabular-nums">{group.actions.length}</span>
                    </button>
                    {expanded.has(group.id) && group.actions.map((action) => (
                      <div key={action.id} className="flex items-start gap-3 border-t px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-mono text-[12px] font-medium">{action.name}</p>
                            {action.requiredScopes?.map((scope) => (
                              <span key={scope} className="text-muted-foreground rounded border px-1.5 py-0.5 font-mono text-[10px]">{scope}</span>
                            ))}
                          </div>
                          {action.description && <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">{action.description}</p>}
                        </div>
                        <Button variant="ghost" size="icon" aria-label={`复制 ${action.id}`} onClick={() => void copyAction(action)}>
                          {copied === action.id ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
                        </Button>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          )}
        </section>
      </div>

      {dialog && (
        <ConnectorDialog
          provider={provider}
          connections={connections}
          onClose={() => setDialog(false)}
          onChanged={loadConnections}
        />
      )}
    </div>
  )
}
