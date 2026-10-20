/**
 * hn-base-server REST 客户端。
 * 与 lib/rest.ts（直连 SaaS）分离；仅在配置了 VITE_HN_BASE_URL 时可用。
 */
import { authEnabled, clearStoredToken, getStoredToken, hnBaseUrl } from "./auth"
import type { HarnessConfig } from "./harness"

export class BaseApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string | null,
  ) {
    super(message)
    this.name = "BaseApiError"
  }
}

export function requireBaseUrl(): string {
  if (!authEnabled) throw new Error("未配置 VITE_HN_BASE_URL（hn-base-server 地址）")
  return hnBaseUrl
}

/** 原始 Response（用于文件/二进制，不做 JSON 解析） */
export async function baseFetchRaw(path: string, init?: RequestInit): Promise<Response> {
  const token = getStoredToken()
  const headers = new Headers(init?.headers)
  if (token) headers.set("authorization", `Bearer ${token}`)
  return fetch(`${hnBaseUrl}${path}`, { ...init, headers })
}

export async function baseFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getStoredToken()
  const headers = new Headers(init?.headers)
  headers.set("content-type", "application/json")
  if (token) headers.set("authorization", `Bearer ${token}`)

  const res = await fetch(`${hnBaseUrl}${path}`, { ...init, headers })
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }

  if (!res.ok) {
    // 会话失效：清掉本地凭据，守卫会把人带回登录页
    if (res.status === 401) clearStoredToken()
    const data = (body ?? {}) as { code?: string; message?: string; field?: string }
    throw new BaseApiError(res.status, data.code ?? "unknown", data.message ?? `请求失败（${res.status}）`, data.field)
  }
  return body as T
}

// ---------- 类型 ----------

export type HnRequirement = {
  id: string
  title: string
  description: string | null
  status: string
  priority: string | null
  kind: string | null
  repoUrl: string | null
  gitProviderInstanceId: string | null
  baseBranch: string | null
  workBranch: string | null
  ownerId: string
  ownerName?: string | null
  ownerEmail?: string | null
  appId?: string | null
  appName?: string | null
  sessionId?: string | null
  orgId: string | null
  projectId: string | null
  timeCreated: number
  timeUpdated: number
}

export type HnSession = {
  id: string
  title?: string | null
  parentID?: string | null
  directory?: string
  time?: { created?: number; updated?: number }
  [key: string]: unknown
}

export type HnMe = { userId: string; orgId: string | null; role: string }

export type HnGitProvider = {
  id: string
  type: "gitlab" | "github"
  displayName: string
  baseUrl: string
  apiBaseUrl: string | null
  authMethod: string
  ownerType: "user" | "org" | "global"
  ownerId: string | null
  status: "active" | "invalid"
  secretHint?: string
  timeCreated: number
}

export type HnApp = {
  appId: string
  name: string
  domain: string
  baseRoute: string
  type: string
  techStack: string
  gitProviderInstanceId: string | null
  repoUrl: string
  defaultBranch: string
  status: "initializing" | "ready" | "failed"
  error: string | null
  ownerId: string
  orgId: string | null
  timeCreated: number
  timeUpdated: number
}

export type HnGitBranch = {
  name: string
  isDefault: boolean
  isProtected: boolean
  url?: string
  lastCommit?: { shortId?: string; title?: string; committedAt?: string }
}

// ---------- API ----------

export const hnApi = {
  me: () => baseFetch<HnMe>("/api/me"),

  requirements: (params?: { q?: string; appId?: string; limit?: number }) => {
    const query = new URLSearchParams()
    if (params?.q) query.set("q", params.q)
    if (params?.appId) query.set("appId", params.appId)
    if (params?.limit) query.set("limit", String(params.limit))
    const suffix = query.toString()
    return baseFetch<{ items: HnRequirement[] }>(`/api/requirements${suffix ? `?${suffix}` : ""}`)
  },

  /** 创建需求 + 会话 + 准备沙箱（建分支、clone、checkout） */
  prepareRequirement: (input: {
    title: string
    description?: string
    appId?: string
    gitProviderId?: string
    repoUrl?: string
    baseBranch?: string
    workBranch?: string
    directory?: string
  }) =>
    baseFetch<{
      requirementId: string
      sessionId: string
      branch: string
      prepared: boolean
      prepareError?: string
    }>("/api/requirements/prepare", { method: "POST", body: JSON.stringify(input) }),

  createRequirement: (input: {
    title: string
    description?: string
    priority?: string
    orgId?: string | null
    appId?: string
    repoUrl?: string
    workBranch?: string
  }) =>
    baseFetch<HnRequirement>("/api/requirements", { method: "POST", body: JSON.stringify(input) }),

  updateRequirement: (id: string, input: Partial<Pick<HnRequirement, "title" | "description" | "status" | "priority">>) =>
    baseFetch<HnRequirement>(`/api/requirements/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  deleteRequirement: (id: string) =>
    baseFetch<{ ok: boolean }>(`/api/requirements/${encodeURIComponent(id)}`, { method: "DELETE" }),

  sessions: () => baseFetch<{ items: HnSession[] }>("/api/sessions"),

  createSession: (input: { requirementId?: string; title?: string; directory?: string; parentSessionId?: string }) =>
    baseFetch<{ session: HnSession }>("/api/sessions", { method: "POST", body: JSON.stringify(input) }),

  // ---- Git 服务连接 ----
  gitProviders: () => baseFetch<{ items: HnGitProvider[] }>("/api/git-providers"),

  createGitProvider: (input: {
    type: "gitlab" | "github"
    displayName: string
    baseUrl: string
    apiBaseUrl?: string
    token: string
    scope?: "read" | "write"
    ownerType?: "user" | "org"
    ownerId?: string
  }) => baseFetch<HnGitProvider>("/api/git-providers", { method: "POST", body: JSON.stringify(input) }),

  verifyGitProvider: (id: string) =>
    baseFetch<{ ok: boolean; identity: { username: string; name?: string } }>(
      `/api/git-providers/${encodeURIComponent(id)}/verify`,
      { method: "POST" },
    ),

  deleteGitProvider: (id: string) =>
    baseFetch<{ ok: boolean }>(`/api/git-providers/${encodeURIComponent(id)}`, { method: "DELETE" }),

  startGitOAuth: (provider: "github" | "gitlab", input: { baseUrl?: string; scope?: "read" | "write"; displayName?: string; instanceId?: string }) => {
    const query = new URLSearchParams()
    if (input.baseUrl) query.set("baseUrl", input.baseUrl)
    if (input.scope) query.set("scope", input.scope)
    if (input.displayName) query.set("displayName", input.displayName)
    if (input.instanceId) query.set("instanceId", input.instanceId)
    const suffix = query.toString()
    return baseFetch<{ url: string }>(
      `/api/git-providers/oauth/${provider}/start${suffix ? `?${suffix}` : ""}`,
    )
  },

  // ---- 组织 ----
  orgs: () => baseFetch<{ items: Array<{ id: string; name: string; slug: string; role: string }> }>("/api/orgs"),

  /** 创建组织（better-auth organization 插件；创建者为 owner） */
  createOrg: (input: { name: string; slug?: string }) =>
    baseFetch<{ id: string; name: string; slug: string }>("/api/auth/organization/create", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // ---- 应用 ----
  apps: () => baseFetch<{ items: HnApp[] }>("/api/apps"),

  createApp: (input: {
    appId: string
    name: string
    domain?: string
    type?: "frontend"
    techStack?: "vite-react-shadcn"
    gitProviderId: string
    repo: {
      mode: "create" | "existing"
      name?: string
      owner?: string
      visibility?: "private" | "public"
      path?: string
    }
    defaultBranch?: string
    orgId?: string | null
  }) => baseFetch<HnApp>("/api/apps", { method: "POST", body: JSON.stringify(input) }),

  createGitBranch: (id: string, input: { repo: string; name: string; from: string }) =>
    baseFetch<{ branch: { name: string } }>(`/api/git-providers/${encodeURIComponent(id)}/branches`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  gitOwners: (id: string) =>
    baseFetch<{ items: Array<{ id: string; name: string }> }>(
      `/api/git-providers/${encodeURIComponent(id)}/owners`,
    ),

  app: (appId: string) => baseFetch<HnApp>(`/api/apps/${encodeURIComponent(appId)}`),
  appHarness: (appId: string) => baseFetch<{ config: HarnessConfig }>(`/api/apps/${encodeURIComponent(appId)}/harness`),
  saveAppHarness: (appId: string, config: unknown) => baseFetch<{ ok: boolean }>(`/api/apps/${encodeURIComponent(appId)}/harness`, { method: "PUT", body: JSON.stringify(config) }),
  updateAppGitProvider: (appId: string, gitProviderId: string) => baseFetch<HnApp>(`/api/apps/${encodeURIComponent(appId)}/git-provider`, {
    method: "PATCH", body: JSON.stringify({ gitProviderId }),
  }),

  appRequirements: (appId: string) =>
    baseFetch<{
      items: Array<{
        id: string
        title: string
        status: string
        kind: string | null
        priority: string | null
        timeCreated: number
        timeUpdated: number
        sessionId: string | null
      }>
    }>(`/api/apps/${encodeURIComponent(appId)}/requirements`),

  appSessions: (appId: string) =>
    baseFetch<{
      items: Array<{
        sessionId: string
        requirementId: string
        role: string
        timeCreated: number
        title: string
        status: string
      }>
    }>(`/api/apps/${encodeURIComponent(appId)}/sessions`),

  deleteApp: (appId: string) =>
    baseFetch<{ ok: boolean }>(`/api/apps/${encodeURIComponent(appId)}`, { method: "DELETE" }),

  gitBranches: (id: string, repo: string) =>
    baseFetch<{ repo: string; items: HnGitBranch[] }>(
      `/api/git-providers/${encodeURIComponent(id)}/branches?repo=${encodeURIComponent(repo)}`,
    ),
}
