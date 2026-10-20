/**
 * 应用（前端项目）列表与创建向导。
 *
 * 创建流程（方案 B）：
 *  1. 应用信息（名称 / appId / domain）
 *  2. 代码仓库（选择已连接的 Git 服务；新建仓库或填已有 owner/repo）
 *  3. 技术栈确认（Vite + React + TS + Tailwind v4 + shadcn/ui）→ 创建
 *
 * 后端：建仓 → 提交脚手架 → 写应用记录与归属；app 记录字段对齐 hn-gateway 的 apps 表。
 */
import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router"
import {
  AlertCircle,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
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
import { BaseApiError, hnApi, type HnApp, type HnGitProvider } from "@/lib/base-api"
import { usingBaseServer } from "@/lib/session-source"
import { cn } from "@/lib/utils"
import { AlertNotice, Field, ProviderLogo } from "@/components/settings/settings-ui"

const TECH_STACKS = [
  {
    id: "vite-react-shadcn" as const,
    title: "Vite + React + shadcn/ui",
    detail: "TypeScript · Tailwind CSS v4 · shadcn/ui（含 Button 示例与 components.json）",
  },
]

function formatDate(ts?: number): string {
  if (!ts) return ""
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** 从名称自动生成 appId（会去掉首尾短横线） */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

/**
 * 输入过程中的清洗：只替换非法字符、折叠连续短横线，**不 trim 首尾**。
 * 否则用户输入 `order-` 会被立刻改成 `order`，表现为「中划线打不进去」。
 */
function sanitizeAppIdInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, 64)
}

/** 提交用的最终 appId（去掉首尾短横线） */
function finalizeAppId(value: string): string {
  return value.replace(/^-+|-+$/g, "")
}

function StatusBadge({ status, error }: { status: HnApp["status"]; error: string | null }) {
  if (status === "ready") {
    return (
      <Badge variant="outline" className="gap-1 text-[10px]">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        已就绪
      </Badge>
    )
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="border-destructive/30 text-destructive gap-1 text-[10px]" title={error ?? ""}>
        <AlertCircle className="size-2.5" />
        初始化失败
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-muted-foreground gap-1 text-[10px]">
      <Loader2 className="size-2.5 animate-spin" />
      初始化中
    </Badge>
  )
}

export function AppsPage() {
  const toast = useToast()
  const enabled = usingBaseServer()
  const [items, setItems] = useState<HnApp[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState("")
  const [createOpen, setCreateOpen] = useState(false)

  const load = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setError("")
    try {
      const res = await hnApi.apps()
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-10">
        <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[22px] leading-tight font-semibold tracking-tight">应用</h1>
            <p className="text-muted-foreground mt-1.5 text-sm">
              创建前端应用：建仓并初始化 Vite + React + shadcn/ui 项目
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)} disabled={!enabled} className="gap-1.5">
            <Plus className="size-4" />
            创建应用
          </Button>
        </header>

        {!enabled ? (
          <AlertNotice tone="warn" icon={<AlertCircle className="size-4" />}>
            未启用网关模式（<code className="text-[11px]">VITE_HN_BASE_URL</code>），应用管理依赖 hn-base-server 的
            Git 凭据与归属校验。
          </AlertNotice>
        ) : loading ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-20 text-sm">
            <Loader2 className="size-4 animate-spin" /> 读取应用…
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <AlertCircle className="size-5 text-amber-500" />
            <p className="text-muted-foreground text-sm">{error}</p>
            <Button size="sm" variant="secondary" onClick={() => void load()} className="gap-1.5">
              <RefreshCw className="size-3.5" /> 重试
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
            <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-lg">
              <Boxes className="size-5" />
            </div>
            <div className="space-y-1">
              <p className="text-[13px] font-medium">还没有应用</p>
              <p className="text-muted-foreground text-xs">创建一个前端应用，自动建仓并初始化脚手架</p>
            </div>
            <Button size="sm" onClick={() => setCreateOpen(true)} className="mt-1 gap-1.5">
              <Plus className="size-3.5" /> 创建应用
            </Button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            {items.map((item, index) => (
              <Link
                key={item.appId}
                to={`/apps/${encodeURIComponent(item.appId)}`}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  "hover:bg-muted/40 flex flex-wrap items-center gap-3 px-4 py-3.5 transition-colors",
                  index > 0 && "border-t",
                )}
              >
                <span className="bg-foreground text-background flex size-9 shrink-0 items-center justify-center rounded-lg">
                  <Boxes className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[13px] font-medium">{item.name}</p>
                    <StatusBadge status={item.status} error={item.error} />
                  </div>
                  <p className="text-muted-foreground mt-0.5 truncate text-[11px]">
                    {item.appId}
                    {item.domain ? ` · ${item.domain}` : ""} · {item.techStack} · {formatDate(item.timeCreated)}
                    {item.error ? ` · ${item.error.slice(0, 60)}` : ""}
                  </p>
                </div>
                <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-[12px]">
                  详情
                  <ChevronRight className="size-3.5" />
                </span>
              </Link>
            ))}
          </div>
        )}

        <CreateAppDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={async () => {
            setCreateOpen(false)
            await load()
            toast({ title: "应用已创建", description: "代码仓库与脚手架已初始化" })
          }}
        />
      </div>
    </div>
  )
}

/** 创建向导：应用信息 → 代码仓库 → 技术栈确认 */
function CreateAppDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => Promise<void> | void
}) {
  const toast = useToast()
  const [step, setStep] = useState(0)
  const [name, setName] = useState("")
  const [appId, setAppId] = useState("")
  const [appIdTouched, setAppIdTouched] = useState(false)
  const [domain, setDomain] = useState("")
  const [providers, setProviders] = useState<HnGitProvider[]>([])
  const [providerId, setProviderId] = useState("")
  const [repoMode, setRepoMode] = useState<"create" | "existing">("create")
  const [repoName, setRepoName] = useState("")
  const [repoOwner, setRepoOwner] = useState("")
  const [repoPath, setRepoPath] = useState("")
  const [visibility, setVisibility] = useState<"private" | "public">("private")
  /** 仓库归属（GitHub org / GitLab group；"" = 个人账号） */
  const [owners, setOwners] = useState<Array<{ id: string; name: string }>>([])
  const [techStack] = useState<(typeof TECH_STACKS)[number]["id"]>("vite-react-shadcn")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const effectiveAppId = appIdTouched ? appId : slugify(name)
  const finalAppId = finalizeAppId(effectiveAppId)

  useEffect(() => {
    if (!open) return
    void hnApi
      .gitProviders()
      .then((res) => {
        setProviders(res.items ?? [])
        setProviderId((prev) => prev || res.items?.[0]?.id || "")
      })
      .catch(() => {})
  }, [open])

  // 切换 Git 服务后加载可建仓的组织
  useEffect(() => {
    if (!open || !providerId) return
    setOwners([])
    setRepoOwner("")
    void hnApi
      .gitOwners(providerId)
      .then((res) => setOwners(res.items ?? []))
      .catch(() => setOwners([]))
  }, [open, providerId])

  const reset = () => {
    setStep(0)
    setName("")
    setAppId("")
    setAppIdTouched(false)
    setDomain("")
    setRepoMode("create")
    setRepoName("")
    setRepoOwner("")
    setRepoPath("")
    setVisibility("private")
    setError("")
    setBusy(false)
  }

  const canNext =
    step === 0
      ? name.trim().length > 0 && /^[a-z][a-z0-9-]*$/.test(finalAppId)
      : step === 1
        ? Boolean(providerId) && (repoMode === "create" || repoPath.trim().length > 0)
        : true

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await hnApi.createApp({
        appId: finalAppId,
        name: name.trim(),
        ...(domain.trim() ? { domain: domain.trim() } : {}),
        type: "frontend",
        techStack,
        gitProviderId: providerId,
        repo:
          repoMode === "create"
            ? {
                mode: "create",
                name: repoName.trim() || effectiveAppId,
                ...(repoOwner.trim() ? { owner: repoOwner.trim() } : {}),
                visibility,
              }
            : { mode: "existing", path: repoPath.trim() },
        defaultBranch: "main",
      })
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

  const steps = ["应用信息", "代码仓库", "技术栈"]

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
          <DialogTitle>创建应用</DialogTitle>
          <DialogDescription>建仓并初始化前端项目脚手架，创建后即可在仓库中开发。</DialogDescription>
        </DialogHeader>

        {/* 步骤指示 */}
        <div className="flex items-center gap-1.5">
          {steps.map((label, index) => (
            <div key={label} className="flex flex-1 items-center gap-1.5">
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium",
                  index < step
                    ? "bg-foreground text-background"
                    : index === step
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {index < step ? <Check className="size-2.5" /> : index + 1}
              </span>
              <span
                className={cn(
                  "text-[11px]",
                  index === step ? "text-foreground font-medium" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
              {index < steps.length - 1 && <span className="bg-border h-px flex-1" />}
            </div>
          ))}
        </div>

        <div className="space-y-4 py-1">
          {step === 0 && (
            <>
              <Field label="应用名称">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：订单中心"
                  className="h-9"
                  autoFocus
                />
              </Field>
              <Field label="应用 ID" hint="用于仓库名，小写字母/数字/短横线">
                <Input
                  value={effectiveAppId}
                  onChange={(e) => {
                    setAppIdTouched(true)
                    setAppId(sanitizeAppIdInput(e.target.value))
                  }}
                  placeholder="order-center"
                  className="h-9 font-mono text-[12px]"
                />
                {!finalAppId && (
                  <p className="text-muted-foreground/80 text-[11px]">
                    应用名称为中文时无法自动生成 ID，请手动填写（小写字母开头，可含数字与短横线）。
                  </p>
                )}
              </Field>
              <Field label="域名" hint="可选，对齐网关 apps.domain">
                <Input
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="order.example.com"
                  className="h-9"
                />
              </Field>
              <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
                <Boxes className="size-3.5" />
                应用类型：前端应用（当前唯一）
              </div>
            </>
          )}

          {step === 1 && (
            <>
              {providers.length === 0 ? (
                <div className="border-dashed rounded-lg border px-3 py-4 text-center">
                  <p className="text-[12px] font-medium">还没有可用的 Git 服务</p>
                  <p className="text-muted-foreground mt-1 text-[11px]">
                    请先到「Git 服务连接」添加 GitLab / GitHub
                  </p>
                </div>
              ) : (
                <>
                  <Field label="Git 服务">
                    <div className="grid gap-2">
                      {providers.map((provider) => (
                        <button
                          key={provider.id}
                          type="button"
                          onClick={() => setProviderId(provider.id)}
                          className={cn(
                            "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                            providerId === provider.id ? "border-foreground/25 bg-muted/60" : "hover:bg-muted/40",
                          )}
                        >
                          <ProviderLogo type={provider.type} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] font-medium">{provider.displayName}</span>
                            <span className="text-muted-foreground block truncate text-[10px]">{provider.baseUrl}</span>
                          </span>
                          {providerId === provider.id && <Check className="size-3.5 shrink-0" />}
                        </button>
                      ))}
                    </div>
                  </Field>

                  <div className="space-y-1.5">
                    <p className="text-[13px] font-medium">仓库</p>
                    <div className="grid grid-cols-2 gap-2">
                      {(["create", "existing"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setRepoMode(mode)}
                          className={cn(
                            "rounded-lg border px-3 py-2 text-left text-[12px] transition-colors",
                            repoMode === mode ? "border-foreground/25 bg-muted/60" : "hover:bg-muted/40",
                          )}
                        >
                          <span className="flex items-center gap-1.5 font-medium">
                            {repoMode === mode && <Check className="size-3" />}
                            {mode === "create" ? "新建仓库" : "使用已有仓库"}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {repoMode === "create" ? (
                    <>
                      <Field label="仓库名" hint={`默认 ${effectiveAppId}`}>
                        <Input
                          value={repoName}
                          onChange={(e) => setRepoName(e.target.value)}
                          placeholder={effectiveAppId}
                          className="h-9 font-mono text-[12px]"
                        />
                      </Field>
                      <div className="space-y-4">
                        <Field
                          label="组织（仓库归属）"
                          hint={
                            owners.length === 0
                              ? "Git 授权未返回组织，仅个人账号"
                              : `来自 ${providers.find((x) => x.id === providerId)?.type === "github" ? "GitHub" : "GitLab"} 授权`
                          }
                        >
                          <select
                            value={repoOwner}
                            onChange={(e) => setRepoOwner(e.target.value)}
                            className="border-input bg-background focus-visible:border-foreground/25 h-9 w-full rounded-lg border px-2.5 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
                          >
                            <option value="">个人账号</option>
                            {owners.map((owner) => (
                              <option key={owner.id} value={owner.id}>
                                {owner.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="可见性">
                          <div className="grid grid-cols-2 gap-2">
                            {(["private", "public"] as const).map((value) => (
                              <button
                                key={value}
                                type="button"
                                onClick={() => setVisibility(value)}
                                className={cn(
                                  "h-9 rounded-lg border text-[12px] transition-colors",
                                  visibility === value ? "border-foreground/25 bg-muted/60" : "hover:bg-muted/40",
                                )}
                              >
                                {value === "private" ? "私有" : "公开"}
                              </button>
                            ))}
                          </div>
                        </Field>
                      </div>
                    </>
                  ) : (
                    <Field label="仓库地址" hint="owner/repo 或完整 URL">
                      <Input
                        value={repoPath}
                        onChange={(e) => setRepoPath(e.target.value)}
                        placeholder="my-org/order-center"
                        className="h-9 font-mono text-[12px]"
                      />
                    </Field>
                  )}
                </>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <div className="space-y-2">
                {TECH_STACKS.map((stack) => (
                  <div key={stack.id} className="border-foreground/25 bg-muted/40 rounded-lg border px-3 py-2.5">
                    <p className="flex items-center gap-1.5 text-[12px] font-medium">
                      <Sparkles className="size-3.5" />
                      {stack.title}
                    </p>
                    <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">{stack.detail}</p>
                  </div>
                ))}
              </div>

              <div className="bg-muted/50 space-y-1.5 rounded-lg px-3 py-2.5 text-[11px]">
                <Row label="应用" value={`${name}（${finalAppId}）`} />
                <Row
                  label="仓库"
                  value={
                    repoMode === "create"
                      ? `${repoOwner ? `${repoOwner}/` : ""}${repoName.trim() || finalAppId}`
                      : repoPath
                  }
                />
                <Row label="分支" value="main" />
                <Row label="初始化" value="生成脚手架并提交首个 commit" />
              </div>
            </>
          )}

          {error && (
            <p
              role="alert"
              className="border-destructive/25 bg-destructive/[0.08] text-destructive rounded-lg border px-3 py-2 text-[12px] leading-relaxed break-all"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => (step === 0 ? onOpenChange(false) : setStep(step - 1))}
            disabled={busy}
            className="gap-1.5"
          >
            {step > 0 && <ChevronLeft className="size-3.5" />}
            {step === 0 ? "取消" : "上一步"}
          </Button>

          {step < 2 ? (
            <Button onClick={() => setStep(step + 1)} disabled={!canNext} className="gap-1.5">
              下一步
              <ChevronRight className="size-3.5" />
            </Button>
          ) : (
            <Button onClick={() => void submit()} disabled={busy} className="gap-1.5">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              {busy ? "创建中…" : "创建应用"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium">{value}</span>
    </div>
  )
}
