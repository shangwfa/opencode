import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { and, desc, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "../db/index.js"
import { automationApp as apps, automationRun as runs } from "../db/schema.js"
import { requireAuth, type AppEnv } from "../middleware/auth.js"
import { errors } from "../lib/errors.js"
import { definition, parameters, resolveOperation } from "../lib/automation-app.js"
import { draftDefinition, repairScript } from "../lib/automation-ai.js"
import { saasFetch } from "../lib/saas.js"
import { check } from "../authz/index.js"
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

automationAppRoutes.post("/draft", async (c) => {
  const input = parse(z.object({ sessionId: z.string().min(1) }).strict(), await c.req.json().catch(() => null))
  await requireSession(c.get("userId"), input.sessionId, "read")
  const response = await saasFetch(`/api/session/${encodeURIComponent(input.sessionId)}/message?order=desc&limit=100`)
  if (!response.ok) throw errors.upstream(502, "无法读取探索记录")
  const session = await saasFetch(`/api/session/${encodeURIComponent(input.sessionId)}`)
  if (!session.ok) throw errors.upstream(502, "无法读取探索会话模型")
  const sessionBody = (await session.json()) as { data?: { model?: unknown } }
  const history = await response.json() as { data?: Array<{ type?: string; model?: unknown }> }
  const candidate = sessionBody.data?.model ?? history.data?.find((message) => message.type === "assistant" && message.model)?.model
  let model: Model.Ref | undefined
  try { if (candidate) model = Schema.decodeUnknownSync(Model.Ref)(candidate) } catch { /* 旧消息模型不可解码时使用服务默认模型 */ }
  return c.json({ definition: await draftDefinition(history, model) })
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
  if (run.status !== "succeeded" || run.repairApplied) throw errors.conflict("只能保存成功且尚未应用的修复")
  const app = await ownedApp(c.get("userId"), run.appId)
  if (app.version !== run.appVersion) throw errors.conflict("应用已有新版本，不能覆盖")
  const repairs = run.results.filter((r) => r.status === "succeeded" && r.repairedOperation && !r.skipped)
  if (!repairs.length) throw errors.conflict("没有已验证的修复")
  const value = definition({
    ...run.definition,
    steps: run.definition.steps.map((step) => {
      const result = repairs.find((r) => r.stepId === step.id)
      return result ? { ...step, operation: result.repairedOperation } : step
    }),
  })
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(apps)
      .set({ definition: value, version: app.version + 1, timeUpdated: Date.now() })
      .where(and(eq(apps.id, app.id), eq(apps.version, app.version)))
      .returning()
    if (!updated.length) throw errors.conflict("应用版本已变化")
    await tx.update(runs).set({ repairApplied: true, timeUpdated: Date.now() }).where(eq(runs.id, run.id))
  })
  await writeAudit(
    { actorId: c.get("userId"), action: "automation.apply_repair", resourceType: "automation", resourceId: app.id },
    c,
  )
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
      })
      .strict(),
    await c.req.json().catch(() => null),
  )
  const app = await ownedApp(c.get("userId"), c.req.param("id"))
  await requireSession(c.get("userId"), input.sessionId, "run")
  const values = parameters(app.definition, input.parameters)
  for (const step of app.definition.steps) resolveOperation(step.operation, values)
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
