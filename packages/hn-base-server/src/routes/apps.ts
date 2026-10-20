/**
 * 应用创建（方案 B）：
 *   应用记录（字段对齐网关 apps）+ Git Provider 建仓 + 脚手架初始化。
 *
 * 流程：校验 Git 服务使用权限 → 建仓/选已有仓库 → 生成 vite+react+shadcn+tailwind 模板
 *       → commitFiles 提交 → 写 app 记录 + 归属元组。
 */
import { Hono } from "hono"
import { and, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import { check, deleteResourceGraph, listObjects, writeTuples } from "../authz/index.js"
import { db } from "../db/index.js"
import { bizApp, requirement, requirementSession } from "../db/schema.js"
import { writeAudit } from "../lib/audit.js"
import { errors } from "../lib/errors.js"
import { loadGitInstance } from "../lib/git/instance.js"
import { resolveRepo } from "../lib/git/types.js"
import { viteReactScaffold } from "../lib/scaffold/vite-react.js"
import { requireAuth, type AppEnv } from "../middleware/auth.js"
import { parseHarness, readHarness, sealHarness } from "../lib/harness.js"

const APP_ID_RE = /^[a-z][a-z0-9-]*$/

const createBody = z.object({
  appId: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(APP_ID_RE, "应用 ID 只能是小写字母、数字、短横线，且以字母开头"),
  name: z.string().trim().min(1).max(100),
  domain: z.string().trim().max(200).optional(),
  type: z.literal("frontend").default("frontend"),
  techStack: z.literal("vite-react-shadcn").default("vite-react-shadcn"),
  gitProviderId: z.string().trim().min(1),
  repo: z.object({
    mode: z.enum(["create", "existing"]),
    /** create：仓库名（默认 appId） */
    name: z.string().trim().max(100).optional(),
    /** GitHub org / GitLab namespace（可选） */
    owner: z.string().trim().max(200).optional(),
    visibility: z.enum(["private", "public"]).default("private"),
    /** existing：owner/repo 或完整 URL */
    path: z.string().trim().max(500).optional(),
  }),
  defaultBranch: z.string().trim().max(200).default("main"),
  orgId: z.string().trim().max(100).nullable().optional(),
})

function serialize(row: typeof bizApp.$inferSelect) {
  return {
    appId: row.appId,
    name: row.name,
    domain: row.domain,
    baseRoute: row.baseRoute,
    type: row.type,
    techStack: row.techStack,
    gitProviderInstanceId: row.gitProviderInstanceId,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    status: row.status,
    error: row.error,
    ownerId: row.ownerId,
    orgId: row.orgId,
    timeCreated: row.timeCreated,
    timeUpdated: row.timeUpdated,
  }
}

async function loadApp(appId: string) {
  const rows = await db.select().from(bizApp).where(eq(bizApp.appId, appId)).limit(1)
  return rows[0]
}

export const appRoutes = new Hono<AppEnv>()

appRoutes.use("*", requireAuth)

appRoutes.get("/", async (c) => {
  const userId = c.get("userId")
  const ids = await listObjects(db, {
    subject: { type: "user", id: userId },
    permission: "read",
    type: "app",
  })
  if (ids.length === 0) return c.json({ items: [] })
  const rows = await db.select().from(bizApp).where(inArray(bizApp.appId, ids))
  rows.sort((a, b) => b.timeUpdated - a.timeUpdated)
  return c.json({ items: rows.map(serialize) })
})

appRoutes.post("/", async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw errors.invalid(issue?.message ?? "参数错误", issue?.path?.join("."))
  }
  const input = parsed.data
  const userId = c.get("userId")

  // 1) Git 服务可用性
  const allowed = await check(db, {
    subject: { type: "user", id: userId },
    permission: "use",
    object: { type: "git_provider", id: input.gitProviderId },
  })
  if (!allowed) throw errors.notFound("git_provider")
  const { instance, client } = await loadGitInstance(db, input.gitProviderId)
  if (instance.status !== "active") {
    throw errors.conflict("Git 服务凭据已失效，请重新校验", "git_provider_invalid")
  }

  // 2) 应用 ID 唯一
  if (await loadApp(input.appId)) throw errors.conflict(`${input.appId} 应用已存在`, "app_exists")

  const now = Date.now()
  const orgId = input.orgId ?? null

  // 3) 先落记录（initializing），失败可追踪
  await db.insert(bizApp).values({
    appId: input.appId,
    name: input.name,
    domain: input.domain ?? "",
    baseRoute: "",
    config: { appId: input.appId, name: input.name, techStack: input.techStack } as never,
    enabled: true,
    type: input.type,
    techStack: input.techStack,
    gitProviderInstanceId: input.gitProviderId,
    repoUrl: "",
    defaultBranch: input.defaultBranch,
    status: "initializing",
    ownerId: userId,
    orgId,
    timeCreated: now,
    timeUpdated: now,
  })

  try {
    // 4) 仓库：新建或复用
    // GitLab 的 commits API 区分 create/update（必须精确匹配文件是否存在）；
    // GitHub 的 contents API 是 upsert（update 也能创建）。因此：
    //  - GitLab：建空仓库 + 全部 create
    //  - GitHub：建带初始 commit 的仓库 + 全部 update（README 会被覆盖）
    const isGitlab = instance.type === "gitlab"
    let repo
    if (input.repo.mode === "create") {
      repo = await client.createRepo({
        name: input.repo.name?.trim() || input.appId,
        owner: input.repo.owner,
        visibility: input.repo.visibility,
        initReadme: !isGitlab,
      })
    } else {
      const raw = input.repo.path?.trim()
      if (!raw) throw errors.invalid("请填写已存在的仓库（owner/repo）", "repo.path")
      const { path } = resolveRepo(raw)
      if (!path.includes("/")) throw errors.invalid("仓库地址格式应为 owner/repo", "repo.path")
      repo = { path, url: `${instance.baseUrl.replace(/\/+$/, "")}/${path}` }
      // 校验仓库可访问
      await client.listBranches(repo)
    }

    // 5) 脚手架初始化提交
    const files = viteReactScaffold({ name: input.name, appId: input.appId })
    await client.commitFiles(repo, input.defaultBranch, {
      message: "chore: init from OpenCode Chat template (vite + react + shadcn + tailwind)",
      actions: files.map((f) => ({
        action: isGitlab ? ("create" as const) : ("update" as const),
        path: f.path,
        content: f.content,
      })),
    })

    // 6) 写归属关系
    await writeTuples(db, [
      {
        resourceType: "app",
        resourceId: input.appId,
        relation: "owner",
        subjectType: "user",
        subjectId: userId,
        createdBy: userId,
      },
      ...(orgId
        ? [
            {
              resourceType: "app" as const,
              resourceId: input.appId,
              relation: "viewer",
              subjectType: "org" as const,
              subjectId: orgId,
              createdBy: userId,
            },
          ]
        : []),
    ])

    await db
      .update(bizApp)
      .set({ repoUrl: repo.url, status: "ready", timeUpdated: Date.now() })
      .where(eq(bizApp.appId, input.appId))

    await writeAudit(
      {
        actorId: userId,
        action: "app.create",
        resourceType: "app",
        resourceId: input.appId,
        metadata: { repo: repo.path, techStack: input.techStack, provider: instance.type },
      },
      c,
    )

    const row = await loadApp(input.appId)
    if (!row) throw errors.internal("应用创建后读取失败")
    return c.json(serialize(row), 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db
      .update(bizApp)
      .set({ status: "failed", error: message.slice(0, 500), timeUpdated: Date.now() })
      .where(eq(bizApp.appId, input.appId))
    throw error
  }
})

appRoutes.get("/:appId", async (c) => {
  const appId = c.req.param("appId")
  const ok = await check(db, {
    subject: { type: "user", id: c.get("userId") },
    permission: "read",
    object: { type: "app", id: appId },
  })
  if (!ok) throw errors.notFound("app")
  const row = await loadApp(appId)
  if (!row) throw errors.notFound("app")
  return c.json(serialize(row))
})

appRoutes.get("/:appId/harness", async (c) => {
  const appId = c.req.param("appId")
  if (!await check(db, { subject: { type: "user", id: c.get("userId") }, permission: "manage", object: { type: "app", id: appId } })) throw errors.notFound("app")
  const app = await loadApp(appId)
  if (!app) throw errors.notFound("app")
  c.header("cache-control", "no-store")
  return c.json({ config: readHarness(app.config) })
})

appRoutes.put("/:appId/harness", async (c) => {
  const appId = c.req.param("appId")
  const userId = c.get("userId")
  if (!await check(db, { subject: { type: "user", id: userId }, permission: "manage", object: { type: "app", id: appId } })) throw errors.notFound("app")
  const config = parseHarness(await c.req.json().catch(() => null))
  const stored = JSON.stringify(sealHarness(config))
  const updated = await db.update(bizApp).set({
    config: sql`jsonb_set(coalesce(${bizApp.config}, '{}'::jsonb), '{harness}', ${stored}::jsonb)`, timeUpdated: Date.now(),
  }).where(eq(bizApp.appId, appId)).returning({ id: bizApp.appId })
  if (!updated.length) throw errors.notFound("app")
  await writeAudit({ actorId: userId, action: "app.harness.update", resourceType: "app", resourceId: appId,
    metadata: { agents: config.agents.length, skills: config.skills.length, mcps: config.mcps.length, commands: config.commands.length, tools: config.tools.length, plugins: config.plugins.length } }, c)
  c.header("cache-control", "no-store")
  return c.json({ ok: true })
})

/** 应用下的需求列表（含主会话，供工作台左侧展示） */
appRoutes.patch("/:appId/git-provider", async (c) => {
  const appId = c.req.param("appId")
  const userId = c.get("userId")
  const allowed = await check(db, { subject: { type: "user", id: userId }, permission: "manage", object: { type: "app", id: appId } })
  if (!allowed) throw errors.notFound("app")
  const parsed = z.object({ gitProviderId: z.string().trim().min(1).max(100) }).safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw errors.invalid("请选择 Git 服务", "gitProviderId")
  const row = await loadApp(appId)
  if (!row) throw errors.notFound("app")
  const providerId = parsed.data.gitProviderId
  const canUse = await check(db, { subject: { type: "user", id: userId }, permission: "use", object: { type: "git_provider", id: providerId } })
  if (!canUse) throw errors.notFound("git_provider")
  const { instance, client } = await loadGitInstance(db, providerId)
  if (instance.status !== "active") throw errors.conflict("Git 服务凭据已失效，请重新授权", "git_provider_invalid")
  const repo = resolveRepo(row.repoUrl)
  if (!repo.host || repo.host !== new URL(instance.baseUrl).hostname) throw errors.invalid("Git 服务与应用仓库地址不匹配")
  await client.listBranches({ path: repo.path, url: row.repoUrl })
  await db.update(bizApp).set({ gitProviderInstanceId: providerId, timeUpdated: Date.now() }).where(eq(bizApp.appId, appId))
  await writeAudit({ actorId: userId, action: "app.git_provider.update", resourceType: "app", resourceId: appId, metadata: { previous: row.gitProviderInstanceId, gitProviderId: providerId } }, c)
  const updated = await loadApp(appId)
  if (!updated) throw errors.notFound("app")
  return c.json(serialize(updated))
})

/** 应用下的需求列表（含主会话，供工作台左侧展示） */
appRoutes.get("/:appId/requirements", async (c) => {
  const appId = c.req.param("appId")
  const userId = c.get("userId")
  const ok = await check(db, {
    subject: { type: "user", id: userId },
    permission: "read",
    object: { type: "app", id: appId },
  })
  if (!ok) throw errors.notFound("app")

  const rows = await db
    .select({
      id: requirement.id,
      title: requirement.title,
      status: requirement.status,
      kind: requirement.kind,
      priority: requirement.priority,
      timeCreated: requirement.timeCreated,
      timeUpdated: requirement.timeUpdated,
      sessionId: requirementSession.sessionId,
      sessionRole: requirementSession.role,
    })
    .from(requirement)
    .leftJoin(requirementSession, eq(requirementSession.requirementId, requirement.id))
    .where(eq(requirement.appId, appId))

  // 每个需求保留主会话（优先 primary）
  const byRequirement = new Map<
    string,
    {
      id: string
      title: string
      status: string
      kind: string | null
      priority: string | null
      timeCreated: number
      timeUpdated: number
      sessionId: string | null
    }
  >()
  for (const row of rows) {
    const current = byRequirement.get(row.id)
    const isPrimary = row.sessionRole === "primary"
    if (!current) {
      byRequirement.set(row.id, {
        id: row.id,
        title: row.title,
        status: row.status,
        kind: row.kind,
        priority: row.priority,
        timeCreated: row.timeCreated,
        timeUpdated: row.timeUpdated,
        sessionId: row.sessionId ?? null,
      })
    } else if (isPrimary && row.sessionId) {
      current.sessionId = row.sessionId
    }
  }

  const items = [...byRequirement.values()].sort((a, b) => b.timeUpdated - a.timeUpdated)
  return c.json({ items })
})

/** 应用下的会话（通过 requirement.app_id 关联） */
appRoutes.get("/:appId/sessions", async (c) => {
  const appId = c.req.param("appId")
  const userId = c.get("userId")
  const ok = await check(db, {
    subject: { type: "user", id: userId },
    permission: "read",
    object: { type: "app", id: appId },
  })
  if (!ok) throw errors.notFound("app")

  const rows = await db
    .select({
      sessionId: requirementSession.sessionId,
      requirementId: requirementSession.requirementId,
      role: requirementSession.role,
      timeCreated: requirementSession.timeCreated,
      title: requirement.title,
      status: requirement.status,
    })
    .from(requirementSession)
    .innerJoin(requirement, eq(requirementSession.requirementId, requirement.id))
    .where(eq(requirement.appId, appId))
  rows.sort((a, b) => b.timeCreated - a.timeCreated)
  return c.json({ items: rows })
})

appRoutes.delete("/:appId", async (c) => {
  const appId = c.req.param("appId")
  const userId = c.get("userId")
  const ok = await check(db, {
    subject: { type: "user", id: userId },
    permission: "delete",
    object: { type: "app", id: appId },
  })
  if (!ok) throw errors.notFound("app")
  await db.transaction(async (tx) => {
    await tx.delete(bizApp).where(eq(bizApp.appId, appId))
    await deleteResourceGraph(tx as unknown as typeof db, "app", appId)
  })
  await writeAudit(
    { actorId: userId, action: "app.delete", resourceType: "app", resourceId: appId },
    c,
  )
  return c.json({ ok: true })
})
