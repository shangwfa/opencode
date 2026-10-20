import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2, Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { hnApi } from "@/lib/base-api"
import type { ConnectorAction, ConnectorConnection, ConnectorMcpDeployment, ConnectorMcpIssued } from "@/lib/connectors"

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)
const kind = (action: ConnectorAction) => ["read", "write", "destructive"].includes(action.operationType) ? action.operationType : "other"
const labels: Record<string, string> = { read: "只读", write: "写入", destructive: "危险", other: "未分类" }

export function AppMcpPanel({ service, actions, connections, noAuth }: {
  service: string; actions: ConnectorAction[]; connections: ConnectorConnection[]; noAuth: boolean
}) {
  const [items, setItems] = useState<ConnectorMcpDeployment[]>([])
  const [publicBaseUrl, setPublicBaseUrl] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState<ConnectorMcpDeployment | "new" | null>(null)
  const [name, setName] = useState("")
  const [connectionId, setConnectionId] = useState("")
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState("all")
  const [dirty, setDirty] = useState(false)
  const [issued, setIssued] = useState<ConnectorMcpIssued | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmContracts, setConfirmContracts] = useState(false)
  const accounts = connections.filter((item) => item.service === service && item.status === "active" && item.engineStatus === "active")
  const reload = useCallback(async () => {
    const result = await hnApi.connectorMcpDeployments()
    setItems(result.deployments.filter((item) => item.service === service))
    setPublicBaseUrl(result.publicBaseUrl)
    setLoaded(true)
  }, [service])
  useEffect(() => {
    let active = true
    setLoaded(false)
    void hnApi.connectorMcpDeployments().then((result) => {
      if (!active) return
      setItems(result.deployments.filter((item) => item.service === service))
      setPublicBaseUrl(result.publicBaseUrl)
      setLoaded(true)
    }).catch((cause) => { if (active) setError(messageOf(cause)) })
    return () => { active = false }
  }, [service])
  const visible = useMemo(() => actions.filter((action) =>
    (filter === "all" || kind(action) === filter) &&
    `${action.id} ${action.description ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  ), [actions, query, filter])
  const urlFor = (id: string) => `${publicBaseUrl}/api/connector/mcp/${id}`
  const open = (item: ConnectorMcpDeployment | "new") => {
    setEditing(item); setError(""); setDirty(false); setQuery(""); setFilter("all"); setConfirmContracts(false)
    setName(item === "new" ? `${service} MCP` : item.name)
    setConnectionId(item === "new" ? accounts[0]?.id ?? "" : item.connectionId ?? "")
    setSelected(new Set(item === "new" ? actions.filter((action) => kind(action) === "read").map((action) => action.id) : item.tools.map((tool) => tool.actionId)))
  }
  const close = () => {
    if (busy || (dirty && !window.confirm("有未保存的修改，确定放弃？"))) return
    setEditing(null)
  }
  const perform = async (work: () => Promise<void>) => {
    setBusy(true); setError("")
    try { await work(); await reload() } catch (cause) { setError(messageOf(cause)) } finally { setBusy(false) }
  }
  const save = () => perform(async () => {
    if (!editing) return
    const dangerous = actions.some((action) => selected.has(action.id) && kind(action) === "destructive")
    if ((dangerous || editing !== "new") && !window.confirm("该工具权限将对所有使用此 MCP 的客户端生效。确定保存？")) return
    if (editing === "new") {
      const result = await hnApi.createConnectorMcp({ name, service, connectionId: connectionId || undefined, actionIds: [...selected] })
      setIssued(result); setCopied(false)
    } else {
      await hnApi.updateConnectorMcp(editing.id, { revision: editing.revision, name, actionIds: [...selected], confirmContracts })
    }
    setEditing(null); setDirty(false)
  })
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true) } catch (cause) { setError(messageOf(cause)) }
  }
  return <section className="mt-5 overflow-hidden rounded-xl border bg-card">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
      <div><h2 className="text-[13px] font-medium">应用 MCP</h2><p className="text-muted-foreground mt-0.5 text-[11px]">固定账号，自选工具；OpenCode、Cursor 等客户端共用标准地址和令牌。</p></div>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" disabled={busy} aria-label="刷新 MCP" onClick={() => void perform(async () => {})}><RefreshCw className="size-3" /></Button>
        <Button size="sm" disabled={busy || !loaded || !actions.length || (!accounts.length && !noAuth)} onClick={() => open("new")}><Plus className="mr-1 size-3" />创建 MCP</Button>
      </div>
    </div>
    {error ? <p role="alert" className="text-destructive px-4 py-3 text-xs">{error}</p> : null}
    <div className="space-y-3 p-4">
      {!items.length ? <p className="text-muted-foreground text-xs">{loaded ? "尚未创建应用 MCP。创建时选择需要开放的工具。" : "正在读取 MCP 配置…"}</p> : null}
      {items.map((item) => <div key={item.id} className="rounded-lg border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><p className="text-xs font-medium">{item.name} <span className="text-muted-foreground font-normal">· {item.status === "active" ? "启用" : "停用"} · {item.tools.length} 个工具</span></p>
            <p className="text-muted-foreground mt-1 text-[11px]">{connections.find((account) => account.id === item.connectionId)?.accountLabel ?? item.connectionId ?? "公开应用"} · {item.tokenPrefix}…</p></div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => open(item)}>编辑工具</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void perform(async () => { await hnApi.updateConnectorMcp(item.id, { revision: item.revision, status: item.status === "active" ? "disabled" : "active" }) })}>{item.status === "active" ? "停用" : "启用"}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
              if (window.confirm("轮换后所有客户端的旧令牌立即失效，确定继续？")) void perform(async () => { setIssued(await hnApi.rotateConnectorMcp(item.id, item.revision)); setCopied(false) })
            }}>轮换令牌</Button>
            <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => {
              if (window.confirm("删除后所有客户端将无法继续使用此 MCP，确定删除？")) void perform(async () => { await hnApi.deleteConnectorMcp(item.id) })
            }}>删除</Button>
          </div>
        </div>
        <p className="text-muted-foreground mt-2 break-all font-mono text-[11px]">{urlFor(item.id)}</p>
      </div>)}
      <p className="text-muted-foreground text-[11px]">同一 MCP 的工具变更、停用和令牌轮换影响所有使用端。需要独立权限时，请另建 MCP。远端客户端必须能访问该地址。</p>
    </div>
    <Dialog open={editing !== null} onOpenChange={(value) => { if (!value) close() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{editing === "new" ? "创建应用 MCP" : "编辑应用 MCP"}</DialogTitle><DialogDescription>账号创建后不可更换。选中的 action 直接成为客户端可调用的工具，权限仍受第三方授权限制。</DialogDescription></DialogHeader>
        <label className="space-y-1 text-xs">名称<Input value={name} maxLength={100} onChange={(event) => { setName(event.target.value); setDirty(true) }} /></label>
        {editing === "new" ? <label className="space-y-1 text-xs">绑定账号<select className="bg-background h-9 w-full rounded-md border px-2" value={connectionId} onChange={(event) => { setConnectionId(event.target.value); setDirty(true) }}>
          {noAuth ? <option value="">公开应用（不使用账号）</option> : null}
          {!noAuth && !accounts.length ? <option value="">请先授权账号</option> : null}
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.accountLabel ?? account.alias ?? account.id}</option>)}
        </select></label> : null}
        <div className="flex flex-wrap gap-2"><Input className="min-w-40 flex-1" placeholder="搜索工具…" aria-label="搜索 MCP 工具" value={query} onChange={(event) => setQuery(event.target.value)} />
          <select aria-label="筛选工具风险" className="bg-background rounded-md border px-2 text-xs" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部类型</option>{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs"><span>已选 {selected.size} / {actions.length}</span>
          <Button size="sm" variant="ghost" onClick={() => { setSelected((old) => new Set([...old, ...visible.map((action) => action.id)])); setDirty(true) }}>全选筛选结果</Button>
          <Button size="sm" variant="ghost" onClick={() => { setSelected(new Set()); setDirty(true) }}>清空</Button></div>
        <div className="max-h-72 overflow-y-auto rounded-md border">
          {visible.map((action) => <label key={action.id} className="flex cursor-pointer items-start gap-2 border-b p-3 last:border-0">
            <input type="checkbox" className="mt-1" checked={selected.has(action.id)} onChange={(event) => { const checked = event.target.checked; setSelected((old) => { const next = new Set(old); if (checked) next.add(action.id); else next.delete(action.id); return next }); setDirty(true) }} />
            <span className="min-w-0 text-xs"><span className="break-all font-mono">{action.name || action.id}</span> <span className={kind(action) === "destructive" ? "text-destructive" : "text-muted-foreground"}>{labels[kind(action)]}</span>
              <span className="text-muted-foreground mt-1 block">{action.description}</span>{action.requiredScopes?.length ? <span className="text-muted-foreground mt-1 block">所需 scope：{action.requiredScopes.join(", ")}</span> : null}</span>
          </label>)}
          {!visible.length ? <p className="text-muted-foreground p-3 text-xs">没有匹配的工具。</p> : null}
        </div>
        {editing && editing !== "new" ? <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={confirmContracts} onChange={(event) => { setConfirmContracts(event.target.checked); setDirty(true) }} />我已查看当前动作说明、参数和权限要求，确认更新所选工具的执行契约。</label> : null}
        {error ? <p role="alert" className="text-destructive text-xs">{error}</p> : null}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={close}>取消</Button><Button disabled={busy || !name.trim() || !selected.size || (editing === "new" && !connectionId && !noAuth)} onClick={() => void save()}>{busy ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}保存</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={issued !== null} onOpenChange={(value) => { if (!value) { setIssued(null); setCopied(false) } }}>
      <DialogContent><DialogHeader><DialogTitle>MCP 接入配置</DialogTitle><DialogDescription>令牌只显示这一次。请安全保存，不要发送到聊天或提交到代码仓库。</DialogDescription></DialogHeader>
        {issued ? <><pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-[11px]">{JSON.stringify({ url: urlFor(issued.deployment.id), headers: { Authorization: `Bearer ${issued.token}` } }, null, 2)}</pre>
          <p className="text-muted-foreground text-xs">这是标准 HTTP 地址与请求头，请按客户端要求填写。OpenCode 使用 remote MCP 并关闭 OAuth；其他客户端兼容性仍需实际验证。</p>
          <DialogFooter><Button onClick={() => void copy(JSON.stringify({ url: urlFor(issued.deployment.id), headers: { Authorization: `Bearer ${issued.token}` } }, null, 2))}>{copied ? "已复制" : "复制配置"}</Button></DialogFooter></> : null}
      </DialogContent>
    </Dialog>
  </section>
}
