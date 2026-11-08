import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { and, desc, eq, isNull } from "drizzle-orm"
import { z } from "zod"
import { createHash } from "node:crypto"
import { db } from "../db/index.js"
import { automationApp as apps, automationDraft as drafts, automationRun as runs, instructionApp as legacyApps, instructionRun as legacyRuns } from "../db/schema.js"
import { requireAuth, type AppEnv } from "../middleware/auth.js"
import { errors } from "../lib/errors.js"
import { definition, parameters, resolveOperation } from "../lib/automation-app.js"
import { draftDefinition, draftInstruction, draftSchema, repairScript } from "../lib/automation-ai.js"
import { applyVerifiedRepairOrThrow } from "../lib/automation-repair.js"
import { findPublishableRun, publishDraft } from "../lib/automation-publish.js"
import { disposeStructured, pollStructured, startStructured, type StructuredJob } from "../lib/structured-ai.js"
import { saasFetch } from "../lib/saas.js"
import { check, writeTuples } from "../authz/index.js"
import { writeAudit } from "../lib/audit.js"
import { Model } from "@opencode/schema/model"
import { Schema } from "effect"

export const automationAppRoutes = new Hono<AppEnv>()
automationAppRoutes.use("*", requireAuth, bodyLimit({ maxSize: 256 * 1024 }))

function parse<T>(schema: z.ZodType<T>, input: unknown) {
  const result = schema.safeParse(input)
  if (!result.success) throw errors.invalid(result.error.issues[0]?.message ?? "参数格式错误")
  return result.data
}
async function ownedApp(userId: string, id: string) {
  const [app] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.id, id), eq(apps.ownerId, userId)))
  if (!app) throw errors.notFound("automation")
  return app
}
async function ownedRun(userId: string, id: string) {
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.ownerId, userId)))
  if (!run) throw errors.notFound("automation_run")
  return run
}
async function ownedDraft(userId: string, id: string) {
  const [draft] = await db.select().from(drafts).where(and(eq(drafts.id, id), eq(drafts.ownerId, userId)))
  if (!draft) throw errors.notFound("automation_draft")
  return draft
}

function draftDefinitionInput(input: unknown) {
  const value = definition(input)
  for (const step of value.steps) {
    if (step.operation.type === "script" || !step.operation.value?.includes("{{")) resolveOperation(step.operation, {})
  }
  return { value, hash: createHash("sha256").update(JSON.stringify(value)).digest("hex") }
}
async function requireSession(userId: string, id: string, permission: "read" | "run") {
  const permitted = await check(db, {
    subject: { type: "user", id: userId },
    permission,
    object: { type: "session", id },
  })
  if (!permitted) throw errors.notFound("session")
}

automationAppRoutes.get("/", async (c) => {
  const items = await db
    .select()
    .from(apps)
    .where(eq(apps.ownerId, c.get("userId")))
    .orderBy(desc(apps.timeUpdated))
    .limit(200)
  return c.json({ items })
})

async function draftSource(userId: string, sessionId: string) {
  await requireSession(userId, sessionId, "read")
  const response = await saasFetch(`/api/session/${encodeURIComponent(sessionId)}/message?order=desc&limit=100`)
  if (!response.ok) throw errors.upstream(502, "无法读取探索记录")
  const session = await saasFetch(`/api/session/${encodeURIComponent(sessionId)}`)
  if (!session.ok) throw errors.upstream(502, "无法读取探索会话模型")
  const sessionBody = (await session.json()) as { data?: { model?: unknown } }
  const history = (await response.json()) as { data?: Array<{ type?: string; model?: unknown }> }
  const candidate = sessionBody.data?.model ?? history.data?.find((message) => message.type === "assistant" && message.model)?.model
  let model: Model.Ref | undefined
  try { if (candidate) model = Schema.decodeUnknownSync(Model.Ref)(candidate) } catch { /* 旧消息模型不可解码时使用服务默认模型 */ }
  return { history, model }
}

/** 把候选整理为定义；insufficient 视为无效，交由调用方转成可读错误。 */
function toDraftDefinition(draft: Schema.Schema.Type<ReturnType<typeof draftSchema>>, model?: Model.Ref) {
  if (draft.status === "insufficient") throw errors.invalid(`无法生成可靠应用：${draft.reason.slice(0, 1000)}`)
  return definition({ name: draft.name, description: draft.description, parameters: draft.parameters, steps: draft.steps, ...(model ? { model } : {}) })
}

automationAppRoutes.post("/draft", async (c) => {
  const input = parse(z.object({ sessionId: z.string().min(1) }).strict(), await c.req.json().catch(() => null))
  const { history, model } = await draftSource(c.get("userId"), input.sessionId)
  return c.json({ definition: await draftDefinition(history, model) })
})

/**
 * 发起可观察的草稿生成：在独立临时会话中运行，并把该会话授权给当前用户，
 * 前端可订阅其 /event 实时查看思考/工具过程，再轮询 /draft/result 取结构化结果。
 */
automationAppRoutes.post("/draft/start", async (c) => {
  const input = parse(z.object({ sessionId: z.string().min(1) }).strict(), await c.req.json().catch(() => null))
  const userId = c.get("userId")
  const { history, model } = await draftSource(userId, input.sessionId)
  const job = await startStructured(draftSchema(), draftInstruction(history), model)
  // 生成会话只用于本次推理：授权给发起用户，使其可通过统一会话 SSE 观察。
  await writeTuples(db, [
    { resourceType: "session", resourceId: job.sessionId, relation: "owner", subjectType: "user", subjectId: userId },
  ])
  return c.json({ ...job, sourceSessionId: input.sessionId })
})

/** 轮询一次可观察生成；完成即落库为草稿并释放临时会话，未完成返回 generating。 */
automationAppRoutes.post("/draft/result", async (c) => {
  const input = parse(
    z.object({ job: z.object({ sessionId: z.string().min(1), promptId: z.string().min(1) }).strict(), sourceSessionId: z.string().min(1) }).strict(),
    await c.req.json().catch(() => null),
  )
  const userId = c.get("userId")
  await requireSession(userId, input.sourceSessionId, "read")
  await requireSession(userId, input.job.sessionId, "read")
  // 先看是否已落库：临时会话在终态后即释放，重查（刷新、重试、多标签）必须仍取回同一草稿，
  // 否则会因会话已删而永远停在 generating。幂等键绑定发起时的 promptId。
  const [settled] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.ownerId, userId), eq(drafts.sessionId, input.sourceSessionId), eq(drafts.generationKey, `start-${input.job.promptId}`)))
  if (settled) return c.json({ status: "ready", draft: settled })
  const outcome = await pollStructured(draftSchema(), input.job as StructuredJob)
  if (outcome.status === "pending") return c.json({ status: "generating" })
  // 终态：临时会话不再保留。
  await disposeStructured(input.job.sessionId)
  if (outcome.status === "failed") throw errors.upstream(502, outcome.error)
  const { value, hash } = draftDefinitionInput(toDraftDefinition(outcome.value))
  const [existing] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.ownerId, userId), eq(drafts.sessionId, input.sourceSessionId), eq(drafts.generationKey, `start-${input.job.promptId}`)))
  if (existing) return c.json({ status: "ready", draft: existing })
  const now = Date.now()
  const [draft] = await db.insert(drafts).values({
    id: `adraft_${crypto.randomUUID()}`, ownerId: userId, sessionId: input.sourceSessionId,
    generationKey: `start-${input.job.promptId}`, definition: value, version: 1, contentHash: hash, timeCreated: now, timeUpdated: now,
  }).returning()
  return c.json({ status: "ready", draft })
})

/** 旧指令仅提供业务目标；必须有同一应用成功运行的实际记录，才能生成固定动作候选。 */
automationAppRoutes.post("/drafts/from-legacy", async (c) => {
  const input = parse(z.object({ appId: z.string().min(1), runId: z.string().min(1) }).strict(), await c.req.json().catch(() => null))
  const ownerId = c.get("userId")
  const [legacy] = await db.select().from(legacyApps).where(and(eq(legacyApps.id, input.appId), eq(legacyApps.ownerId, ownerId)))
  if (!legacy) throw errors.notFound("automation")
  const [source] = await db.select().from(legacyRuns).where(and(eq(legacyRuns.id, input.runId), eq(legacyRuns.appId, legacy.id), eq(legacyRuns.ownerId, ownerId)))
  if (!source || source.status !== "succeeded" || source.steps.some((step) => step.status !== "succeeded"))
    throw errors.conflict("请选择这个旧应用的一次完整成功运行作为迁移证据")
  await requireSession(ownerId, source.sessionId, "run")
  const [existing] = await db.select().from(drafts).where(and(eq(drafts.ownerId, ownerId), eq(drafts.legacyAppId, legacy.id)))
  if (existing) return c.json(existing)
  const prompts = new Set(source.steps.flatMap((step) => step.promptId ? [step.promptId] : []))
  if (!prompts.size) throw errors.conflict("旧运行没有可核查的步骤消息")
  const evidence: Array<{ id?: string; promptMessageID?: string; type?: string; time?: { completed?: number } }> = []
  const found = new Set<string>()
  const completed = new Set<string>()
  let cursor: string | undefined
  // 旧运行可能早于同一会话后续数百条消息；只提取该运行的 prompt，防止误把别的任务当证据。
  for (let page = 0; page < 12 && (found.size < prompts.size || completed.size < prompts.size); page++) {
    const query = cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=desc"
    const response = await saasFetch(`/api/session/${encodeURIComponent(source.sessionId)}/message?${query}&limit=100`)
    if (!response.ok) throw errors.upstream(502, "无法读取旧应用的实际执行记录")
    const history = await response.json() as { data?: Array<{ id?: string; promptMessageID?: string; type?: string; time?: { completed?: number } }>; cursor?: { next?: string } }
    for (const message of history.data ?? []) {
      if (prompts.has(message.id ?? "") || prompts.has(message.promptMessageID ?? "")) {
        evidence.push(message)
        if (message.type === "user" && prompts.has(message.id ?? "")) found.add(message.id!)
        if (message.type === "assistant" && message.time?.completed && prompts.has(message.promptMessageID ?? ""))
          completed.add(message.promptMessageID!)
      }
    }
    cursor = history.cursor?.next
    if (!cursor || !history.data?.length) break
  }
  if (found.size !== prompts.size || completed.size !== prompts.size)
    throw errors.conflict("旧运行步骤消息不完整，请在会话中重新探索并生成固定草稿")
  const generated = await draftDefinition(evidence, legacy.definition.model, { goal: legacy.definition, output: source.output ?? "", verificationPath: legacy.definition.verification?.path })
  // 业务目标和验收条件来自已发布的旧定义，模型只生成固定执行动作。
  const { value, hash } = draftDefinitionInput({
    ...generated,
    name: legacy.definition.name,
    description: legacy.definition.description,
    parameters: legacy.definition.parameters,
    ...(legacy.definition.verification ? { verification: legacy.definition.verification } : {}),
  })
  const now = Date.now()
  const [created] = await db.insert(drafts).values({
    id: `adraft_${crypto.randomUUID()}`, ownerId, sessionId: source.sessionId, legacyAppId: legacy.id,
    generationKey: `legacy-${legacy.id}`, definition: value, version: 1, contentHash: hash, timeCreated: now, timeUpdated: now,
  }).onConflictDoNothing().returning()
  if (created) return c.json(created, 201)
  const [accepted] = await db.select().from(drafts).where(and(eq(drafts.ownerId, ownerId), eq(drafts.legacyAppId, legacy.id)))
  if (accepted) return c.json(accepted)
  throw errors.conflict("迁移草稿已被并发修改，请刷新")
})

automationAppRoutes.post("/drafts", async (c) => {
  const input = parse(z.object({ sessionId: z.string().min(1), definition: z.unknown() }).strict(), await c.req.json().catch(() => null))
  await requireSession(c.get("userId"), input.sessionId, "run")
  const { value, hash } = draftDefinitionInput(input.definition)
  const now = Date.now()
  const [draft] = await db.insert(drafts).values({ id: `adraft_${crypto.randomUUID()}`, ownerId: c.get("userId"), sessionId: input.sessionId, definition: value, version: 1, contentHash: hash, timeCreated: now, timeUpdated: now }).returning()
  return c.json(draft, 201)
})

automationAppRoutes.post("/drafts/import", async (c) => {
  const input = parse(z.object({ sessionId: z.string().min(1), generationKey: z.string().min(1).max(100).optional() }).strict(), await c.req.json().catch(() => null))
  await requireSession(c.get("userId"), input.sessionId, "run")
  const existing = input.generationKey && await db.select().from(drafts).where(and(eq(drafts.ownerId, c.get("userId")), eq(drafts.sessionId, input.sessionId), eq(drafts.generationKey, input.generationKey)))
  if (existing?.[0]) return c.json(existing[0])
  const response = await saasFetch(`/api/session/${encodeURIComponent(input.sessionId)}/fs/read/.automation/draft.json`)
  if (!response.ok || !response.body) throw errors.notFound("automation_draft_file")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 256 * 1024) throw errors.invalid("草稿文件不能超过 256 KiB")
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  let raw: unknown
  try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { throw errors.invalid("草稿文件不是有效 JSON") }
  const { value, hash } = draftDefinitionInput(raw)
  const now = Date.now()
  const [draft] = await db.insert(drafts).values({ id: `adraft_${crypto.randomUUID()}`, ownerId: c.get("userId"), sessionId: input.sessionId, generationKey: input.generationKey ?? null, definition: value, version: 1, contentHash: hash, timeCreated: now, timeUpdated: now }).onConflictDoNothing().returning()
  if (!draft && input.generationKey) {
    const [accepted] = await db.select().from(drafts).where(and(eq(drafts.ownerId, c.get("userId")), eq(drafts.sessionId, input.sessionId), eq(drafts.generationKey, input.generationKey)))
    if (accepted) return c.json(accepted)
  }
  if (!draft) throw errors.conflict("草稿导入冲突，请重试")
  return c.json(draft, 201)
})

automationAppRoutes.get("/drafts", async (c) => {
  const sessionId = parse(z.string().min(1), c.req.query("sessionId"))
  await requireSession(c.get("userId"), sessionId, "read")
  const items = await db.select().from(drafts)
    .where(and(eq(drafts.ownerId, c.get("userId")), eq(drafts.sessionId, sessionId)))
    .orderBy(desc(drafts.timeUpdated)).limit(50)
  return c.json({ items })
})

automationAppRoutes.get("/drafts/:draftId", async (c) => {
  const draft = await ownedDraft(c.get("userId"), c.req.param("draftId"))
  await requireSession(c.get("userId"), draft.sessionId, "read")
  return c.json(draft)
})

automationAppRoutes.put("/drafts/:draftId", async (c) => {
  const input = parse(z.object({ version: z.number().int().positive(), definition: z.unknown() }).strict(), await c.req.json().catch(() => null))
  const draft = await ownedDraft(c.get("userId"), c.req.param("draftId"))
  await requireSession(c.get("userId"), draft.sessionId, "run")
  if (draft.publishedAppId) throw errors.conflict("草稿已发布，不能修改")
  const { value, hash } = draftDefinitionInput(input.definition)
  const [updated] = await db.update(drafts).set({ definition: value, contentHash: hash, version: draft.version + 1, timeUpdated: Date.now() })
    .where(and(eq(drafts.id, draft.id), eq(drafts.ownerId, c.get("userId")), eq(drafts.version, input.version), isNull(drafts.publishedAppId))).returning()
  if (!updated) throw errors.conflict("草稿版本已变化，请刷新后重试")
  return c.json(updated)
})

automationAppRoutes.post("/drafts/:draftId/runs", async (c) => {
  const input = parse(z.object({ version: z.number().int().positive(), requestKey: z.string().uuid(), parameters: z.record(z.string(), z.string().max(8000)) }).strict(), await c.req.json().catch(() => null))
  const draft = await ownedDraft(c.get("userId"), c.req.param("draftId"))
  await requireSession(c.get("userId"), draft.sessionId, "run")
  if (draft.publishedAppId || draft.version !== input.version) throw errors.conflict("草稿已发布或版本已变化")
  const values = parameters(draft.definition, input.parameters)
  for (const step of draft.definition.steps) resolveOperation(step.operation, values)
  const matches = (run: typeof runs.$inferSelect) => run.draftId === draft.id && run.appVersion === input.version && run.draftHash === draft.contentHash && Object.keys(values).length === Object.keys(run.parameters).length && Object.keys(values).every((key) => values[key] === run.parameters[key])
  const [previous] = await db.select().from(runs).where(and(eq(runs.ownerId, c.get("userId")), eq(runs.requestKey, input.requestKey)))
  if (previous) {
    if (!matches(previous)) throw errors.conflict("重复请求的内容不一致")
    return c.json(previous)
  }
  const now = Date.now()
  const [run] = await db.insert(runs).values({ id: `arun_${crypto.randomUUID()}`, appId: null, draftId: draft.id, draftHash: draft.contentHash, ownerId: c.get("userId"), sessionId: draft.sessionId, requestKey: input.requestKey, appVersion: draft.version, definition: draft.definition, parameters: values, status: "queued", timeCreated: now, timeUpdated: now }).onConflictDoNothing().returning()
  if (run) return c.json(run, 201)
  const [accepted] = await db.select().from(runs).where(and(eq(runs.ownerId, c.get("userId")), eq(runs.requestKey, input.requestKey)))
  if (accepted && matches(accepted)) return c.json(accepted)
  throw errors.conflict("该会话已有运行，或此请求的内容不一致")
})

automationAppRoutes.get("/drafts/:draftId/runs", async (c) => {
  const draft = await ownedDraft(c.get("userId"), c.req.param("draftId"))
  await requireSession(c.get("userId"), draft.sessionId, "read")
  const items = await db.select().from(runs).where(and(eq(runs.draftId, draft.id), eq(runs.ownerId, c.get("userId")))).orderBy(desc(runs.timeCreated)).limit(50)
  return c.json({ items })
})

/**
 * 沉淀应用（供 AI 在对话中调用，也可手动调用）。
 * 平台自己走完整流程：定位/导入草稿 → 草稿测试（脚本需确认时返回 needsConfirmation）→ 门槛校验 → 发布。
 * AI 只负责「请求沉淀」，不能跳过测试与门槛；不满足条件时返回具体原因而不是假装成功。
 */
automationAppRoutes.post("/:sessionId/distill", async (c) => {
  const input = parse(
    z.object({ draftId: z.string().min(1).optional(), confirm: z.boolean().optional() }).strict(),
    (await c.req.json().catch(() => ({}))) ?? {},
  )
  const userId = c.get("userId")
  const sessionId = c.req.param("sessionId")
  await requireSession(userId, sessionId, "run")

  // 1. 选草稿：显式指定 > 本会话最新未发布草稿 > 沙箱里的应用请求标记自动导入。
  let draft: typeof drafts.$inferSelect | undefined
  if (input.draftId) {
    const [found] = await db.select().from(drafts).where(and(eq(drafts.id, input.draftId), eq(drafts.ownerId, userId)))
    if (!found || found.sessionId !== sessionId) throw errors.notFound("automation_draft")
    draft = found
  } else {
    const [latest] = await db
      .select()
      .from(drafts)
      .where(and(eq(drafts.ownerId, userId), eq(drafts.sessionId, sessionId), isNull(drafts.publishedAppId)))
      .orderBy(desc(drafts.timeUpdated))
      .limit(1)
    draft = latest
  }
  if (!draft) {
    const [latestAny] = await db
      .select()
      .from(drafts)
      .where(and(eq(drafts.ownerId, userId), eq(drafts.sessionId, sessionId)))
      .orderBy(desc(drafts.timeUpdated))
      .limit(1)
    if (latestAny?.publishedAppId) return c.json({ status: "already_published", appId: latestAny.publishedAppId })
    throw errors.conflict("本次会话还没有可发布的草稿；请先让 AI 生成固定草稿并完成真实执行验证。")
  }
  if (draft.publishedAppId) return c.json({ status: "already_published", appId: draft.publishedAppId })

  // 2. 已有可用测试运行就直接发布。
  const existing = await findPublishableRun(userId, draft)
  if (existing) {
    const app = await publishDraft({ ownerId: userId, draftId: draft.id, version: draft.version, runId: existing.id })
    return c.json({ status: "published", appId: app.id, runId: existing.id, reusedRun: true })
  }

  // 3. 没有测试记录：由平台发起一次草稿测试，把结果交回调用方继续推进。
  const active = await db
    .select()
    .from(runs)
    .where(and(eq(runs.ownerId, userId), eq(runs.draftId, draft.id)))
    .orderBy(desc(runs.timeCreated))
    .limit(1)
  const running = active[0]
  if (running && ["queued", "running", "repairing"].includes(running.status))
    return c.json({ status: "testing", draftId: draft.id, runId: running.id, version: draft.version })

  // 按应用定义的默认值测试（parameters() 是校验函数，返回键集合，不能当参数值用）。
  const values = Object.fromEntries(draft.definition.parameters.map((p) => [p.key, p.defaultValue]))
  for (const step of draft.definition.steps) resolveOperation(step.operation, values)
  const now = Date.now()
  const [run] = await db
    .insert(runs)
    .values({
      id: `arun_${crypto.randomUUID()}`,
      appId: null,
      draftId: draft.id,
      draftHash: draft.contentHash,
      ownerId: userId,
      sessionId: draft.sessionId,
      requestKey: crypto.randomUUID(),
      appVersion: draft.version,
      definition: draft.definition,
      parameters: values,
      status: "queued",
      timeCreated: now,
      timeUpdated: now,
    })
    .returning()
  await writeAudit(
    { actorId: userId, action: "automation.distill.request", resourceType: "automation_draft", resourceId: draft.id, metadata: { runId: run!.id } },
    c,
  )
  return c.json({ status: "testing", draftId: draft.id, version: draft.version, runId: run!.id }, 202)
})

automationAppRoutes.post("/drafts/:draftId/apply-repair", async (c) => {
  const input = parse(z.object({ version: z.number().int().positive(), runId: z.string().min(1) }).strict(), await c.req.json().catch(() => null))
  const draft = await ownedDraft(c.get("userId"), c.req.param("draftId"))
  await requireSession(c.get("userId"), draft.sessionId, "run")
  if (draft.publishedAppId || draft.version !== input.version) throw errors.conflict("草稿已发布或版本已变化")
  const [run] = await db.select().from(runs).where(and(eq(runs.id, input.runId), eq(runs.ownerId, c.get("userId")), eq(runs.draftId, draft.id)))
  if (!run || run.status !== "succeeded" || run.appVersion !== draft.version || run.draftHash !== draft.contentHash) throw errors.conflict("修复不属于当前版本的成功测试")
  const repairs = run.results.filter((item) => item.status === "succeeded" && item.repairedOperation && !item.skipped)
  if (!repairs.length) throw errors.conflict("没有可应用的修复")
  const { value, hash } = draftDefinitionInput({
    ...draft.definition,
    steps: draft.definition.steps.map((step) => {
      const repaired = repairs.find((item) => item.stepId === step.id)
      return repaired ? { ...step, operation: repaired.repairedOperation } : step
    }),
  })
  const [updated] = await db.update(drafts).set({ definition: value, contentHash: hash, version: draft.version + 1, timeUpdated: Date.now() })
    .where(and(eq(drafts.id, draft.id), eq(drafts.ownerId, c.get("userId")), eq(drafts.version, input.version), isNull(drafts.publishedAppId))).returning()
  if (!updated) throw errors.conflict("草稿版本已变化")
  return c.json(updated)
})

automationAppRoutes.post("/drafts/:draftId/publish", async (c) => {
  const input = parse(z.object({ version: z.number().int().positive(), runId: z.string().min(1) }).strict(), await c.req.json().catch(() => null))
  const draft = await ownedDraft(c.get("userId"), c.req.param("draftId"))
  await requireSession(c.get("userId"), draft.sessionId, "run")
  const app = await publishDraft({
    ownerId: c.get("userId"),
    draftId: draft.id,
    version: input.version,
    runId: input.runId,
  })
  return c.json(app, 201)
})

automationAppRoutes.post("/", async (c) => {
  const value = definition(await c.req.json().catch(() => null))
  for (const step of value.steps) {
    if (step.operation.type === "script" || !step.operation.value?.includes("{{")) resolveOperation(step.operation, {})
  }
  const now = Date.now()
  const [app] = await db
    .insert(apps)
    .values({
      id: `auto_${crypto.randomUUID()}`,
      ownerId: c.get("userId"),
      definition: value,
      version: 1,
      timeCreated: now,
      timeUpdated: now,
    })
    .returning()
  await writeAudit(
    { actorId: c.get("userId"), action: "automation.create", resourceType: "automation", resourceId: app!.id },
    c,
  )
  return c.json(app, 201)
})

automationAppRoutes.get("/runs/:runId", async (c) => c.json(await ownedRun(c.get("userId"), c.req.param("runId"))))

automationAppRoutes.post("/runs/:runId/resume", async (c) => {
  const input = parse(
    z.object({ action: z.enum(["confirm", "retry", "skip", "stop"]) }).strict(),
    await c.req.json().catch(() => null),
  )
  const run = await ownedRun(c.get("userId"), c.req.param("runId"))
  await requireSession(c.get("userId"), run.sessionId, "run")
  if (run.status !== "paused") throw errors.conflict("运行当前没有暂停")
  const results = [...run.results]
  const current = results[run.cursor]
  if (!current) throw errors.conflict("没有可继续的步骤")
  results[run.cursor] =
    input.action === "skip"
      ? { ...current, status: "succeeded", skipped: true, approved: false, output: "用户核实已完成，跳过重放" }
      : {
          ...current,
          status: "paused",
          approved: input.action === "confirm",
          error: input.action === "confirm" ? "用户已确认执行" : "用户要求重试",
        }
  const [updated] = await db
    .update(runs)
    .set({
      results,
      cursor: run.cursor + (input.action === "skip" ? 1 : 0),
      status: input.action === "stop" ? "failed" : "queued",
      error: input.action === "stop" ? "用户结束运行" : null,
      timeUpdated: Date.now(),
    })
    .where(and(eq(runs.id, run.id), eq(runs.status, "paused"), eq(runs.timeUpdated, run.timeUpdated)))
    .returning()
  if (!updated) throw errors.conflict("运行状态已变化，请刷新")
  await writeAudit(
    {
      actorId: c.get("userId"),
      action: `automation.run.${input.action}`,
      resourceType: "automation_run",
      resourceId: run.id,
    },
    c,
  )
  return c.json(updated)
})

automationAppRoutes.post("/runs/:runId/apply-repair", async (c) => {
  const run = await ownedRun(c.get("userId"), c.req.param("runId"))
  await requireSession(c.get("userId"), run.sessionId, "run")
  // 手动入口与自动保存共用同一门槛：只固化真正重跑成功的修复，跳过步骤不保存。
  await applyVerifiedRepairOrThrow(run)
  return c.json({ applied: true })
})

automationAppRoutes.post("/runs/:runId/repair", async (c) => {
  const run = await ownedRun(c.get("userId"), c.req.param("runId"))
  await requireSession(c.get("userId"), run.sessionId, "run")
  const current = run.results[run.cursor],
    step = run.definition.steps[run.cursor]
  if (run.status !== "paused" || !current || !step || step.operation.type !== "script" || !current.error)
    throw errors.conflict("当前没有可修复的数据处理步骤")
  if (current.repairAttempts >= 2) throw errors.conflict("已达到修复次数上限，请手动检查")
  const results = [...run.results]
  results[run.cursor] = {
    ...current,
    approved: false,
    repairAttempts: current.repairAttempts + 1,
    pauseReason: "repair_running",
  }
  // AI 修复可能持续数分钟，超过网关超时；这里只登记任务，由 worker 生成方案后转回待审核。
  const [claimed] = await db
    .update(runs)
    .set({ status: "repairing", results, error: "正在生成此步骤的修复方案", timeUpdated: Date.now() })
    .where(and(eq(runs.id, run.id), eq(runs.status, "paused"), eq(runs.timeUpdated, run.timeUpdated)))
    .returning()
  if (!claimed) throw errors.conflict("运行状态已变化，请刷新")
  await writeAudit(
    { actorId: c.get("userId"), action: "automation.run.repair", resourceType: "automation_run", resourceId: run.id },
    c,
  )
  return c.json(claimed, 202)
})

automationAppRoutes.get("/:id", async (c) => {
  const app = await ownedApp(c.get("userId"), c.req.param("id"))
  const history = await db
    .select()
    .from(runs)
    .where(and(eq(runs.appId, app.id), eq(runs.ownerId, c.get("userId"))))
    .orderBy(desc(runs.timeCreated))
    .limit(50)
  return c.json({ app, runs: history })
})

automationAppRoutes.post("/:id/runs", async (c) => {
  const input = parse(
    z
      .object({
        sessionId: z.string().min(1),
        requestKey: z.string().uuid(),
        parameters: z.record(z.string(), z.string().max(8000)),
        confirmed: z.boolean().optional(),
      })
      .strict(),
    await c.req.json().catch(() => null),
  )
  const app = await ownedApp(c.get("userId"), c.req.param("id"))
  await requireSession(c.get("userId"), input.sessionId, "run")
  const values = parameters(app.definition, input.parameters)
  for (const step of app.definition.steps) resolveOperation(step.operation, values)
  // 已发布、已测试的固定脚本可在发起时一次性确认；草稿测试与网页点击仍逐步确认。
  const approvedScripts = input.confirmed === true ? app.definition.steps.map((step) => ({
    stepId: step.id,
    status: "paused" as const,
    repairAttempts: 0,
    approved: step.operation.type === "script",
  })) : []
  const [previous] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.ownerId, c.get("userId")), eq(runs.requestKey, input.requestKey)))
  if (previous) {
    if (
      previous.appId !== app.id ||
      previous.sessionId !== input.sessionId ||
      Object.keys(values).some((key) => values[key] !== previous.parameters[key]) ||
      Object.keys(values).length !== Object.keys(previous.parameters).length
    )
      throw errors.conflict("重复请求的内容不一致")
    return c.json(previous)
  }
  const now = Date.now()
  const [run] = await db
    .insert(runs)
    .values({
      id: `arun_${crypto.randomUUID()}`,
      appId: app.id,
      ownerId: c.get("userId"),
      sessionId: input.sessionId,
      requestKey: input.requestKey,
      appVersion: app.version,
      definition: app.definition,
      parameters: values,
      results: approvedScripts,
      status: "queued",
      timeCreated: now,
      timeUpdated: now,
    })
    .onConflictDoNothing()
    .returning()
  if (!run) {
    const [accepted] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.ownerId, c.get("userId")), eq(runs.requestKey, input.requestKey)))
    if (
      accepted &&
      accepted.appId === app.id &&
      accepted.sessionId === input.sessionId &&
      Object.keys(values).length === Object.keys(accepted.parameters).length &&
      Object.keys(values).every((key) => values[key] === accepted.parameters[key])
    )
      return c.json(accepted)
    throw errors.conflict("该会话已有运行，或此请求的内容不一致，请刷新运行记录")
  }
  await writeAudit(
    { actorId: c.get("userId"), action: "automation.run.create", resourceType: "automation_run", resourceId: run.id },
    c,
  )
  return c.json(run, 201)
})
