/**
 * Git 服务连接（P1：注册 + 校验 + 列分支）。
 * token 加密存 PG，接口只返回脱敏信息；使用时解密仅在服务端。
 */
import { Hono } from "hono"
import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { check, deleteResourceGraph, listObjects, writeTuples } from "../authz/index.js"
import { db } from "../db/index.js"
import { gitCredential, gitProviderInstance } from "../db/schema.js"
import { decryptSecret, encryptSecret, maskSecret } from "../lib/crypto.js"
import { writeAudit, writeDeny } from "../lib/audit.js"
import { errors } from "../lib/errors.js"
import { createGitClient } from "../lib/git/client.js"
import { loadGitInstance } from "../lib/git/instance.js"
import { resolveRepo } from "../lib/git/types.js"
import { requireAuth, type AppEnv } from "../middleware/auth.js"

const createBody = z.object({
  type: z.enum(["gitlab", "github"]),
  displayName: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().url().max(500),
  apiBaseUrl: z.string().trim().url().max(500).optional(),
  token: z.string().trim().min(8, "token 过短").max(500),
  /** 只读 / 读写（决定提示用户申请的 scope，不改变校验方式） */
  scope: z.enum(["read", "write"]).default("read"),
  /** 归属：默认个人 */
  ownerType: z.enum(["user", "org"]).default("user"),
  ownerId: z.string().trim().max(100).optional(),
})

function serialize(row: typeof gitProviderInstance.$inferSelect, secretHint?: string) {
  return {
    id: row.id,
    type: row.type,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    apiBaseUrl: row.apiBaseUrl,
    authMethod: row.authMethod,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    status: row.status,
    secretHint,
    timeCreated: row.timeCreated,
  }
}

async function loadInstance(id: string) {
  const rows = await db.select().from(gitProviderInstance).where(eq(gitProviderInstance.id, id)).limit(1)
  return rows[0]
}

async function loadSecret(instanceId: string) {
  const rows = await db.select().from(gitCredential).where(eq(gitCredential.providerInstanceId, instanceId)).limit(1)
  const row = rows[0]
  if (!row) throw errors.internal("凭据缺失")
  return { row, token: decryptSecret(row.secretEncrypted) }
}

export const gitProviderRoutes = new Hono<AppEnv>()

gitProviderRoutes.use("*", requireAuth)

gitProviderRoutes.get("/", async (c) => {
  const userId = c.get("userId")
  const ids = await listObjects(db, {
    subject: { type: "user", id: userId },
    permission: "use",
    type: "git_provider",
  })
  if (ids.length === 0) return c.json({ items: [] })
  const rows = await db.select().from(gitProviderInstance).where(inArray(gitProviderInstance.id, ids))
  const credentials = await db
    .select()
    .from(gitCredential)
    .where(inArray(gitCredential.providerInstanceId, ids))
  const hints = new Map<string, string>()
  for (const cred of credentials) {
    try {
      hints.set(cred.providerInstanceId, maskSecret(decryptSecret(cred.secretEncrypted)))
    } catch {
      hints.set(cred.providerInstanceId, "****")
    }
  }
  return c.json({ items: rows.map((row) => serialize(row, hints.get(row.id))) })
})

gitProviderRoutes.post("/", async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw errors.invalid(issue?.message ?? "参数错误", issue?.path?.join("."))
  }
  const input = parsed.data
  const userId = c.get("userId")

  let ownerType = input.ownerType
  let ownerId = input.ownerType === "user" ? userId : input.ownerId
  if (ownerType === "org") {
    if (!ownerId) throw errors.invalid("组织归属需要 ownerId", "ownerId")
    const ok = await check(db, {
      subject: { type: "user", id: userId },
      permission: "manage",
      object: { type: "org", id: ownerId },
    })
    if (!ok) throw errors.notFound("org")
  } else {
    ownerId = userId
  }

  // 先验证 token，避免存无效凭据
  const client = createGitClient(input.type, {
    baseUrl: input.baseUrl,
    apiBaseUrl: input.apiBaseUrl,
    token: input.token,
  })
  let identity
  try {
    identity = await client.verify()
  } catch (error) {
    throw errors.invalid(
      `Git 凭据校验失败：${error instanceof Error ? error.message : String(error)}`,
      "token",
    )
  }

  const now = Date.now()
  const id = `gp_${crypto.randomUUID().replace(/-/g, "")}`
  const prefix = `${input.baseUrl.replace(/\/+$/, "")}/`

  await db.transaction(async (tx) => {
    await tx.insert(gitProviderInstance).values({
      id,
      type: input.type,
      displayName: input.displayName,
      baseUrl: input.baseUrl,
      apiBaseUrl: input.apiBaseUrl ?? null,
      authMethod: "key",
      ownerType,
      ownerId: ownerId ?? null,
      status: "active",
      timeCreated: now,
      timeUpdated: now,
    })
    await tx.insert(gitCredential).values({
      id: `gc_${crypto.randomUUID().replace(/-/g, "")}`,
      providerInstanceId: id,
      prefix,
      scopes: [input.scope],
      authKind: input.type === "github" ? "pat" : "pat",
      ownerType,
      ownerId: ownerId ?? null,
      secretEncrypted: encryptSecret(input.token),
      timeCreated: now,
    })
    await writeTuples(tx as unknown as typeof db, [
      {
        resourceType: "git_provider",
        resourceId: id,
        relation: ownerType === "org" ? "owner" : "owner",
        subjectType: ownerType === "org" ? "org" : "user",
        subjectId: ownerId ?? userId,
        createdBy: userId,
      },
      // 组织资源：成员可「使用」但不可读 secret（read_secret 只给 owner/admin）
      ...(ownerType === "org" && ownerId
        ? [
            {
              resourceType: "git_provider" as const,
              resourceId: id,
              relation: "user",
              subjectType: "org" as const,
              subjectId: ownerId,
              createdBy: userId,
            },
          ]
        : []),
    ])
  })

  const row = await loadInstance(id)
  if (!row) throw errors.internal("创建 Git 服务失败")
  await writeAudit(
    {
      actorId: userId,
      action: "git_provider.create",
      resourceType: "git_provider",
      resourceId: id,
      metadata: { type: input.type, baseUrl: input.baseUrl, ownerType },
    },
    c,
  )
  return c.json(serialize(row, maskSecret(input.token)), 201)
})

gitProviderRoutes.post("/:id/verify", async (c) => {
  const id = c.req.param("id")
  const userId = c.get("userId")
  const allowed = await check(db, {
    subject: { type: "user", id: userId },
    permission: "use",
    object: { type: "git_provider", id },
  })
  if (!allowed) throw errors.notFound("git_provider")
  const instance = await loadInstance(id)
  if (!instance) throw errors.notFound("git_provider")
  const { token } = await loadSecret(id)
  const client = createGitClient(instance.type as "gitlab" | "github", {
    baseUrl: instance.baseUrl,
    apiBaseUrl: instance.apiBaseUrl,
    token,
  })
  try {
    const identity = await client.verify()
    await db
      .update(gitProviderInstance)
      .set({ status: "active", timeUpdated: Date.now() })
      .where(eq(gitProviderInstance.id, id))
    return c.json({ ok: true, identity })
  } catch (error) {
    await db
      .update(gitProviderInstance)
      .set({ status: "invalid", timeUpdated: Date.now() })
      .where(eq(gitProviderInstance.id, id))
    throw errors.invalid(
      `凭据校验失败：${error instanceof Error ? error.message : String(error)}`,
      "token",
    )
  }
})

const createBranchBody = z.object({
  repo: z.string().trim().min(3).max(500),
  name: z.string().trim().min(1).max(200),
  from: z.string().trim().min(1).max(200),
})

/** 创建分支（基于已有分支） */
gitProviderRoutes.post("/:id/branches", async (c) => {
  const id = c.req.param("id")
  const userId = c.get("userId")
  const allowed = await check(db, {
    subject: { type: "user", id: userId },
    permission: "use",
    object: { type: "git_provider", id },
  })
  if (!allowed) throw errors.notFound("git_provider")
  const parsed = createBranchBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw errors.invalid(issue?.message ?? "参数错误", issue?.path?.join("."))
  }
  const { path } = resolveRepo(parsed.data.repo)
  if (!path.includes("/")) throw errors.invalid("仓库地址格式应为 owner/repo", "repo")
  const { instance, client } = await loadGitInstance(db, id)
  if (instance.status !== "active") throw errors.conflict("Git 服务凭据已失效，请重新校验", "git_provider_invalid")
  const branch = await client.createBranch(
    { path, url: `${instance.baseUrl.replace(/\/+$/, "")}/${path}` },
    parsed.data.name,
    parsed.data.from,
  )
  return c.json({ branch }, 201)
})

gitProviderRoutes.get("/:id/branches", async (c) => {
  const id = c.req.param("id")
  const userId = c.get("userId")
  const allowed = await check(db, {
    subject: { type: "user", id: userId },
    permission: "use",
    object: { type: "git_provider", id },
  })
  if (!allowed) throw errors.notFound("git_provider")
  const repoInput = c.req.query("repo")
  if (!repoInput) throw errors.invalid("缺少 repo 参数", "repo")
  const { path } = resolveRepo(repoInput)
  if (!path.includes("/")) throw errors.invalid("仓库地址格式应为 owner/repo", "repo")

  const instance = await loadInstance(id)
  if (!instance) throw errors.notFound("git_provider")
  if (instance.status !== "active") throw errors.conflict("Git 服务凭据已失效，请重新校验", "git_provider_invalid")
  const { token } = await loadSecret(id)
  const client = createGitClient(instance.type as "gitlab" | "github", {
    baseUrl: instance.baseUrl,
    apiBaseUrl: instance.apiBaseUrl,
    token,
  })
  const branches = await client.listBranches({ path, url: `${instance.baseUrl.replace(/\/+$/, "")}/${path}` })
  return c.json({ repo: path, items: branches })
})

const createRepoBody = z.object({
  name: z.string().trim().min(1).max(100).regex(/^[\w.-]+$/, "仓库名只能包含字母、数字、下划线、点和短横线"),
  owner: z.string().trim().max(200).optional(),
  visibility: z.enum(["private", "public"]).default("private"),
  description: z.string().trim().max(500).optional(),
  initReadme: z.boolean().default(true),
})

/** 建仓：GitLab POST /projects；GitHub POST /orgs/:org/repos 或 /user/repos */
gitProviderRoutes.post("/:id/repos", async (c) => {
  const id = c.req.param("id")
  const userId = c.get("userId")
  const allowed = await check(db, {
    subject: { type: "user", id: userId },
    permission: "use",
    object: { type: "git_provider", id },
  })
  if (!allowed) throw errors.notFound("git_provider")
  const parsed = createRepoBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw errors.invalid(issue?.message ?? "参数错误", issue?.path?.join("."))
  }
  const { instance, client } = await loadGitInstance(db, id)
  if (instance.status !== "active") throw errors.conflict("Git 服务凭据已失效，请重新校验", "git_provider_invalid")
  const repo = await client.createRepo(parsed.data)
  return c.json({ repo }, 201)
})

const commitBody = z.object({
  repo: z.string().trim().min(3).max(500),
  branch: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(500),
  startBranch: z.string().trim().max(200).optional(),
  actions: z
    .array(
      z.object({
        action: z.enum(["create", "update", "delete"]),
        path: z.string().trim().min(1).max(1000),
        content: z.string().max(2_000_000).optional(),
      }),
    )
    .min(1, "至少一个文件操作"),
})

/** 提交：GitLab 一次多文件；GitHub 逐文件（每个文件一个 commit） */
gitProviderRoutes.post("/:id/commit", async (c) => {
  const id = c.req.param("id")
  const userId = c.get("userId")
  const allowed = await check(db, {
    subject: { type: "user", id: userId },
    permission: "use",
    object: { type: "git_provider", id },
  })
  if (!allowed) throw errors.notFound("git_provider")
  const parsed = commitBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw errors.invalid(issue?.message ?? "参数错误", issue?.path?.join("."))
  }
  const { path } = resolveRepo(parsed.data.repo)
  if (!path.includes("/")) throw errors.invalid("仓库地址格式应为 owner/repo", "repo")
  const { instance, client } = await loadGitInstance(db, id)
  if (instance.status !== "active") throw errors.conflict("Git 服务凭据已失效，请重新校验", "git_provider_invalid")
  const result = await client.commitFiles(
    { path, url: `${instance.baseUrl.replace(/\/+$/, "")}/${path}` },
    parsed.data.branch,
    { message: parsed.data.message, actions: parsed.data.actions, startBranch: parsed.data.startBranch },
  )
  return c.json(result)
})

/** 可建仓的归属（GitHub org / GitLab group）；失败返回空列表 */
gitProviderRoutes.get("/:id/owners", async (c) => {
  const id = c.req.param("id")
  const userId = c.get("userId")
  const allowed = await check(db, {
    subject: { type: "user", id: userId },
    permission: "use",
    object: { type: "git_provider", id },
  })
  if (!allowed) throw errors.notFound("git_provider")
  const { instance, client } = await loadGitInstance(db, id)
  if (instance.status !== "active") throw errors.conflict("Git 服务凭据已失效，请重新校验", "git_provider_invalid")
  const items = await client.listOwners()
  return c.json({ items })
})

gitProviderRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const userId = c.get("userId")
  const allowed = await check(db, {
    subject: { type: "user", id: userId },
    permission: "manage",
    object: { type: "git_provider", id },
  })
  if (!allowed) throw errors.notFound("git_provider")
  await db.transaction(async (tx) => {
    await tx.delete(gitCredential).where(eq(gitCredential.providerInstanceId, id))
    await tx.delete(gitProviderInstance).where(eq(gitProviderInstance.id, id))
    await deleteResourceGraph(tx as unknown as typeof db, "git_provider", id)
  })
  await writeAudit(
    { actorId: userId, action: "git_provider.delete", resourceType: "git_provider", resourceId: id },
    c,
  )
  return c.json({ ok: true })
})
