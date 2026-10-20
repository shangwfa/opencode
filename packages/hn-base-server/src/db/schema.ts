/**
 * hn-base-server 数据模型（PostgreSQL）。
 *
 * 三层：
 *  1. 身份与组织 —— better-auth 托管（user/session/account/organization/member/invitation）
 *  2. 授权 —— relation_tuple（唯一真相；见 docs/design/permission-model-design.md）
 *  3. 业务 —— requirement / requirement_change / git_provider / git_credential
 *
 * 约定：列名显式 snake_case；时间用 timestamp（better-auth 需要 Date）。
 */
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { env } from "../config/env.js"

/** 独立 schema：避免与 SaaS public 下的 account/user 等表冲突；随环境变量切换（测试隔离） */
export const hnBase = pgSchema(env.databaseSchema)

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()

// ---------------------------------------------------------------------------
// 1. better-auth：核心表
// ---------------------------------------------------------------------------

export const user = hnBase.table("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  /** 平台级角色（user | admin），与组织角色分开 */
  role: text("role").notNull().default("user"),
  /** active | disabled */
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const session = hnBase.table(
  "session",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeOrganizationId: text("active_organization_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
)

export const account = hnBase.table(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
)

export const verification = hnBase.table("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// ---------------------------------------------------------------------------
// 1b. better-auth：organization 插件
// ---------------------------------------------------------------------------

export const organization = hnBase.table("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: jsonb("metadata"),
  /** 软删：组织删除后保留数据，资源转只读 */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const member = hnBase.table(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** owner | admin | member | viewer | guest（自定义角色也存这里） */
    role: text("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("member_user_idx").on(t.userId),
    uniqueIndex("member_org_user_uq").on(t.organizationId, t.userId),
  ],
)

/** 组织自定义角色：permissions = { requirement: ["read","write"], session: ["read"], ... } */
export const orgRole = hnBase.table(
  "org_role",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    permissions: jsonb("permissions").notNull(),
    timeCreated: bigint("time_created", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("org_role_org_key_uq").on(t.orgId, t.key)],
)

export const invitation = hnBase.table(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [index("invitation_org_idx").on(t.organizationId)],
)

// ---------------------------------------------------------------------------
// 2. 授权：关系元组（唯一真相）
// ---------------------------------------------------------------------------

export const relationTuple = hnBase.table(
  "relation_tuple",
  {
    id: text("id").primaryKey(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    /** owner | editor | viewer | parent | member | admin | user */
    relation: text("relation").notNull(),
    /** user | org | team | public */
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    caveatName: text("caveat_name"),
    caveatContext: jsonb("caveat_context"),
    expiresAt: bigint("expires_at", { mode: "number" }),
    createdBy: text("created_by"),
    timeCreated: bigint("time_created", { mode: "number" }).notNull(),
  },
  (t) => [
    index("rt_subject_idx").on(t.subjectType, t.subjectId, t.relation),
    index("rt_resource_idx").on(t.resourceType, t.resourceId, t.relation),
    uniqueIndex("rt_uniq").on(t.resourceType, t.resourceId, t.relation, t.subjectType, t.subjectId),
  ],
)

// ---------------------------------------------------------------------------
// 3. 业务：需求
// ---------------------------------------------------------------------------

export const requirement = hnBase.table(
  "requirement",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    /** draft | open | in_progress | pending_publish | done | archived */
    status: text("status").notNull().default("draft"),
    priority: text("priority"),
    kind: text("kind"),
    createType: text("create_type"),
    repoUrl: text("repo_url"),
    gitProviderInstanceId: text("git_provider_instance_id"),
    /** 关联应用（应用工作台按此过滤会话） */
    appId: text("app_id"),
    baseBranch: text("base_branch"),
    workBranch: text("work_branch"),
    /** 查询/展示字段；授权以 relation_tuple 为准 */
    ownerId: text("owner_id").notNull(),
    /** 可空 = 个人资源 */
    orgId: text("org_id"),
    projectId: text("project_id"),
    timeCreated: bigint("time_created", { mode: "number" }).notNull(),
    timeUpdated: bigint("time_updated", { mode: "number" }).notNull(),
  },
  (t) => [
    index("requirement_owner_idx").on(t.ownerId),
    index("requirement_org_idx").on(t.orgId),
    index("requirement_status_idx").on(t.status),
    index("requirement_app_idx").on(t.appId),
  ],
)

export const requirementChange = hnBase.table(
  "requirement_change",
  {
    id: text("id").primaryKey(),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirement.id, { onDelete: "cascade" }),
    providerInstanceId: text("provider_instance_id"),
    number: bigint("number", { mode: "number" }).notNull(),
    url: text("url").notNull(),
    /** opened | merged | closed */
    state: text("state").notNull(),
    sourceBranch: text("source_branch"),
    targetBranch: text("target_branch"),
    timeCreated: bigint("time_created", { mode: "number" }).notNull(),
    timeMerged: bigint("time_merged", { mode: "number" }),
  },
  (t) => [index("requirement_change_req_idx").on(t.requirementId)],
)

export const requirementSession = hnBase.table(
  "requirement_session",
  {
    id: text("id").primaryKey(),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirement.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    /** primary | derived | intake_child */
    role: text("role").notNull().default("primary"),
    timeCreated: bigint("time_created", { mode: "number" }).notNull(),
  },
  (t) => [
    index("requirement_session_req_idx").on(t.requirementId),
    uniqueIndex("requirement_session_uq").on(t.sessionId),
  ],
)

// ---------------------------------------------------------------------------
// 3b. 业务：应用（创建 → 建仓 → 脚手架初始化）
// ---------------------------------------------------------------------------

/**
 * 应用。字段语义对齐 hn-gateway 的 apps 表（appId / domain / baseRoute / config / enabled），
 * 便于将来同步或替换；仓库与初始化由本服务的 Git Provider 完成。
 */
export const bizApp = hnBase.table("app", {
  appId: text("app_id").primaryKey(),
  name: text("name").notNull(),
  domain: text("domain").notNull().default(""),
  baseRoute: text("base_route").notNull().default(""),
  config: jsonb("config"),
  enabled: boolean("enabled").notNull().default(true),
  /** frontend（当前唯一） */
  type: text("type").notNull().default("frontend"),
  /** vite-react-shadcn */
  techStack: text("tech_stack").notNull(),
  gitProviderInstanceId: text("git_provider_instance_id"),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  /** initializing | ready | failed */
  status: text("status").notNull().default("initializing"),
  error: text("error"),
  ownerId: text("owner_id").notNull(),
  orgId: text("org_id"),
  timeCreated: bigint("time_created", { mode: "number" }).notNull(),
  timeUpdated: bigint("time_updated", { mode: "number" }).notNull(),
})

/**
 * 用户级连接器作用域。现有 Connector 服务按会话归属连接；
 * 连接器板块用一个隐藏会话承载个人连接，不向会话列表暴露。
 */
export const connectorScope = hnBase.table("connector_scope", {
  userId: text("user_id").primaryKey(),
  sessionId: text("session_id").notNull(),
  timeCreated: bigint("time_created", { mode: "number" }).notNull(),
  timeUpdated: bigint("time_updated", { mode: "number" }).notNull(),
})

// ---------------------------------------------------------------------------
// 4. 业务：Git Provider 与凭据
// ---------------------------------------------------------------------------

export const gitProviderInstance = hnBase.table("git_provider_instance", {
  id: text("id").primaryKey(),
  /** gitlab | github */
  type: text("type").notNull(),
  displayName: text("display_name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiBaseUrl: text("api_base_url"),
  /** key | oauth | env */
  authMethod: text("auth_method").notNull(),
  credentialId: text("credential_id"),
  /** user | org | global（冗余，授权走元组） */
  ownerType: text("owner_type").notNull(),
  ownerId: text("owner_id"),
  /** active | invalid */
  status: text("status").notNull().default("active"),
  timeCreated: bigint("time_created", { mode: "number" }).notNull(),
  timeUpdated: bigint("time_updated", { mode: "number" }).notNull(),
})

export const gitCredential = hnBase.table(
  "git_credential",
  {
    id: text("id").primaryKey(),
    /** 所属 Git 服务实例 ID */
    providerInstanceId: text("provider_instance_id").notNull(),
    /** URL 前缀，最长匹配 */
    prefix: text("prefix").notNull(),
    scopes: text("scopes").array(),
    authKind: text("auth_kind"),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id"),
    /** AES-256-GCM：iv.tag.ciphertext（base64），密钥来自 GIT_SECRET_KEY */
    secretEncrypted: text("secret_encrypted").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }),
    timeCreated: bigint("time_created", { mode: "number" }).notNull(),
  },
  (t) => [index("git_credential_prefix_idx").on(t.prefix)],
)

// ---------------------------------------------------------------------------
// 5. 运维：webhook 幂等 / 审计
// ---------------------------------------------------------------------------

export const webhookEvent = hnBase.table(
  "webhook_event",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload"),
    /** received | processed | failed */
    status: text("status").notNull(),
    error: text("error"),
    timeCreated: bigint("time_created", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("webhook_event_uq").on(t.provider, t.eventId)],
)

export const auditLog = hnBase.table(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actorType: text("actor_type"),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    /** allow | deny */
    result: text("result"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata"),
    timeCreated: bigint("time_created", { mode: "number" }).notNull(),
  },
  (t) => [
    index("audit_actor_idx").on(t.actorId),
    index("audit_time_idx").on(t.timeCreated),
  ],
)

export const schema = {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  orgRole,
  relationTuple,
  requirement,
  requirementChange,
  requirementSession,
  bizApp,
  gitProviderInstance,
  gitCredential,
  webhookEvent,
  auditLog,
}

export type Schema = typeof schema
