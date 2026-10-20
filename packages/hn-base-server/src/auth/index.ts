/**
 * better-auth 实例。
 *
 * 决策（见 total-design.md）：
 *  - 主链路用 session token（bearer 插件），天然可吊销、多 pod 查同一 PG
 *  - 组织用 organization 插件（org/member/invitation）
 *  - 组织角色：owner / admin / member / viewer / guest（guest 为自定义语义，由授权层解释）
 */
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { bearer, organization } from "better-auth/plugins"
import { env } from "../config/env.js"
import { db } from "../db/index.js"
import { account, invitation, member, organization as orgTable, session, user, verification } from "../db/schema.js"

/** 只把 better-auth 需要的模型交给 adapter */
export const authSchema = {
  user,
  session,
  account,
  verification,
  organization: orgTable,
  member,
  invitation,
}

/** 仅在配置了 clientId/secret 时启用对应 OAuth provider */
export const socialProviders = {
  ...(env.googleClientId && env.googleClientSecret
    ? { google: { clientId: env.googleClientId, clientSecret: env.googleClientSecret } }
    : {}),
  ...(env.githubClientId && env.githubClientSecret
    ? {
        // better-auth 默认 scope 已包含 read:user + user:email，无需额外配置
        github: { clientId: env.githubClientId, clientSecret: env.githubClientSecret },
      }
    : {}),
}

export const enabledSocialProviders: Array<{ id: "google" | "github"; name: string }> = [
  ...(socialProviders.google ? [{ id: "google" as const, name: "Google" }] : []),
  ...(socialProviders.github ? [{ id: "github" as const, name: "GitHub" }] : []),
]

export const auth = betterAuth({
  appName: "hn-base-server",
  baseURL: env.authUrl,
  basePath: "/api/auth",
  secret: env.authSecret,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
    schemaName: env.databaseSchema,
  }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60,
    cookieCache: { enabled: true, maxAge: 60 * 60 * 24 },
  },

  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "user", input: false },
      status: { type: "string", defaultValue: "active", input: false },
    },
  },

  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      // 不同邮箱的社交账号不自动合并，避免账号劫持；需登录后手动绑定
      allowDifferentEmails: false,
    },
  },

  socialProviders,

  trustedOrigins: [env.webOrigin],

  plugins: [
    // Authorization: Bearer <session.token>
    bearer(),
    organization({
      allowUserToCreateOrganization: true,
      creatorRole: "owner",
      invitationExpiresIn: 60 * 60 * 24 * 7,
      membershipLimit: 200,
    }),
  ],
})

export type Auth = typeof auth
