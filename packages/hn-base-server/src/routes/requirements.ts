/**
 * 需求 CRUD（P0）。
 * 关键约束：创建/更新资源与写 relation_tuple 必须在同一事务，
 * 否则会出现「资源存在但无人可访问」。
 */
import { Hono, type Context } from "hono"
import { z } from "zod"
import { and, eq, ilike, inArray, or } from "drizzle-orm"
import { check, deleteResourceGraph, listObjects, writeTuples } from "../authz/index.js"
import { db } from "../db/index.js"
import { bizApp, requirement, requirementChange, requirementSession, user } from "../db/schema.js"
import { loadGitInstance } from "../lib/git/instance.js"
import { saasCreateSession, saasRunShell } from "../lib/saas.js"
import { gitUsername, resolveRepo } from "../lib/git/types.js"
import { writeAudit, writeDeny } from "../lib/audit.js"
import { errors } from "../lib/errors.js"
import { canTransition, isRequirementStatus, transitionError } from "../lib/requirement-state.js"
import { requireAuth, type AppEnv } from "../middleware/auth.js"
import { applyHarness, emptyHarness, readHarness } from "../lib/harness.js"

const createBody = z.object({
  title: z.string().trim().min(1, "标题不能为空").max(200),
  description: z.string().max(20_000).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  kind: z.enum(["regular", "bugfix"]).optional(),
  repoUrl: z.string().trim().max(500).optional(),
  gitProviderInstanceId: z.string().trim().max(100).optional(),
  /** 关联应用（应用工作台） */
  appId: z.string().trim().max(100).optional(),
  baseBranch: z.string().trim().max(200).optional(),
  workBranch: z.string().trim().max(200).optional(),
  /** 组织资源；不传或 null = 个人资源 */
  orgId: z.string().trim().max(100).nullable().optional(),
  projectId: z.string().trim().max(100).optional(),
})

const updateBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20_000).nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).nullable().optional(),
  kind: z.enum(["regular", "bugfix"]).nullable().optional(),
  status: z.enum(["draft", "open", "in_progress", "pending_publish", "done", "archived"]).optional(),
  repoUrl: z.string().trim().max(500).nullable().optional(),
  baseBranch: z.string().trim().max(200).nullable().optional(),
  workBranch: z.string().trim().max(200).nullable().optional(),
})

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`
}

function serialize(row: typeof requirement.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    kind: row.kind,
    repoUrl: row.repoUrl,
    gitProviderInstanceId: row.gitProviderInstanceId,
    appId: row.appId,
    baseBranch: row.baseBranch,
    workBranch: row.workBranch,
    ownerId: row.ownerId,
    orgId: row.orgId,
    projectId: row.projectId,
    timeCreated: row.timeCreated,
    timeUpdated: row.timeUpdated,
  }
}

async function loadRequirement(id: string) {
  const rows = await db.select().from(requirement).where(inArray(requirement.id, [id])).limit(1)
  return rows[0]
}

async function loadRequirementWithOwner(id: string) {
  const rows = await db
    .select({ row: requirement, ownerName: user.name, ownerEmail: user.email })
    .from(requirement)
    .leftJoin(user, eq(requirement.ownerId, user.id))
    .where(inArray(requirement.id, [id]))
    .limit(1)
  const found = rows[0]
  return found ? { ...serialize(found.row), ownerName: found.ownerName, ownerEmail: found.ownerEmail } : undefined
}

async function assertAccess(userId: string, id: string, permission: string, c?: Context) {
  const ok = await check(db, {
    subject: { type: "user", id: userId },
    permission,
    object: { type: "requirement", id },
  })
  if (!ok) {
    if (c) {
      await writeDeny(c, {
        actorId: userId,
        action: `requirement.${permission}`,
        resourceType: "requirement",
        resourceId: id,
      })
    }
    throw errors.notFound("requirement")
  }
}

export const requirementRoutes = new Hono<AppEnv>()

requirementRoutes.use("*", requireAuth)

/**
 * 列表：只返回我可见的（个人 + 我所在组织 + 显式共享）。
 * 支持 ?q= 搜索标题/ID、?appId= 过滤、?limit= 限制条数。
 * 每项附带所属应用名与主会话（供「打开会话」）。
 */
requirementRoutes.get("/", async (c) => {
  const userId = c.get("userId")
  const ids = await listObjects(db, {
    subject: { type: "user", id: userId },
    permission: "read",
    type: "requirement",
  })
  if (ids.length === 0) return c.json({ items: [] })

  const q = c.req.query("q")?.trim()
  const appId = c.req.query("appId")?.trim()
  const limitRaw = Number(c.req.query("limit") ?? 0)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 200

  const conditions = [inArray(requirement.id, ids)]
  if (q) {
    conditions.push(
      or(ilike(requirement.title, `%${q}%`), ilike(requirement.id, `%${q}%`))!,
    )
  }
  if (appId) conditions.push(eq(requirement.appId, appId))

  const rows = await db
    .select({
      row: requirement,
      ownerName: user.name,
      ownerEmail: user.email,
      appName: bizApp.name,
      sessionId: requirementSession.sessionId,
      sessionRole: requirementSession.role,
    })
    .from(requirement)
    .leftJoin(user, eq(requirement.ownerId, user.id))
    .leftJoin(bizApp, eq(requirement.appId, bizApp.appId))
    .leftJoin(requirementSession, eq(requirementSession.requirementId, requirement.id))
    .where(and(...conditions))

  const merged = new Map<
    string,
    {
      item: ReturnType<typeof serialize> & {
        ownerName: string | null
        ownerEmail: string | null
        appName: string | null
        sessionId: string | null
      }
      timeUpdated: number
    }
  >()
  for (const row of rows) {
    const current = merged.get(row.row.id)
    if (!current) {
      merged.set(row.row.id, {
        item: {
          ...serialize(row.row),
          ownerName: row.ownerName,
          ownerEmail: row.ownerEmail,
          appName: row.appName,
          sessionId: row.sessionId ?? null,
        },
        timeUpdated: row.row.timeUpdated,
      })
    } else if (row.sessionRole === "primary" && row.sessionId) {
      current.item.sessionId = row.sessionId
    }
  }

  const items = [...merged.values()]
    .sort((a, b) => b.timeUpdated - a.timeUpdated)
    .slice(0, limit)
    .map((x) => x.item)
  return c.json({ items })
})

requirementRoutes.post("/", async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw errors.invalid(issue?.message ?? "参数错误", issue?.path?.join("."))
  }
  const input = parsed.data
  const userId = c.get("userId")
  const orgId = input.orgId ?? null
  const now = Date.now()
  const id = newId("req")

  await db.transaction(async (tx) => {
    await tx.insert(requirement).values({
      id,
      title: input.title,
      description: input.description ?? null,
      status: "open",
      priority: input.priority ?? null,
      kind: input.kind ?? null,
      repoUrl: input.repoUrl ?? null,
      gitProviderInstanceId: input.gitProviderInstanceId ?? null,
      appId: input.appId ?? null,
      baseBranch: input.baseBranch ?? null,
      workBranch: input.workBranch ?? null,
      ownerId: userId,
      orgId,
      projectId: input.projectId ?? null,
      timeCreated: now,
      timeUpdated: now,
    })

    const tuples: Parameters<typeof writeTuples>[1] = [
      { resourceType: "requirement", resourceId: id, relation: "owner", subjectType: "user", subjectId: userId, createdBy: userId },
    ]
    if (input.projectId) {
      tuples.push({
        resourceType: "requirement",
        resourceId: id,
        relation: "parent",
        subjectType: "project",
        subjectId: input.projectId,
        createdBy: userId,
      })
    }
    if (orgId) {
      tuples.push({
        resourceType: "requirement",
        resourceId: id,
        relation: "viewer",
        subjectType: "org",
        subjectId: orgId,
        createdBy: userId,
      })
    }
    await writeTuples(tx as unknown as typeof db, tuples)
  })

  const row = await loadRequirement(id)
  if (!row) throw errors.internal("需求创建失败")
  await writeAudit(
    { actorId: userId, action: "requirement.create", resourceType: "requirement", resourceId: id },
    c,
  )
  return c.json(serialize(row), 201)
})

/** 详情：check(read) → 404 */
requirementRoutes.get("/:id", async (c) => {
  const id = c.req.param("id")
  await assertAccess(c.get("userId"), id, "read", c)
  const item = await loadRequirementWithOwner(id)
  if (!item) throw errors.notFound("requirement")
  return c.json(item)
})

requirementRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id")
  await assertAccess(c.get("userId"), id, "write", c)
  const parsed = updateBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw errors.invalid(issue?.message ?? "参数错误", issue?.path?.join("."))
  }
  const input = parsed.data

  // 状态迁移由后端校验（唯一规则见 lib/requirement-state.ts）
  if (input.status !== undefined) {
    const current = await loadRequirement(id)
    if (!current) throw errors.notFound("requirement")
    if (isRequirementStatus(current.status) && !canTransition(current.status, input.status)) {
      throw errors.conflict(
        transitionError(current.status as Parameters<typeof transitionError>[0], input.status) ?? "状态迁移非法",
        "invalid_status_transition",
      )
    }
  }

  const patch: Partial<typeof requirement.$inferInsert> = { timeUpdated: Date.now() }
  if (input.title !== undefined) patch.title = input.title
  if (input.description !== undefined) patch.description = input.description
  if (input.priority !== undefined) patch.priority = input.priority
  if (input.kind !== undefined) patch.kind = input.kind
  if (input.status !== undefined) patch.status = input.status
  if (input.repoUrl !== undefined) patch.repoUrl = input.repoUrl
  if (input.baseBranch !== undefined) patch.baseBranch = input.baseBranch
  if (input.workBranch !== undefined) patch.workBranch = input.workBranch

  await db.update(requirement).set(patch).where(inArray(requirement.id, [id]))
  const row = await loadRequirement(id)
  if (!row) throw errors.notFound("requirement")
  await writeAudit(
    {
      actorId: c.get("userId"),
      action: "requirement.update",
      resourceType: "requirement",
      resourceId: id,
      metadata: { fields: Object.keys(input) },
    },
    c,
  )
  return c.json(serialize(row))
})

const prepareBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional(),
  appId: z.string().trim().max(100).optional(),
  /** 仓库与分支：传了才会执行 clone + checkout */
  gitProviderId: z.string().trim().max(100).optional(),
  repoUrl: z.string().trim().max(500).optional(),
  baseBranch: z.string().trim().max(200).default("main"),
  workBranch: z.string().trim().max(200).optional(),
  directory: z.string().trim().max(500).default("/workspace"),
})

/** shell 单引号转义 */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}


/**
 * 创建需求 + 会话 + 准备沙箱工作区（一次完成）。
 *  1. 需求落库并写归属
 *  2. SaaS 创建会话并关联
 *  3. 按选中分支在远端建分支（已存在则忽略）
 *  4. 通过 SaaS shell 执行：写临时 .netrc → git init/fetch → checkout 工作分支 → 删除 .netrc
 */
requirementRoutes.post("/prepare", async (c) => {
  const parsed = prepareBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw errors.invalid(issue?.message ?? "参数错误", issue?.path?.join("."))
  }
  const input = parsed.data
  const userId = c.get("userId")
  const now = Date.now()
  const requirementId = newId("req")

  let harness = emptyHarness()
  if (input.appId) {
    const canRun = await check(db, { subject: { type: "user", id: userId }, permission: "run", object: { type: "app", id: input.appId } })
    if (!canRun) throw errors.notFound("app")
    const [app] = await db.select().from(bizApp).where(eq(bizApp.appId, input.appId)).limit(1)
    if (!app) throw errors.notFound("app")
    harness = readHarness(app.config)
  }

  // 1) 需求
  await db.transaction(async (tx) => {
    await tx.insert(requirement).values({
      id: requirementId,
      title: input.title,
      description: input.description ?? null,
      status: "open",
      repoUrl: input.repoUrl ?? null,
      gitProviderInstanceId: input.gitProviderId ?? null,
      appId: input.appId ?? null,
      baseBranch: input.baseBranch,
      workBranch: input.workBranch ?? null,
      ownerId: userId,
      timeCreated: now,
      timeUpdated: now,
    })
    await writeTuples(tx as unknown as typeof db, [
      { resourceType: "requirement", resourceId: requirementId, relation: "owner", subjectType: "user", subjectId: userId, createdBy: userId },
      ...(input.appId
        ? [
            {
              resourceType: "requirement" as const,
              resourceId: requirementId,
              relation: "parent" as const,
              subjectType: "app" as const,
              subjectId: input.appId,
              createdBy: userId,
            },
          ]
        : []),
    ])
  })

  // 2) 会话
  const sessionId = await saasCreateSession({
    directory: input.directory,
    title: input.title.slice(0, 120),
    agent: "build",
  })

  await db.transaction(async (tx) => {
    await tx.insert(requirementSession).values({
      id: `rs_${crypto.randomUUID().replace(/-/g, "")}`,
      requirementId,
      sessionId,
      role: "primary",
      timeCreated: Date.now(),
    })
    await writeTuples(tx as unknown as typeof db, [
      { resourceType: "session", resourceId: sessionId, relation: "owner", subjectType: "user", subjectId: userId, createdBy: userId },
      { resourceType: "session", resourceId: sessionId, relation: "parent", subjectType: "requirement", subjectId: requirementId, createdBy: userId },
    ])
  })

  // 3) 分支 + clone（可选，失败不阻断，返回 prepareError）
  let prepared = false
  let prepareError: string | undefined
  let branch = input.workBranch ?? input.baseBranch

  const workBranch = input.workBranch
  const providerId = input.gitProviderId
  const repoUrl = input.repoUrl
  if (workBranch && providerId && repoUrl) {
    try {
      // 权限：必须能使用该 Git 服务
      const allowed = await check(db, {
        subject: { type: "user", id: userId },
        permission: "use",
        object: { type: "git_provider", id: providerId },
      })
      if (!allowed) throw new Error("无权使用该 Git 服务")
      const { instance, client } = await loadGitInstance(db, providerId)
      if (instance.status !== "active") throw new Error("Git 服务凭据已失效")
      const { host, path } = resolveRepo(repoUrl)
      if (!path.includes("/")) throw new Error("仓库地址格式应为 owner/repo")

      // 远端建分支（已存在时各平台返回 4xx，忽略；其它失败记录原因，便于定位凭据失效）
      let branchCreateError: string | undefined
      try {
        await client.createBranch({ path, url: repoUrl }, workBranch, input.baseBranch)
      } catch (error) {
        branchCreateError = error instanceof Error ? error.message : String(error)
      }

      const token = await (async () => {
        const { decryptSecret } = await import("../lib/crypto.js")
        const { gitCredential } = await import("../db/schema.js")
        const rows = await db
          .select()
          .from(gitCredential)
          .where(eq(gitCredential.providerInstanceId, providerId))
          .limit(1)
        if (!rows[0]) throw new Error("Git 凭据缺失")
        return decryptSecret(rows[0].secretEncrypted)
      })()

      const login = gitUsername(instance.type as "gitlab" | "github")
      const netrcHost = host ?? new URL(repoUrl).hostname
      const command = [
        "set -e",
        `trap 'rm -f "$HOME/.netrc"' EXIT`,
        `mkdir -p "$HOME"`,
        `printf 'machine %s login %s password %s\\n' ${sh(netrcHost)} ${sh(login)} ${sh(token)} > "$HOME/.netrc"`,
        `chmod 600 "$HOME/.netrc"`,
        `cd ${sh(input.directory)}`,
        `if [ ! -d .git ]; then git init -q; fi`,
        `git remote remove origin >/dev/null 2>&1 || true`,
        `git remote add origin ${sh(repoUrl)}`,
        `git fetch origin`,
        `git checkout -B ${sh(workBranch)} ${sh(`origin/${workBranch}`)}`,
        `git branch --show-current`,
        `echo PREPARE_OK`,
      ].join("\n")

      // 前缀 msg_prepare：前端据此过滤，保证系统编排不出现在 chat 里
      const result = await saasRunShell(sessionId, command, {
        successMarker: "PREPARE_OK",
        messageID: `msg_prepare_${crypto.randomUUID().replace(/-/g, "")}`,
      })
      if (result.exit !== 0) {
        prepareError = result.output.trim().slice(-400) || `仓库准备失败（exit ${result.exit}）`
        if (branchCreateError && !/already exists|422|409/i.test(branchCreateError)) {
          prepareError = `远端建分支失败：${branchCreateError}\n${prepareError}`
        }
      } else {
        prepared = true
      }
    } catch (error) {
      prepareError = error instanceof Error ? error.message : String(error)
    }
  }

  if (!prepareError) {
    try { await applyHarness(sessionId, harness) } catch (error) {
      prepared = false
      prepareError = error instanceof Error ? error.message : "Harness 下发失败，未启动开发"
    }
  }

  return c.json(
    {
      requirementId,
      sessionId,
      branch,
      prepared,
      ...(prepareError ? { prepareError } : {}),
    },
    201,
  )
})

const changeBody = z.object({
  providerInstanceId: z.string().trim().min(1),
  repo: z.string().trim().min(3).max(500),
  sourceBranch: z.string().trim().min(1).max(200),
  targetBranch: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(5000).optional(),
})

/** 创建 PR/MR：写 requirement_change，并在 in_progress 时自动进入 pending_publish */
requirementRoutes.post("/:id/changes", async (c) => {
  const id = c.req.param("id")
  const userId = c.get("userId")
  await assertAccess(userId, id, "run", c)

  const parsed = changeBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw errors.invalid(issue?.message ?? "参数错误", issue?.path?.join("."))
  }
  const input = parsed.data

  const current = await loadRequirement(id)
  if (!current) throw errors.notFound("requirement")

  const { path } = resolveRepo(input.repo)
  if (!path.includes("/")) throw errors.invalid("仓库地址格式应为 owner/repo", "repo")

  const { instance, client } = await loadGitInstance(db, input.providerInstanceId)
  if (instance.status !== "active") throw errors.conflict("Git 服务凭据已失效，请重新校验", "git_provider_invalid")

  const change = await client.createChange(
    { path, url: `${instance.baseUrl.replace(/\/+$/, "")}/${path}` },
    input.sourceBranch,
    input.targetBranch,
    { title: input.title ?? current.title, description: input.description },
  )

  const now = Date.now()
  const changeId = `chg_${crypto.randomUUID().replace(/-/g, "")}`
  await db.transaction(async (tx) => {
    await tx.insert(requirementChange).values({
      id: changeId,
      requirementId: id,
      providerInstanceId: input.providerInstanceId,
      number: change.number,
      url: change.url,
      state: change.state === "open" ? "opened" : change.state,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      timeCreated: now,
    })
    // 有变更待审 → 待发布
    if (current.status === "in_progress") {
      await tx.update(requirement).set({ status: "pending_publish", timeUpdated: now }).where(eq(requirement.id, id))
    }
  })

  return c.json(
    {
      id: changeId,
      number: change.number,
      url: change.url,
      state: change.state,
    },
    201,
  )
})

/** 变更列表 */
requirementRoutes.get("/:id/changes", async (c) => {
  const id = c.req.param("id")
  await assertAccess(c.get("userId"), id, "read", c)
  const rows = await db.select().from(requirementChange).where(eq(requirementChange.requirementId, id))
  return c.json({ items: rows })
})

requirementRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id")
  await assertAccess(c.get("userId"), id, "delete", c)
  await db.transaction(async (tx) => {
    await tx.delete(requirement).where(inArray(requirement.id, [id]))
    await deleteResourceGraph(tx as unknown as typeof db, "requirement", id)
  })
  await writeAudit(
    { actorId: c.get("userId"), action: "requirement.delete", resourceType: "requirement", resourceId: id },
    c,
  )
  return c.json({ ok: true })
})
