/**
 * 登录 / 注册页（纯 fetch 认证，见 lib/auth.tsx）。
 *
 * 布局参考 Linear / Vercel / Cursor 的登录页：
 *  - 左侧：深色品牌面板（网格 + 径向光晕 + 价值主张 + 特性），仅 lg 以上显示
 *  - 右侧：克制表单（label 在上、密码显隐、内联错误、加载态）
 */
import { useEffect, useState } from "react"
import { Navigate, useLocation, useNavigate } from "react-router"
import { Eye, EyeOff, GitBranch, Github, Loader2, ShieldCheck, Terminal, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/toast"
import { authEnabled, fetchAuthConfig, signIn, signInSocial, signUp, useAuth, type SocialProvider } from "@/lib/auth"

/** better-auth 默认错误文案 → 中文（按包含关系匹配，兼容不同版本措辞） */
const ERROR_MAP: [string, string][] = [
  ["Invalid email or password", "邮箱或密码错误"],
  ["User already exists", "该邮箱已注册，请直接登录"],
  ["Password too short", "密码至少 8 位"],
  ["Invalid email", "邮箱格式不正确"],
  ["Too many requests", "尝试过于频繁，请稍后再试"],
  ["Email not verified", "邮箱尚未验证，请先完成验证"],
]

function localizeError(message: string): string {
  for (const [needle, zh] of ERROR_MAP) {
    if (message.toLowerCase().includes(needle.toLowerCase())) return zh
  }
  return message
}

const FEATURES = [
  { icon: GitBranch, title: "需求到代码，一条链路", text: "需求、会话、分支与 PR 自动关联" },
  { icon: ShieldCheck, title: "沙箱隔离执行", text: "每个会话独立工作区，互不干扰" },
  { icon: Users, title: "组织与权限", text: "按组织共享资源，细粒度授权" },
]

function BrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden bg-zinc-950 text-white lg:flex lg:flex-col">
      {/* 网格 + 顶部光晕，纯 CSS，不引入图片 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.55]"
        style={{
          backgroundImage:
            "radial-gradient(70% 55% at 50% -10%, rgba(255,255,255,0.14), transparent 70%), linear-gradient(to right, rgba(255,255,255,0.055) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.055) 1px, transparent 1px)",
          backgroundSize: "auto, 44px 44px, 44px 44px",
        }}
      />

      <div className="relative flex flex-1 flex-col justify-between p-10 xl:p-14">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-white text-zinc-950">
            <Terminal className="size-4" strokeWidth={2.2} />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">OpenCode Chat</span>
        </div>

        <div className="max-w-md">
          <h2 className="text-[32px] leading-[1.15] font-semibold tracking-tight xl:text-[38px]">
            让 AI 与你的代码库
            <br />
            并肩工作
          </h2>
          <p className="mt-4 text-[14px] leading-relaxed text-white/55">
            从需求讨论到方案规划，再到代码修改与提交，全程在一个会话里完成。
          </p>

          <ul className="mt-10 space-y-4">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.08] ring-1 ring-white/10">
                  <Icon className="size-3.5 text-white/80" strokeWidth={1.9} />
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-white/90">{title}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-white/45">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-white/35">
          <span className="size-1.5 rounded-full bg-emerald-400/80" />
          OpenCode SaaS · 需求驱动的 AI 研发
        </div>
      </div>
    </aside>
  )
}

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const { loading, user, refresh } = useAuth()
  const [mode, setMode] = useState<"signin" | "signup">("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [providers, setProviders] = useState<SocialProvider[]>([])
  const [oauthBusy, setOauthBusy] = useState<string | null>(null)

  useEffect(() => {
    void fetchAuthConfig().then((config) => setProviders(config.providers))
  }, [])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError("")
    try {
      const result =
        mode === "signin"
          ? await signIn(email, password)
          : await signUp(email, password, name || email.split("@")[0] || "用户")
      if (result.error) {
        setError(localizeError(result.error))
        return
      }
      await refresh()
      toast({ title: mode === "signin" ? "登录成功" : "注册成功" })
      const target = (location.state as { from?: string } | null)?.from ?? "/"
      navigate(target, { replace: true })
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
        <BrandPanel />
        <div className="flex items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }
  if (authEnabled && user) return <Navigate to="/" replace />

  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[1.05fr_1fr]">
      <BrandPanel />

      <main className="flex flex-col">
        <div className="flex flex-1 items-center justify-center px-6 py-12">
          <div className="w-full max-w-[360px]">
            {/* 移动端品牌：左侧面板隐藏后仍要有产品标识 */}
            <div className="mb-8 flex items-center gap-2.5 lg:hidden">
              <span className="bg-foreground text-background flex size-8 items-center justify-center rounded-lg">
                <Terminal className="size-4" strokeWidth={2.2} />
              </span>
              <span className="text-[15px] font-semibold tracking-tight">OpenCode Chat</span>
            </div>

            <header className="mb-7">
              <h1 className="text-[22px] leading-tight font-semibold tracking-tight">
                {mode === "signin" ? "登录" : "创建账号"}
              </h1>
              <p className="text-muted-foreground mt-1.5 text-[13px]">
                {mode === "signin" ? "使用你的账号继续" : "几秒钟即可开始，无需信用卡"}
              </p>
            </header>

            {providers.length > 0 && (
              <div className="mb-5 space-y-2">
                {providers.map((provider) => (
                  <Button
                    key={provider.id}
                    type="button"
                    variant="outline"
                    disabled={oauthBusy !== null}
                    onClick={async () => {
                      setOauthBusy(provider.id)
                      setError("")
                      const result = await signInSocial(provider.id)
                      if (result.error) {
                        setError(result.error)
                        setOauthBusy(null)
                      }
                    }}
                    className="h-9 w-full gap-2 text-[13px] font-medium"
                  >
                    {oauthBusy === provider.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : provider.id === "github" ? (
                      <Github className="size-4" />
                    ) : (
                      <GoogleIcon />
                    )}
                    使用 {provider.name} 继续
                  </Button>
                ))}

                <div className="flex items-center gap-3 pt-1">
                  <span className="bg-border h-px flex-1" />
                  <span className="text-muted-foreground/70 text-[11px]">或使用邮箱</span>
                  <span className="bg-border h-px flex-1" />
                </div>
              </div>
            )}

            <form onSubmit={submit} className="space-y-4">
              {mode === "signup" && (
                <Field label="昵称" htmlFor="name" hint="可选">
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="你的名字"
                    autoComplete="name"
                    className="h-9"
                  />
                </Field>
              )}

              <Field label="邮箱" htmlFor="email">
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  autoComplete="email"
                  className="h-9"
                />
              </Field>

              <Field label="密码" htmlFor="password" hint={mode === "signup" ? "至少 8 位" : undefined}>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode === "signin" ? "current-password" : "new-password"}
                    className="h-9 pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    className="text-muted-foreground hover:text-foreground absolute top-0 right-0 flex h-9 w-9 items-center justify-center rounded-r-lg"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
              </Field>

              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-destructive/25 bg-destructive/[0.08] px-3 py-2 text-[12px] leading-relaxed text-destructive"
                >
                  {error}
                </p>
              )}

              <Button type="submit" disabled={busy} className="h-9 w-full gap-2">
                {busy && <Loader2 className="size-3.5 animate-spin" />}
                {busy ? (mode === "signin" ? "登录中…" : "创建中…") : mode === "signin" ? "登录" : "创建账号"}
              </Button>
            </form>

            <p className="text-muted-foreground mt-6 text-center text-[12px]">
              {mode === "signin" ? "还没有账号？" : "已有账号？"}
              <button
                type="button"
                className="text-foreground ml-1 font-medium underline-offset-4 hover:underline"
                onClick={() => {
                  setMode(mode === "signin" ? "signup" : "signin")
                  setError("")
                }}
              >
                {mode === "signin" ? "创建一个" : "去登录"}
              </button>
            </p>
          </div>
        </div>

        <footer className="text-muted-foreground/70 flex items-center justify-center gap-1.5 px-6 pb-6 text-[11px]">
          <ShieldCheck className="size-3" />
          凭据仅保存在你的部署环境
        </footer>
      </main>
    </div>
  )
}

/** Google 四色 G（品牌规范：不允许单色替换） */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.29a11.99 11.99 0 0 0 0 10.76l3.98-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  )
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label htmlFor={htmlFor} className="text-[13px] font-medium">
          {label}
        </label>
        {hint && <span className="text-muted-foreground/70 text-[11px]">{hint}</span>}
      </div>
      {children}
    </div>
  )
}
