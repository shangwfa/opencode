/**
 * hn-base-server 认证（纯 fetch 实现，不依赖 better-auth/react）。
 *
 * 端点（better-auth 标准 REST）：
 *  - POST /api/auth/sign-up/email {email, password, name}
 *  - POST /api/auth/sign-in/email  → 响应头 set-auth-token（bearer 插件）
 *  - GET  /api/auth/get-session    → { user, session } | null
 *  - POST /api/auth/sign-out
 *
 * 开关：配置 VITE_HN_BASE_URL 即启用；未配置保持「直连 SaaS、无登录」的开发现状。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

export const hnBaseUrl = (import.meta.env.VITE_HN_BASE_URL as string | undefined)?.trim().replace(/\/+$/, "") ?? ""

export const authEnabled = hnBaseUrl.length > 0

export type AuthUser = {
  id: string
  name: string
  email: string
  image?: string | null
}

const TOKEN_KEY = "hn_auth_token"
/** 本地“已登出”标记：即使服务端 cookie 残留，也不自动恢复登录 */
const LOGGED_OUT_KEY = "hn_logged_out"

function markLoggedOut(value: boolean): void {
  try {
    if (value) localStorage.setItem(LOGGED_OUT_KEY, "1")
    else localStorage.removeItem(LOGGED_OUT_KEY)
  } catch {
    /* 忽略 */
  }
}

function isMarkedLoggedOut(): boolean {
  try {
    return localStorage.getItem(LOGGED_OUT_KEY) === "1"
  } catch {
    return false
  }
}

/** 从 localStorage 恢复（刷新页面后保持登录） */
function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* 隐私模式/存储受限时忽略 */
  }
}

let authToken: string | null = authEnabled ? readToken() : null
let authUser: AuthUser | null = null

export function getStoredToken(): string | null {
  return authToken
}

/** 401 时清除本地凭据（下次打开回到登录页） */
export function clearStoredToken(): void {
  authToken = null
  writeToken(null)
}

async function parse(res: Response): Promise<{ ok: boolean; status: number; data: unknown; token: string | null }> {
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  return { ok: res.ok, status: res.status, data, token: res.headers.get("set-auth-token") }
}

export async function signIn(email: string, password: string): Promise<{ error?: string }> {
  const r = await parse(
    await fetch(`${hnBaseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json", origin: location.origin },
      body: JSON.stringify({ email, password }),
    }),
  )
  if (!r.ok) return { error: (r.data as { message?: string })?.message ?? `登录失败（${r.status}）` }
  if (r.token) {
    authToken = r.token
    writeToken(r.token)
  }
  markLoggedOut(false)
  authUser = (r.data as { user?: AuthUser })?.user ?? null
  return {}
}

export async function signUp(email: string, password: string, name: string): Promise<{ error?: string }> {
  const r = await parse(
    await fetch(`${hnBaseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json", origin: location.origin },
      body: JSON.stringify({ email, password, name }),
    }),
  )
  if (!r.ok) return { error: (r.data as { message?: string })?.message ?? `注册失败（${r.status}）` }
  if (r.token) {
    authToken = r.token
    writeToken(r.token)
  }
  markLoggedOut(false)
  authUser = (r.data as { user?: AuthUser })?.user ?? null
  return {}
}

export async function fetchSession(): Promise<AuthUser | null> {
  if (!authEnabled) return null
  // 已主动登出且本地无 token：不依赖 cookie 恢复（防止残留 cookie 造成“登出无效”）
  if (!authToken && isMarkedLoggedOut()) {
    authUser = null
    return null
  }
  try {
    const headers: Record<string, string> = { origin: location.origin }
    if (authToken) headers.authorization = `Bearer ${authToken}`
    // credentials: include —— OAuth 回调后 base-server 设置了 session cookie，
    // 这里用它换发 bearer token 并持久化，后续请求统一走 Authorization。
    const res = await fetch(`${hnBaseUrl}/api/auth/get-session`, { credentials: "include", headers })
    if (!res.ok) return null
    const data = (await res.json()) as { user?: AuthUser; session?: { token?: string } } | null
    if (data?.session?.token) {
      authToken = data.session.token
      writeToken(data.session.token)
    }
    authUser = data?.user ?? null
    return authUser
  } catch {
    return null
  }
}

export async function signOut(): Promise<void> {
  try {
    const headers: Record<string, string> = {
      // better-auth 的 sign-out 强制要求 JSON content-type + body，缺失会返回 400/415，
      // 导致 session 与 cookie 都没删除（表现为“点登出没反应”）
      "content-type": "application/json",
      origin: location.origin,
    }
    if (authToken) headers.authorization = `Bearer ${authToken}`
    // include：OAuth 登录会留下 session cookie，必须让服务端能收到并清除它
    await fetch(`${hnBaseUrl}/api/auth/sign-out`, {
      method: "POST",
      credentials: "include",
      headers,
      body: "{}",
    })
  } catch {
    /* 离线时忽略 */
  }
  authToken = null
  authUser = null
  writeToken(null)
  markLoggedOut(true)
}

export type SocialProvider = { id: "google" | "github"; name: string }
export type GitOAuthConfig = { github: boolean; gitlab: boolean }

/** 可用第三方登录方式 / Git 连接 OAuth（未配置时为空/false） */
export async function fetchAuthConfig(): Promise<{
  providers: SocialProvider[]
  gitOAuth: GitOAuthConfig
}> {
  const fallback = { providers: [], gitOAuth: { github: false, gitlab: false } }
  if (!authEnabled) return fallback
  try {
    const res = await fetch(`${hnBaseUrl}/api/config`, { credentials: "omit" })
    if (!res.ok) return fallback
    const data = (await res.json()) as { providers?: SocialProvider[]; gitOAuth?: GitOAuthConfig }
    return {
      providers: Array.isArray(data.providers) ? data.providers : [],
      gitOAuth: {
        github: data.gitOAuth?.github === true,
        gitlab: data.gitOAuth?.gitlab === true,
      },
    }
  } catch {
    return fallback
  }
}

/**
 * 发起第三方登录：拿到授权地址后整页跳转。
 * 回调 landed 到 `callbackURL`，AuthProvider 的 refresh 会用 cookie 换发 token。
 */
export async function signInSocial(provider: SocialProvider["id"]): Promise<{ error?: string }> {
  if (!authEnabled) return { error: "未配置网关地址" }
  // 发起 OAuth：清除登出标记，允许回调后用 cookie 换发 token
  markLoggedOut(false)
  try {
    const res = await fetch(`${hnBaseUrl}/api/auth/sign-in/social`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", origin: location.origin },
      body: JSON.stringify({
        provider,
        // HashRouter：回调不要带 hash，落地后由路由兜底到首页
        callbackURL: `${location.origin}/`,
        errorCallbackURL: `${location.origin}/login`,
      }),
    })
    const data = (await res.json().catch(() => null)) as { url?: string; message?: string } | null
    if (!res.ok || !data?.url) return { error: data?.message ?? "发起登录失败" }
    location.href = data.url
    return {}
  } catch (error) {
    return { error: error instanceof Error ? error.message : "发起登录失败" }
  }
}

// ---------- React 绑定 ----------

type AuthState = { loading: boolean; user: AuthUser | null; refresh: () => Promise<void> }

const AuthContext = createContext<AuthState>({ loading: false, user: null, refresh: async () => {} })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(authEnabled)
  const [user, setUser] = useState<AuthUser | null>(null)

  const refresh = async () => {
    const next = await fetchSession()
    setUser(next)
    setLoading(false)
  }

  useEffect(() => {
    if (!authEnabled) return
    void refresh()
  }, [])

  return <AuthContext.Provider value={{ loading, user, refresh }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  return useContext(AuthContext)
}
