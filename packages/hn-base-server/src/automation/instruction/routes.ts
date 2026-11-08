import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { check } from "../../authz/index.js"
import { db } from "../../db/index.js"
import { errors } from "../../lib/errors.js"
import { writeAudit } from "../../lib/audit.js"
import { requireAuth, type AppEnv } from "../../middleware/auth.js"
import { sessionHistory } from "../shared/session-history.js"
import { saasFetch } from "../../lib/saas.js"
import { generateInstructionDefinition } from "./draft.js"
import * as service from "./service.js"

export const instructionRoutes = new Hono<AppEnv>()
instructionRoutes.use("*", requireAuth, bodyLimit({ maxSize: 256 * 1024 }))

function parse<T>(schema: z.ZodType<T>, input: unknown) {
  const result = schema.safeParse(input)
  if (!result.success) throw errors.invalid(result.error.issues[0]?.message ?? "参数格式错误")
  return result.data
}

async function requireSession(userId: string, id: string, permission: "read" | "run") {
  const permitted = await check(db, {
    subject: { type: "user", id: userId },
    permission,
    object: { type: "session", id },
  })
  if (!permitted) throw errors.notFound("session")
}

const runInput = z.object({
  requestKey: z.string().uuid(),
  parameters: z.record(z.string(), z.string().max(8000)),
  confirmed: z.boolean().optional(),
}).strict()
const versioned = z.object({
  version: z.number().int().positive(),
  requestKey: z.string().uuid(),
  parameters: z.record(z.string(), z.string().max(8000)),
  confirmed: z.boolean().optional(),
}).strict()

/** 依据会话记录生成指令草稿；生成后保存，用户可审阅和执行。 */
instructionRoutes.post("/drafts/generate", async (c) => {
  const input = parse(z.object({ sessionId: z.string().min(1), generationKey: z.string().min(1).max(100).optional() }).strict(), await c.req.json().catch(() => null))
  await requireSession(c.get("userId"), input.sessionId, "run")
  const existing = input.generationKey && await service.findGeneratedDraft(c.get("userId"), input.sessionId, input.generationKey)
  if (existing) return c.json({ definition: existing.definition, draft: existing })
  const { history, model } = await sessionHistory(input.sessionId)
  const definition = await generateInstructionDefinition(history, model)
  const draft = await service.createDraft(c.get("userId"), input.sessionId, definition, input.generationKey)
  await writeAudit({ actorId: c.get("userId"), action: "instruction.draft.generate", resourceType: "instruction_draft", resourceId: draft.id }, c)
  return c.json({ definition: draft.definition, draft }, 201)
})

instructionRoutes.get("/drafts", async (c) => {
  const sessionId = parse(z.string().min(1), c.req.query("sessionId"))
  await requireSession(c.get("userId"), sessionId, "read")
  return c.json({ items: await service.listDrafts(c.get("userId"), sessionId) })
})

instructionRoutes.get("/drafts/:id", async (c) => {
  const draft = await service.getDraft(c.get("userId"), c.req.param("id"))
  await requireSession(c.get("userId"), draft.sessionId, "read")
  return c.json(draft)
})

instructionRoutes.put("/drafts/:id", async (c) => {
  const input = parse(z.object({ version: z.number().int().positive(), definition: z.unknown() }).strict(), await c.req.json().catch(() => null))
  const draft = await service.getDraft(c.get("userId"), c.req.param("id"))
  await requireSession(c.get("userId"), draft.sessionId, "run")
  return c.json(await service.updateDraft(c.get("userId"), draft.id, input.version, input.definition))
})

instructionRoutes.post("/drafts/:id/runs", async (c) => {
  const input = parse(versioned, await c.req.json().catch(() => null))
  const draft = await service.getDraft(c.get("userId"), c.req.param("id"))
  await requireSession(c.get("userId"), draft.sessionId, "run")
  const run = await service.createDraftRun(c.get("userId"), draft, input)
  await writeAudit({ actorId: c.get("userId"), action: "instruction.run.start", resourceType: "instruction_run", resourceId: run.id }, c)
  return c.json(run, 201)
})

instructionRoutes.get("/drafts/:id/runs", async (c) => {
  const draft = await service.getDraft(c.get("userId"), c.req.param("id"))
  await requireSession(c.get("userId"), draft.sessionId, "read")
  return c.json({ items: await service.listDraftRuns(c.get("userId"), draft.id) })
})

instructionRoutes.post("/drafts/:id/publish", async (c) => {
  const input = parse(z.object({ version: z.number().int().positive(), runId: z.string().min(1) }).strict(), await c.req.json().catch(() => null))
  const draft = await service.getDraft(c.get("userId"), c.req.param("id"))
  await requireSession(c.get("userId"), draft.sessionId, "run")
  const app = await service.publishDraft(c.get("userId"), draft.id, input.version, input.runId)
  await writeAudit({ actorId: c.get("userId"), action: "instruction.app.create", resourceType: "instruction_app", resourceId: app.id }, c)
  return c.json(app, 201)
})

instructionRoutes.get("/apps", async (c) => c.json({ items: await service.listApps(c.get("userId")) }))

instructionRoutes.get("/apps/:id", async (c) => {
  const app = await service.getApp(c.get("userId"), c.req.param("id"))
  return c.json(app)
})

instructionRoutes.get("/apps/:id/runs", async (c) => {
  const app = await service.getApp(c.get("userId"), c.req.param("id"))
  const items = await service.listAppRuns(c.get("userId"), app.id)
  const visible = await Promise.all(items.map(async (run) => (await check(db, { subject: { type: "user", id: c.get("userId") }, permission: "read", object: { type: "session", id: run.sessionId } })) ? run : null))
  return c.json({ items: visible.filter((run) => run !== null) })
})

instructionRoutes.post("/apps/:id/runs", async (c) => {
  const input = parse(runInput.extend({ sessionId: z.string().min(1) }).strict(), await c.req.json().catch(() => null))
  const app = await service.getApp(c.get("userId"), c.req.param("id"))
  await requireSession(c.get("userId"), input.sessionId, "run")
  const run = await service.createAppRun(c.get("userId"), app, input)
  await writeAudit({ actorId: c.get("userId"), action: "instruction.run.start", resourceType: "instruction_run", resourceId: run.id }, c)
  return c.json(run, 201)
})

instructionRoutes.get("/runs/:id", async (c) => {
  const run = await service.getRun(c.get("userId"), c.req.param("id"))
  await requireSession(c.get("userId"), run.sessionId, "read")
  return c.json(run)
})

/**
 * 本次运行的消息（只含该运行的 promptMessageID）。
 * 应用详情页据此在页面内展示执行过程，不必跳到会话。
 */
instructionRoutes.get("/runs/:id/messages", async (c) => {
  const run = await service.getRun(c.get("userId"), c.req.param("id"))
  await requireSession(c.get("userId"), run.sessionId, "read")
  // 逐步执行：一次运行有多个 promptId，按步骤归属过滤。
  const promptIds = new Set(run.steps.map((step) => step.promptId).filter((id): id is string => !!id))
  if (run.promptId) promptIds.add(run.promptId)
  if (!promptIds.size) return c.json({ data: [] })
  const res = await saasFetch(
    `/api/session/${encodeURIComponent(run.sessionId)}/message?order=asc&limit=200`,
  )
  if (!res.ok) throw errors.upstream(502, `读取执行过程失败（${res.status}）`)
  const body = (await res.json().catch(() => ({ data: [] }))) as { data?: Array<{ promptMessageID?: string }> }
  return c.json({ data: (body.data ?? []).filter((item) => item.promptMessageID && promptIds.has(item.promptMessageID)) })
})

instructionRoutes.post("/runs/:id/resume", async (c) => {
  const input = parse(z.object({ action: z.enum(["retry", "stop"]) }).strict(), await c.req.json().catch(() => null))
  const run = await service.getRun(c.get("userId"), c.req.param("id"))
  await requireSession(c.get("userId"), run.sessionId, "run")
  const updated = await service.resumeRun(c.get("userId"), run.id, input.action)
  await writeAudit({ actorId: c.get("userId"), action: `instruction.run.${input.action}`, resourceType: "instruction_run", resourceId: run.id }, c)
  return c.json(updated)
})
