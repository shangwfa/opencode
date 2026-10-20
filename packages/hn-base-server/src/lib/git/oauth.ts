/**
 * Git 连接的 OAuth2 流程（GitHub / GitLab）。
 *
 * 与「登录用 OAuth」分开：回调地址不同、scope 不同（Git 需要 repo/api 级别权限）。
 * state 用 HMAC 签名携带上下文（userId / provider / baseUrl / scope），无需额外表。
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import { env } from "../../config/env.js"
import { errors } from "../errors.js"
import type { GitProviderType } from "./types.js"

export type OAuthState = {
  userId: string
  provider: GitProviderType
  baseUrl: string
  scope: "read" | "write"
  displayName: string
  instanceId?: string
  exp: number
}

function secret(): string {
  return process.env.GIT_SECRET_KEY?.trim() || env.authSecret
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url")
}

export function signState(input: OAuthState): string {
  const body = b64url(JSON.stringify(input))
  const sig = createHmac("sha256", secret()).update(body).digest("base64url")
  return `${body}.${sig}`
}

export function verifyState(state: string, now = Date.now()): OAuthState | undefined {
  const [body, sig] = state.split(".")
  if (!body || !sig) return undefined
  const expected = createHmac("sha256", secret()).update(body).digest("base64url")
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState
    if (!payload?.userId || !payload?.provider) return undefined
    if (!Number.isFinite(payload.exp) || payload.exp <= now) return undefined
    return payload
  } catch {
    return undefined
  }
}

export function gitOAuthEnabled(provider: GitProviderType): boolean {
  if (provider === "github") return Boolean(env.gitGithubClientId && env.gitGithubClientSecret)
  return Boolean(env.gitGitlabClientId && env.gitGitlabClientSecret)
}

export function gitOAuthProviders(): GitProviderType[] {
  return (["github", "gitlab"] as const).filter((p) => gitOAuthEnabled(p))
}

function oauthBase(provider: GitProviderType, baseUrl: string): string {
  if (env.gitOauthBase) return env.gitOauthBase.replace(/\/+$/, "")
  return provider === "github" ? "https://github.com" : baseUrl.replace(/\/+$/, "")
}

export function callbackUrl(provider: GitProviderType): string {
  return `${env.authUrl.replace(/\/+$/, "")}/api/git-providers/oauth/callback/${provider}`
}

export function authorizeUrl(input: {
  provider: GitProviderType
  baseUrl: string
  state: string
}): string {
  const { provider } = input
  const clientId = provider === "github" ? env.gitGithubClientId : env.gitGitlabClientId
  if (!clientId) throw errors.conflict("该 Git 服务未配置 OAuth 应用", "oauth_not_configured")
  const redirect = encodeURIComponent(callbackUrl(provider))
  if (provider === "github") {
    // repo：私有仓库读写；GitHub OAuth App 无细粒度 scope
    const scope = encodeURIComponent("repo read:user read:org")
    return `${oauthBase(provider, input.baseUrl)}/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${redirect}&scope=${scope}&state=${encodeURIComponent(input.state)}`
  }
  // GitLab：api 覆盖读写；read_api 只读
  const scope = encodeURIComponent("api")
  return `${oauthBase(provider, input.baseUrl)}/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${redirect}&response_type=code&scope=${scope}&state=${encodeURIComponent(input.state)}`
}

export async function exchangeToken(input: {
  provider: GitProviderType
  baseUrl: string
  code: string
}): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const { provider, code } = input
  const clientId = provider === "github" ? env.gitGithubClientId : env.gitGitlabClientId
  const clientSecret = provider === "github" ? env.gitGithubClientSecret : env.gitGitlabClientSecret
  if (!clientId || !clientSecret) throw errors.conflict("该 Git 服务未配置 OAuth 应用", "oauth_not_configured")

  const base = oauthBase(provider, input.baseUrl)
  const body = {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: callbackUrl(provider),
    grant_type: "authorization_code",
  }

  const res =
    provider === "github"
      ? await fetch(`${base}/login/oauth/access_token`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      : await fetch(`${base}/oauth/token`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(body),
        })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw errors.invalid(`OAuth 换取令牌失败（${res.status}）：${text.slice(0, 160)}`)
  }
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!data.access_token) {
    throw errors.invalid(
      `OAuth 未返回 access_token：${data.error_description ?? data.error ?? "unknown"}`,
    )
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  }
}
