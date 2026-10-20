/**
 * Git 服务连接页。
 *
 * 设计参考：
 *  - Linear Integrations：卡片列表 + 状态徽章 + 行内操作
 *  - Vercel / Netlify 的 Git 连接：已连接实例的紧凑列表与「重新校验」
 *  - GitHub Settings → Applications：授权范围（只读/读写）与凭据脱敏展示
 *
 * 网关模式（VITE_HN_BASE_URL）下可用；未启用时给出明确提示。
 */
import { useCallback, useEffect, useState } from "react"
import { useSearchParams } from "react-router"
import {
  Check,
  ChevronRight,
  GitBranch,
  Github,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/toast"
import { BaseApiError, hnApi, type HnGitProvider } from "@/lib/base-api"
import { fetchAuthConfig } from "@/lib/auth"
import { usingBaseServer } from "@/lib/session-source"
import { cn } from "@/lib/utils"
import { AlertNotice, EmptyBlock, Field, ProviderLogo, type GitProviderType } from "@/components/settings/settings-ui"

type ProviderType = GitProviderType

const PROVIDER_META: Record<
  ProviderType,
  { name: string; host: string; note: string; scopes: { read: string; write: string } }
> = {
  gitlab: {
    name: "GitLab",
    host: "https://gitlab.com",
    note: "支持自建实例（填根地址，如 https://gitlab.company.com）",
    scopes: {
      read: "read_api + read_repository",
      write: "api + write_repository",
    },
  },
  github: {
    name: "GitHub",
    host: "https://github.com",
    note: "GitHub.com 或企业版（填 https://github.company.com）",
    scopes: {
      read: "Contents: read, Pull requests: read",
      write: "Administration: write, Contents: read/write, Pull requests: read/write",
    },
  },
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

function formatDate(ts?: number): string {
  if (!ts) return ""
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function GitProvidersPage() {
  const toast = useToast()
  const enabled = usingBaseServer()
  const [searchParams, setSearchParams] = useSearchParams()
  const [items, setItems] = useState<HnGitProvider[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState("")
  const [addOpen, setAddOpen] = useState(false)
  const [deleting, setDeleting] = useState<HnGitProvider | null>(null)
  const [verifying, setVerifying] = useState<string | null>(null)
  const [reauthorizing, setReauthorizing] = useState<string | null>(null)

  const reauthorize = async (item: HnGitProvider) => {
    setReauthorizing(item.id)
    try {
      const result = await hnApi.startGitOAuth(item.type, {
        instanceId: item.id, baseUrl: item.baseUrl, scope: "write", displayName: item.displayName,
      })
      window.location.assign(result.url)
    } catch (error) {
      toast({ variant: "destructive", title: "重新授权失败", description: error instanceof Error ? error.message : String(error) })
    } finally {
      setReauthorizing(null)
    }
  }

  const load = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setError("")
    try {
      const res = await hnApi.gitProviders()
      setItems(res.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void load()
  }, [load])

  // OAuth 回调落地：?connected=<id> 或 ?error=<msg>
  useEffect(() => {
    const connected = searchParams.get("connected")
    const error = searchParams.get("error")
    if (!connected && !error) return
    if (connected) {
      toast({ title: "已连接", description: "Git 服务授权成功" })
      void load()
    } else if (error) {
      toast({ variant: "destructive", title: "授权失败", description: error })
    }
    const next = new URLSearchParams(searchParams)
    next.delete("connected")
    next.delete("error")
    next.delete("provider")
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const verify = async (item: HnGitProvider) => {
    setVerifying(item.id)
    try {
      const res = await hnApi.verifyGitProvider(item.id)
      toast({ title: "连接正常", description: `已通过 ${res.identity?.username ?? "Git 服务"} 校验` })
      await load()
    } catch (err) {
      toast({
        variant: "destructive",
        title: "校验失败",
        description: err instanceof Error ? err.message : String(err),
      })
      await load()
    } finally {
      setVerifying(null)
    }
  }

  const remove = async () => {
    if (!deleting) return
    try {
      await hnApi.deleteGitProvider(deleting.id)
      toast({ title: "已删除", description: deleting.displayName })
      setDeleting(null)
      await load()
    } catch (err) {
      toast({
        variant: "destructive",
        title: "删除失败",
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-10">
        <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[22px] leading-tight font-semibold tracking-tight">Git 服务连接</h1>
            <p className="text-muted-foreground mt-1.5 text-sm">
              连接 GitLab / GitHub，用于建仓、提交代码与创建 PR/MR
            </p>
          </div>
          <Button onClick={() => setAddOpen(true)} disabled={!enabled} className="gap-1.5">
            <Plus className="size-4" />
            添加服务
          </Button>
        </header>

        {!enabled && (
          <AlertNotice tone="warn" icon={<TriangleAlert className="size-4" />}>
            未启用网关模式（<code className="text-[11px]">VITE_HN_BASE_URL</code>）。Git 服务连接依赖
            hn-base-server 的凭据管理与归属校验。
          </AlertNotice>
        )}

        {enabled && loading ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-20 text-sm">
            <Loader2 className="size-4 animate-spin" /> 读取 Git 服务…
          </div>
        ) : enabled && error ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <TriangleAlert className="size-5 text-amber-500" />
            <p className="text-muted-foreground text-sm">{error}</p>
            <Button size="sm" variant="secondary" onClick={() => void load()} className="gap-1.5">
              <RefreshCw className="size-3.5" /> 重试
            </Button>
          </div>
        ) : items.length === 0 ? (
          <EmptyBlock
            icon={<GitBranch className="size-5" />}
            title="还没有连接 Git 服务"
            description="添加一个 GitLab 或 GitHub 实例，开始建仓与提交代码"
            action={
              <Button size="sm" onClick={() => setAddOpen(true)} disabled={!enabled} className="gap-1.5">
                <Plus className="size-3.5" /> 添加服务
              </Button>
            }
          />
        ) : (
          <div className="overflow-hidden rounded-xl border">
            {items.map((item, index) => (
              <ProviderRow
                key={item.id}
                item={item}
                first={index === 0}
                verifying={verifying === item.id}
                reauthorizing={reauthorizing === item.id}
                onReauthorize={() => void reauthorize(item)}
                onVerify={() => void verify(item)}
                onDelete={() => setDeleting(item)}
              />
            ))}
          </div>
        )}

        <AddProviderDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          onCreated={async () => {
            setAddOpen(false)
            await load()
          }}
        />

        <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>删除「{deleting?.displayName}」？</DialogTitle>
              <DialogDescription>
                凭据会立即删除，使用该服务的需求将无法再建仓 / 提交 / 创建 PR。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleting(null)}>
                取消
              </Button>
              <Button variant="destructive" onClick={() => void remove()} className="gap-1.5">
                <Trash2 className="size-3.5" />
                删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}

function ProviderRow({
  item,
  first,
  verifying,
  onVerify,
  onDelete,
  reauthorizing,
  onReauthorize,
}: {
  item: HnGitProvider
  first: boolean
  verifying: boolean
  onVerify: () => void
  onDelete: () => void
  reauthorizing: boolean
  onReauthorize: () => void
}) {
  const meta = PROVIDER_META[item.type]
  const invalid = item.status === "invalid"
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/40",
        !first && "border-t",
      )}
    >
      <ProviderLogo type={item.type} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[13px] font-medium">{item.displayName}</p>
          {invalid ? (
            <Badge variant="outline" className="border-destructive/30 text-destructive shrink-0 text-[10px]">
              凭据失效
            </Badge>
          ) : (
            <Badge variant="outline" className="shrink-0 gap-1 text-[10px]">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              已连接
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-[11px]">
          {meta.name} · {hostOf(item.baseUrl)}
          {item.ownerType === "org" ? " · 组织" : " · 个人"}
          {item.secretHint ? ` · ${item.secretHint}` : ""}
          {item.timeCreated ? ` · ${formatDate(item.timeCreated)}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {invalid && (
          <Button variant="outline" size="sm" disabled={reauthorizing} onClick={onReauthorize} className="h-8 gap-1.5 text-[12px]">
            {reauthorizing && <Loader2 className="size-3.5 animate-spin" />}
            重新授权
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onVerify}
          disabled={verifying}
          className="text-muted-foreground hover:text-foreground h-8 gap-1.5 px-2 text-[12px]"
        >
          {verifying ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          校验
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="删除"
          onClick={onDelete}
          className="text-muted-foreground hover:text-destructive size-8"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

/** 添加服务：选类型 → 填实例与 token → 后端先校验再入库 */
function AddProviderDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => Promise<void> | void
}) {
  const toast = useToast()
  const [type, setType] = useState<ProviderType | null>(null)
  const [displayName, setDisplayName] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [token, setToken] = useState("")
  const [scope, setScope] = useState<"read" | "write">("write")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  /** 授权方式：oauth（默认） / token */
  const [authMode, setAuthMode] = useState<"oauth" | "token">("oauth")
  const [gitOAuth, setGitOAuth] = useState({ github: false, gitlab: false })

  useEffect(() => {
    if (!open) return
    void fetchAuthConfig().then((config) => setGitOAuth(config.gitOAuth))
  }, [open])

  const oauthAvailable = type ? gitOAuth[type] : false

  const reset = () => {
    setType(null)
    setAuthMode("oauth")
    setDisplayName("")
    setBaseUrl("")
    setToken("")
    setScope("write")
    setError("")
    setBusy(false)
  }

  const meta = type ? PROVIDER_META[type] : null

  const submit = async () => {
    if (!type || busy) return
    // OAuth2：拿授权地址后整页跳转，回调由 /git-providers?connected= 处理
    if (authMode === "oauth") {
      setBusy(true)
      setError("")
      try {
        const res = await hnApi.startGitOAuth(type, {
          baseUrl: baseUrl.trim() || meta!.host,
          scope,
          displayName: displayName.trim() || meta!.name,
        })
        window.location.href = res.url
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      }
      return
    }
    if (!token.trim()) {
      setError("请填写访问令牌")
      return
    }
    setBusy(true)
    setError("")
    try {
      await hnApi.createGitProvider({
        type,
        displayName: displayName.trim() || meta!.name,
        baseUrl: baseUrl.trim() || meta!.host,
        token: token.trim(),
        scope,
      })
      toast({ title: "已连接", description: `${displayName.trim() || meta!.name} 校验通过` })
      reset()
      await onCreated()
    } catch (err) {
      if (err instanceof BaseApiError) {
        setError(`${err.message}${err.field ? `（${err.field}）` : ""}`)
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加 Git 服务</DialogTitle>
          <DialogDescription>
            令牌仅加密保存在服务端，用于建仓、提交与创建 PR/MR；不会返回给浏览器。
          </DialogDescription>
        </DialogHeader>

        {!type ? (
          <div className="grid gap-2 py-1">
            {(Object.keys(PROVIDER_META) as ProviderType[]).map((key) => {
              const item = PROVIDER_META[key]
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setType(key)
                    setBaseUrl(item.host)
                    setDisplayName(item.name)
                    setError("")
                    setAuthMode(gitOAuth[key] ? "oauth" : "token")
                  }}
                  className="hover:bg-muted/60 flex items-center gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors"
                >
                  <ProviderLogo type={key} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium">{item.name}</p>
                    <p className="text-muted-foreground mt-0.5 text-[11px]">{item.note}</p>
                  </div>
                  <ChevronRight className="text-muted-foreground size-4 shrink-0" />
                </button>
              )
            })}
          </div>
        ) : (
          <div className="space-y-4 py-1">
            <div className="flex items-center gap-2.5">
              <ProviderLogo type={type} size="sm" />
              <p className="text-[13px] font-medium">{meta!.name}</p>
              <Button variant="ghost" size="sm" onClick={() => setType(null)} className="ml-auto h-7 text-[11px]">
                更换
              </Button>
            </div>

            <Field label="显示名称">
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={meta!.name}
                className="h-9"
              />
            </Field>

            <Field label="实例地址" hint={type === "gitlab" ? "支持自建" : undefined}>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={meta!.host}
                className="h-9"
              />
            </Field>

            <div className="space-y-1.5">
              <p className="text-[13px] font-medium">授权方式</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={!oauthAvailable}
                  onClick={() => setAuthMode("oauth")}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    authMode === "oauth" ? "border-foreground/25 bg-muted/60" : "hover:bg-muted/40",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[12px] font-medium">
                    {authMode === "oauth" && <Check className="size-3" />}
                    OAuth2
                    <span className="text-muted-foreground/70 text-[10px] font-normal">推荐</span>
                  </span>
                  <span className="text-muted-foreground mt-0.5 block text-[10px] leading-relaxed">
                    {oauthAvailable ? "跳转授权，无需手填令牌" : "未配置 OAuth 应用"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setAuthMode("token")}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors",
                    authMode === "token" ? "border-foreground/25 bg-muted/60" : "hover:bg-muted/40",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[12px] font-medium">
                    {authMode === "token" && <Check className="size-3" />}
                    Access Token
                  </span>
                  <span className="text-muted-foreground mt-0.5 block text-[10px] leading-relaxed">
                    手动填写个人访问令牌
                  </span>
                </button>
              </div>
            </div>

            {authMode === "token" && (
              <Field label="访问令牌" hint="加密存储">
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={type === "github" ? "ghp_… / github_pat_…" : "glpat-…"}
                  autoComplete="off"
                  className="h-9"
                />
              </Field>
            )}

            <div className="space-y-1.5">
              <p className="text-[13px] font-medium">授权范围</p>
              <div className="grid grid-cols-2 gap-2">
                {(["read", "write"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setScope(value)}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors",
                      scope === value ? "border-foreground/25 bg-muted/60" : "hover:bg-muted/40",
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-[12px] font-medium">
                      {scope === value && <Check className="size-3" />}
                      {value === "read" ? "只读" : "读写"}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-[10px] leading-relaxed">
                      {meta!.scopes[value]}
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-muted-foreground/80 flex items-start gap-1 text-[11px] leading-relaxed">
                <ShieldCheck className="mt-px size-3 shrink-0" />
                {authMode === "oauth"
                  ? "OAuth2 将跳转授权页；GitHub 会申请 repo（私有仓库读写），GitLab 按所选范围申请 api / read_api。"
                  : "需要建仓或提交代码请选择「读写」；仅查看分支/PR 选择「只读」。"}
              </p>
            </div>

            {error && (
              <p
                role="alert"
                className="border-destructive/25 bg-destructive/[0.08] text-destructive rounded-lg border px-3 py-2 text-[12px] leading-relaxed break-all"
              >
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {type ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                取消
              </Button>
              <Button onClick={() => void submit()} disabled={busy} className="gap-1.5">
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                {busy ? (authMode === "oauth" ? "跳转中…" : "校验中…") : authMode === "oauth" ? "使用 " + meta!.name + " 授权" : "连接并校验"}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
