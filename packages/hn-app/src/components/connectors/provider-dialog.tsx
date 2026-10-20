import { useEffect, useMemo, useState } from "react"
import { ArrowUpRight, Check, ExternalLink, Loader2, Plus, RotateCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/toast"
import { hnApi } from "@/lib/base-api"
import {
  authLabel,
  connectableAuthTypes,
  type ConnectorAuthOption,
  type ConnectorConnection,
  type ConnectorProvider,
} from "@/lib/connectors"
import { cn } from "@/lib/utils"
import { ConnectorMark } from "./connector-mark"

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const statusText = (status: string) =>
  status === "active" ? "可用" : status === "reauth_required" ? "需重新授权" : status === "disconnected" ? "已断开" : "异常"

const statusClass = (status: string) =>
  status === "active" ? "text-emerald-600 dark:text-emerald-400" : status === "reauth_required" ? "text-amber-600 dark:text-amber-400" : "text-destructive"

type AuthType = "api_key" | "custom_credential" | "oauth2"
type DialogProvider = ConnectorProvider & { auth?: Array<{ type: string; authorizationOptions?: ConnectorAuthOption[] }> }

const githubOptionText: Record<string, { label: string; description: string }> = {
  "read:user": { label: "基本账户信息", description: "读取已连接的 GitHub 账户资料，以便识别此连接。" },
  repo: { label: "仓库访问权限", description: "读取和修改公共及私有仓库、议题、拉取请求、状态和仓库内容。" },
  "user:email": { label: "电子邮件地址", description: "读取与已连接 GitHub 账户关联的电子邮件地址。" },
  workflow: { label: "GitHub Actions 工作流", description: "创建和更新 GitHub Actions 工作流文件。" },
  delete_repo: { label: "删除仓库", description: "通过 GitHub 永久删除仓库。" },
}

export function ConnectorDialog({
  provider,
  connections,
  onClose,
  onChanged,
}: {
  provider: DialogProvider
  connections: ConnectorConnection[]
  onClose: () => void
  onChanged: () => Promise<void> | void
}) {
  const toast = useToast()
  const authTypes = useMemo(() => {
    // GitHub reuses the Git OAuth App, so its OAuth flow is ready; other services prefer a
    // credential so a missing platform OAuth client does not block first use.
    const rank: Record<AuthType, number> = provider.service === "github"
      ? { oauth2: 0, api_key: 1, custom_credential: 2 }
      : { api_key: 0, oauth2: 1, custom_credential: 2 }
    return [...connectableAuthTypes(provider)].sort((a, b) => rank[a] - rank[b])
  }, [provider])
  const oauthOptions = useMemo(
    () => provider.auth?.find((item) => item.type === "oauth2")?.authorizationOptions ?? [],
    [provider],
  )
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(
    () => new Set(oauthOptions.filter((option) => option.required || option.defaultSelected).map((option) => option.id)),
  )
  const [authType, setAuthType] = useState<AuthType>(authTypes[0] ?? "api_key")
  const [alias, setAlias] = useState(provider.displayName)
  const [secret, setSecret] = useState("")
  const [pairs, setPairs] = useState([{ key: "", value: "" }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [oauth, setOauth] = useState<{ requestID: string; url: string } | null>(null)
  const existing = connections.filter((item) => item.service === provider.service && item.status !== "deleted")

  useEffect(() => {
    if (!oauth) return
    let cancelled = false
    let attempts = 0
    const tick = async () => {
      attempts += 1
      try {
        const result = await hnApi.completeConnectorOAuth(oauth.requestID, alias.trim() || undefined)
        if (cancelled) return
        if (result.status === "connected") {
          setOauth(null)
          toast({ title: `${provider.displayName} 已连接`, description: "连接器已加入你的个人连接空间" })
          await onChanged()
          onClose()
          return
        }
        if (result.status === "failed" || result.status === "expired") {
          setOauth(null)
          setError(result.errorCode ? `授权失败：${result.errorCode}` : "授权已失败或过期，请重新发起")
          return
        }
        if (attempts >= 60) {
          setOauth(null)
          setError("授权等待超时，请确认已在浏览器完成授权后重试")
        }
      } catch (cause) {
        if (!cancelled) setError(messageOf(cause))
      }
    }
    const timer = setInterval(() => void tick(), 2000)
    void tick()
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [oauth, alias, onChanged, onClose, provider.displayName, toast])

  const startOAuth = async (connectionID?: string) => {
    setBusy(true)
    setError("")
    try {
      const started = connectionID
        ? await hnApi.reconnectConnector(connectionID)
        : await hnApi.startConnectorOAuth({
            service: provider.service,
            alias: alias.trim() || undefined,
            ...(oauthOptions.length
              ? {
                  authorizationOptionIds: oauthOptions
                    .filter((option) => option.required || selectedOptions.has(option.id))
                    .map((option) => option.id),
                }
              : {}),
          })
      setOauth({ requestID: started.connectionRequestID, url: started.authorizationUrl })
      window.open(started.authorizationUrl, "_blank", "noopener,noreferrer")
    } catch (cause) {
      const message = messageOf(cause)
      setError(
        /Configure an OAuth client/i.test(message)
          ? `${provider.displayName} 尚未配置 OAuth 客户端。请改用 API Key，或让管理员先配置该服务的 OAuth 应用。`
          : message,
      )
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    setError("")
    if (!authTypes.length) return
    if (authType === "oauth2") {
      await startOAuth()
      return
    }
    const values =
      authType === "api_key"
        ? { apiKey: secret.trim() }
        : Object.fromEntries(pairs.filter((pair) => pair.key.trim()).map((pair) => [pair.key.trim(), pair.value]))
    if (authType === "api_key" && !secret.trim()) return setError("请填写 API Key")
    if (authType === "custom_credential" && Object.keys(values).length === 0) return setError("请至少填写一组凭据")
    setBusy(true)
    try {
      await hnApi.createConnectorConnection({
        service: provider.service,
        authType,
        values,
        ...(alias.trim() ? { alias: alias.trim() } : {}),
      })
      toast({ title: `${provider.displayName} 已连接`, description: "连接器已加入你的个人连接空间" })
      await onChanged()
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (connection: ConnectorConnection) => {
    setBusy(true)
    setError("")
    try {
      await hnApi.deleteConnectorConnection(connection.id)
      setRemoveId(null)
      toast({ title: "连接已移除", description: `${connection.alias || provider.displayName} 已从连接器空间移除` })
      await onChanged()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <ConnectorMark service={provider.service} name={provider.displayName} iconUrl={provider.iconUrl} homepageUrl={provider.homepageUrl} size="lg" />
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2 text-base">
                {provider.displayName}
                {provider.homepageUrl && (
                  <a href={provider.homepageUrl} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" aria-label="打开应用官网">
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </DialogTitle>
              <DialogDescription className="mt-1">
                {provider.description || provider.categories.join(" · ") || provider.service}
              </DialogDescription>
              <div className="text-muted-foreground mt-2 flex flex-wrap gap-2 text-[11px]">
                <span className="rounded border px-1.5 py-0.5">{authLabel(provider.authTypes)}</span>
                {provider.categories.slice(0, 2).map((category) => <span key={category}>{category}</span>)}
              </div>
            </div>
          </div>
        </DialogHeader>

        {existing.length > 0 && (
          <section className="space-y-2" aria-label="已配置连接">
            <h4 className="text-[12px] font-medium">已配置连接</h4>
            <div className="overflow-hidden rounded-lg border">
              {existing.map((connection, index) => (
                <div key={connection.id} className={cn("flex items-center gap-2 px-3 py-2.5", index > 0 && "border-t")}>
                  <span className={cn("size-1.5 shrink-0 rounded-full", connection.engineStatus === "active" ? "bg-emerald-500" : "bg-amber-500")} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium">{connection.alias || provider.displayName}</p>
                    <p className={cn("text-[11px]", statusClass(connection.engineStatus))}>{statusText(connection.engineStatus)}</p>
                  </div>
                  {removeId === connection.id ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove(connection)}>确认移除</Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoveId(null)}>取消</Button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-0.5">
                      {connection.authType === "oauth2" && (
                        <Button size="icon" variant="ghost" aria-label="重新授权" disabled={busy} onClick={() => void startOAuth(connection.id)}>
                          <RotateCw className="size-3.5" />
                        </Button>
                      )}
                      <Button size="icon" variant="ghost" aria-label="移除连接" disabled={busy} onClick={() => setRemoveId(connection.id)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {authTypes.length === 0 ? (
          <div className="rounded-lg border bg-muted/30 px-3 py-3 text-[12px] leading-relaxed">
            该应用免配置，可直接在启用连接器的会话中使用。
          </div>
        ) : (
          <section className="space-y-4 border-t pt-4">
            <div>
              <h4 className="text-[12px] font-medium">{existing.length ? "添加另一个账号" : "连接账号"}</h4>
              <p className="text-muted-foreground mt-1 text-[11px]">凭据由连接器服务加密保存，前端不会持久化密钥。</p>
            </div>
            {authTypes.length > 1 && (
              <label className="block space-y-1.5 text-[12px]">
                <span className="font-medium">认证方式</span>
                <select value={authType} onChange={(event) => setAuthType(event.target.value as AuthType)} className="bg-background h-9 w-full rounded-md border px-2">
                  {authTypes.map((type) => <option key={type} value={type}>{type === "api_key" ? "API Key" : type === "oauth2" ? "OAuth 授权" : "自定义凭据"}</option>)}
                </select>
              </label>
            )}
            <label className="block space-y-1.5 text-[12px]">
              <span className="font-medium">显示名称（可选）</span>
              <Input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder={provider.displayName} />
            </label>
            {authType === "oauth2" ? (
              <div className="space-y-3">
                {oauthOptions.length > 0 && (
                  <fieldset className="overflow-hidden rounded-lg border">
                    <legend className="sr-only">授权权限</legend>
                    <div className="border-b px-3 py-2.5">
                      <p className="text-[12px] font-medium">授权权限</p>
                      <p className="text-muted-foreground mt-0.5 text-[11px]">前往服务商授权前，选择允许此连接使用的权限。</p>
                    </div>
                    <div className="divide-y">
                      {oauthOptions.map((option) => {
                        const localized = provider.service === "github" ? githubOptionText[option.id] : undefined
                        return (
                          <label key={option.id} className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 text-[12px]">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={option.required || selectedOptions.has(option.id)}
                              disabled={option.required || busy}
                              onChange={(event) => {
                                setSelectedOptions((current) => {
                                  const next = new Set(current)
                                  if (event.target.checked) next.add(option.id)
                                  else next.delete(option.id)
                                  return next
                                })
                              }}
                            />
                            <span className="min-w-0">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span className="font-medium">{localized?.label ?? option.label}</span>
                                {option.required && <span className="text-muted-foreground text-[10px]">必需</span>}
                                {option.risk === "destructive" && <span className="text-destructive text-[10px] font-medium">高风险</span>}
                              </span>
                              <span className="text-muted-foreground mt-0.5 block text-[11px] leading-relaxed">
                                {localized?.description ?? option.description}
                              </span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </fieldset>
                )}
                <p className="text-muted-foreground text-[12px]">将在新标签页打开服务商授权页面，完成后自动回到这里。</p>
                {oauthOptions.length === 0 && <p className="text-muted-foreground text-[11px]">OAuth 需要平台预先配置该服务的 OAuth Client；未配置时会提示切换认证方式。</p>}
                {authTypes.includes("api_key") && (
                  <Button size="sm" variant="outline" onClick={() => setAuthType("api_key")}>改用 API Key</Button>
                )}
                {oauth && (
                  <a href={oauth.url} target="_blank" rel="noreferrer" className="text-foreground inline-flex items-center gap-1 text-[12px] underline underline-offset-2">
                    重新打开授权页面 <ArrowUpRight className="size-3" />
                  </a>
                )}
                {oauth && <p className="text-muted-foreground flex items-center gap-1.5 text-[11px]"><Loader2 className="size-3 animate-spin" />等待授权完成…</p>}
              </div>
            ) : authType === "api_key" ? (
              <label className="block space-y-1.5 text-[12px]">
                <span className="font-medium">API Key</span>
                <Input type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="粘贴服务商提供的 API Key" />
              </label>
            ) : (
              <div className="space-y-2">
                <span className="text-[12px] font-medium">凭据字段</span>
                {pairs.map((pair, index) => (
                  <div key={index} className="flex gap-2">
                    <Input aria-label={`字段名 ${index + 1}`} placeholder="字段名" value={pair.key} onChange={(event) => setPairs(pairs.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} className="min-w-0 flex-1 font-mono text-xs" />
                    <Input aria-label={`字段值 ${index + 1}`} type="password" autoComplete="off" placeholder="值" value={pair.value} onChange={(event) => setPairs(pairs.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} className="min-w-0 flex-1 font-mono text-xs" />
                    <Button size="icon" variant="ghost" aria-label={`移除字段 ${index + 1}`} onClick={() => setPairs(pairs.filter((_, i) => i !== index))}><Trash2 className="size-3.5" /></Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={() => setPairs([...pairs, { key: "", value: "" }])}><Plus className="mr-1 size-3" />添加字段</Button>
              </div>
            )}
          </section>
        )}

        {error && <p role="alert" className="text-destructive rounded-lg border border-destructive/30 px-3 py-2 text-[12px]">{error}</p>}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button>
          {authTypes.length > 0 && (
            <Button disabled={busy || Boolean(oauth)} onClick={() => void submit()} className="gap-1.5">
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {authType === "oauth2" ? `继续前往 ${provider.displayName}` : existing.length ? "添加账号" : "连接"}
              {!busy && authType !== "oauth2" && <Check className="size-3.5" />}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
