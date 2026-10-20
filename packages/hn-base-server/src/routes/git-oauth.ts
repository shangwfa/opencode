/**
 * Git 连接 OAuth2 端点。
 *
 *  - GET /api/git-providers/oauth/:provider/start   （需登录）返回授权地址
 *  - GET /api/git-providers/oauth/callback/:provider（公开，state 签名校验）换 token 并建实例
 */
import { Hono } from "hono"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { writeTuples } from "../authz/index.js"
import { env } from "../config/env.js"
import { db } from "../db/index.js"
import { gitCredential, gitProviderInstance } from "../db/schema.js"
import { writeAudit } from "../lib/audit.js"
import { encryptSecret } from "../lib/crypto.js"
import { createGitClient } from "../lib/git/client.js"
import { authorizeUrl, exchangeToken, gitOAuthEnabled, signState, verifyState } from "../lib/git/oauth.js"
import type { GitProviderType } from "../lib/git/types.js"
import { saasFetch } from "../lib/saas.js"
import { errors } from "../lib/errors.js"
import { requireAuth, type AppEnv } from "../middleware/auth.js"

const startQuery = z.object({
  baseUrl: z.string().trim().url().max(500).optional(),
  scope: z.enum(["read", "write"]).default("write"),
  displayName: z.string().trim().max(100).optional(),
  instanceId: z.string().trim().min(1).max(100).optional(),
})

function frontendRedirect(query: Record<string, string>): string {
  const url = new URL(`${env.webOrigin.replace(/\/+$/, "")}/`)
  url.hash = `/git-providers?${new URLSearchParams(query).toString()}`
  return url.toString()
}

export const gitOAuthRoutes = new Hono<AppEnv>()

gitOAuthRoutes.get("/:provider/start", requireAuth, async (c) => {
  const provider = c.req.param("provider")
  if (provider !== "github" && provider !== "gitlab") throw errors.invalid("不支持的 provider", "provider")
  if (!gitOAuthEnabled(provider)) {
    throw errors.conflict("该 Git 服务未配置 OAuth 应用，请使用 Access Token", "oauth_not_configured")
  }
  const parsed = startQuery.safeParse({
    baseUrl: c.req.query("baseUrl") || undefined,
    scope: c.req.query("scope") || "write",
    displayName: c.req.query("displayName") || undefined,
    instanceId: c.req.query("instanceId") || undefined,
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw errors.invalid(issue?.message ?? "参数错误", issue?.path?.join("."))
  }
  const input = parsed.data
  const defaultBase = provider === "github" ? "https://github.com" : "https://gitlab.com"
  const baseUrl = (input.baseUrl ?? defaultBase).replace(/\/+$/, "")
  if (input.instanceId) {
    const [instance] = await db.select().from(gitProviderInstance).where(eq(gitProviderInstance.id, input.instanceId)).limit(1)
    if (!instance || instance.ownerId !== c.get("userId") || instance.ownerType !== "user") throw errors.notFound("git_provider")
    if (instance.type !== provider || instance.baseUrl.replace(/\/+$/, "") !== baseUrl) throw errors.invalid("授权服务与原连接不匹配")
  }

  const state = signState({
    userId: c.get("userId"),
    provider,
    baseUrl,
    scope: input.scope,
    displayName: input.displayName ?? (provider === "github" ? "GitHub" : "GitLab"),
    exp: Date.now() + 10 * 60 * 1000,
    ...(input.instanceId ? { instanceId: input.instanceId } : {}),
  })

  return c.json({ url: authorizeUrl({ provider, baseUrl, state }) })
})

gitOAuthRoutes.get("/callback/:provider", async (c) => {
  const provider = c.req.param("provider") as GitProviderType
  const code = c.req.query("code")
  const stateRaw = c.req.query("state")
  const oauthError = c.req.query("error")

  // Connector 复用 GitHub App：Connector state 是 UUID，Git state 是 base64url.signature。
  // 只有 Connector 回调转发给 SaaS；Git 授权仍走本服务的签名校验。
  if (provider === "github" && stateRaw && !stateRaw.includes(".")) {
    try {
      const query = new URLSearchParams(c.req.query()).toString()
      const forwarded = await saasFetch(`/connector/oauth/callback?${query}`, { redirect: "manual" })
      const headers = new Headers()
      for (const name of ["content-type", "location", "cache-control"]) {
        const value = forwarded.headers.get(name)
        if (value) headers.set(name, value)
      }
      return new Response(await forwarded.text(), { status: forwarded.status, headers })
    } catch {
      return c.text("连接器授权回调失败，请关闭页面后重试", 502)
    }
  }

  if (oauthError) {
    return c.redirect(frontendRedirect({ error: c.req.query("error_description") ?? oauthError }))
  }
  if (!code || !stateRaw) return c.redirect(frontendRedirect({ error: "缺少 code 或 state" }))

  const state = verifyState(stateRaw)
  if (!state || state.provider !== provider) {
    return c.redirect(frontendRedirect({ error: "授权状态已失效，请重试" }))
  }

  try {
    const token = await exchangeToken({ provider, baseUrl: state.baseUrl, code })
    const client = createGitClient(provider, {
      baseUrl: state.baseUrl,
      token: token.accessToken,
    })
    const identity = await client.verify()

    const now = Date.now()
    const id = state.instanceId ?? `gp_${crypto.randomUUID().replace(/-/g, "")}`
    const prefix = `${state.baseUrl.replace(/\/+$/, "")}/`

    await db.transaction(async (tx) => {
      if (state.instanceId) {
        const [instance] = await tx.select().from(gitProviderInstance).where(eq(gitProviderInstance.id, id)).for("update")
        if (!instance || instance.ownerType !== "user" || instance.ownerId !== state.userId || instance.type !== provider || instance.baseUrl.replace(/\/+$/, "") !== state.baseUrl) {
          throw errors.notFound("git_provider")
        }
        const updated = await tx.update(gitCredential).set({ secretEncrypted: encryptSecret(token.accessToken), expiresAt: token.expiresAt ?? null, scopes: [state.scope], authKind: "oauth" })
          .where(and(eq(gitCredential.providerInstanceId, id), eq(gitCredential.ownerId, state.userId))).returning({ id: gitCredential.id })
        if (!updated.length) throw errors.notFound("git_credential")
        await tx.update(gitProviderInstance).set({ status: "active", authMethod: "oauth", timeUpdated: now }).where(eq(gitProviderInstance.id, id))
        return
      }
      await tx.insert(gitProviderInstance).values({
        id,
        type: provider,
        displayName: state.displayName || identity.username || provider,
        baseUrl: state.baseUrl,
        apiBaseUrl: null,
        authMethod: "oauth",
        ownerType: "user",
        ownerId: state.userId,
        status: "active",
        timeCreated: now,
        timeUpdated: now,
      })
      await tx.insert(gitCredential).values({
        id: `gc_${crypto.randomUUID().replace(/-/g, "")}`,
        providerInstanceId: id,
        prefix,
        scopes: [state.scope],
        authKind: "oauth",
        ownerType: "user",
        ownerId: state.userId,
        secretEncrypted: encryptSecret(token.accessToken),
        expiresAt: token.expiresAt ?? null,
        timeCreated: now,
      })
      await writeTuples(tx as unknown as typeof db, [
        {
          resourceType: "git_provider",
          resourceId: id,
          relation: "owner",
          subjectType: "user",
          subjectId: state.userId,
          createdBy: state.userId,
        },
        {
          resourceType: "git_provider",
          resourceId: id,
          relation: "admin",
          subjectType: "user",
          subjectId: state.userId,
          createdBy: state.userId,
        },
      ])
    })

    await writeAudit(
      {
        actorId: state.userId,
        action: "git_provider.oauth_connect",
        resourceType: "git_provider",
        resourceId: id,
        metadata: { provider, baseUrl: state.baseUrl, username: identity.username },
      },
      c,
    )

    return c.redirect(frontendRedirect({ connected: id, provider }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return c.redirect(frontendRedirect({ error: message.slice(0, 180) }))
  }
})

export { eq }
