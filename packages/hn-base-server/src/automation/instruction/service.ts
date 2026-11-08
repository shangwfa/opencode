import { and, desc, eq, isNull } from "drizzle-orm"
import { AutomationInstruction as I } from "@opencode/schema/automation-instruction"
import { db } from "../../db/index.js"
import {
  instructionApp as apps,
  instructionDraft as drafts,
  instructionRun as runs,
} from "../../db/schema.js"
import { errors } from "../../lib/errors.js"
import { contentHash, instructionDefinition, instructionParameters, requiresConfirmation, secretFinding } from "./contract.js"

/** 指令应用的持久化与状态迁移；不含 HTTP、权限和 AI 调用。 */

export async function findGeneratedDraft(ownerId: string, sessionId: string, key: string) {
  const [draft] = await db.select().from(drafts).where(and(eq(drafts.ownerId, ownerId), eq(drafts.sessionId, sessionId), eq(drafts.generationKey, key)))
  return draft
}

export async function createDraft(ownerId: string, sessionId: string, definition: I.Definition, generationKey?: string) {
  const now = Date.now()
  const [draft] = await db
    .insert(drafts)
    .values({
      id: `idraft_${crypto.randomUUID()}`,
      ownerId,
      sessionId,
      generationKey: generationKey ?? null,
      definition,
      version: 1,
      contentHash: contentHash(definition),
      timeCreated: now,
      timeUpdated: now,
    })
    .onConflictDoNothing()
    .returning()
  if (draft) return draft
  const existing = generationKey && await findGeneratedDraft(ownerId, sessionId, generationKey)
  if (!existing) throw errors.conflict("草稿生成冲突，请重试")
  return existing
}

export async function updateDraft(
  ownerId: string,
  id: string,
  version: number,
  input: unknown,
) {
  const [draft] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.ownerId, ownerId)))
  if (!draft) throw errors.notFound("instruction_draft")
  if (draft.publishedAppId) throw errors.conflict("草稿已发布，不能修改")
  const definition = instructionDefinition(input)
  const [updated] = await db
    .update(drafts)
    .set({
      definition,
      version: draft.version + 1,
      contentHash: contentHash(definition),
      timeUpdated: Date.now(),
    })
    .where(and(eq(drafts.id, draft.id), eq(drafts.ownerId, ownerId), eq(drafts.version, version), isNull(drafts.publishedAppId)))
    .returning()
  if (!updated) throw errors.conflict("草稿版本已变化，请刷新后重试")
  return updated
}

export async function getDraft(ownerId: string, id: string) {
  const [draft] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.ownerId, ownerId)))
  if (!draft) throw errors.notFound("instruction_draft")
  return draft
}

export async function listDrafts(ownerId: string, sessionId: string) {
  return db
    .select()
    .from(drafts)
    .where(and(eq(drafts.ownerId, ownerId), eq(drafts.sessionId, sessionId)))
    .orderBy(desc(drafts.timeUpdated))
    .limit(50)
}

export async function createDraftRun(
  ownerId: string,
  draft: typeof drafts.$inferSelect,
  input: { version: number; requestKey: string; parameters: Record<string, string>; confirmed?: boolean },
) {
  if (draft.publishedAppId) throw errors.conflict("草稿已发布")
  if (draft.version !== input.version) throw errors.conflict("草稿版本已变化")
  if (requiresConfirmation(draft.definition) && input.confirmed !== true)
    throw errors.invalid("包含需要确认的高风险指令，请确认后再运行")
  const values = instructionParameters(draft.definition, input.parameters)
  return insertRun({
    ownerId,
    appId: null,
    draftId: draft.id,
    draftHash: draft.contentHash,
    sessionId: draft.sessionId,
    requestKey: input.requestKey,
    appVersion: draft.version,
    definition: draft.definition,
    parameters: values,
  })
}

export async function listDraftRuns(ownerId: string, draftId: string) {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.ownerId, ownerId), eq(runs.draftId, draftId)))
    .orderBy(desc(runs.timeCreated))
    .limit(50)
}

export async function publishDraft(
  ownerId: string,
  draftId: string,
  version: number,
  runId: string,
) {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.ownerId, ownerId)))
      .for("update")
    if (!draft) throw errors.notFound("instruction_draft")
    if (draft.version !== version) throw errors.conflict("草稿版本已变化")
    const secret = secretFinding(draft.definition)
    if (secret) throw errors.invalid(`${secret}疑似包含凭据，请移除后再发布`)
    if (draft.publishedAppId) {
      const [existing] = await tx
        .select()
        .from(apps)
        .where(and(eq(apps.id, draft.publishedAppId), eq(apps.ownerId, ownerId)))
      if (!existing) throw errors.conflict("已发布的应用不存在")
      return existing
    }
    const [run] = await tx
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.ownerId, ownerId), eq(runs.draftId, draft.id)))
    if (
      !run ||
      run.status !== "succeeded" ||
      run.appVersion !== draft.version ||
      run.draftHash !== draft.contentHash ||
      run.regeneratedVersion !== null
    )
      throw errors.conflict("请先用当前草稿完整执行成功，再确认创建应用")
    const now = Date.now()
    const [app] = await tx
      .insert(apps)
      .values({
        id: `inst_${crypto.randomUUID()}`,
        ownerId,
        definition: draft.definition,
        version: 1,
        timeCreated: now,
        timeUpdated: now,
      })
      .returning()
    await tx.update(drafts).set({ publishedAppId: app!.id, timeUpdated: now }).where(eq(drafts.id, draft.id))
    return app!
  })
}

export async function listAppRuns(ownerId: string, appId: string) {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.ownerId, ownerId), eq(runs.appId, appId)))
    .orderBy(desc(runs.timeCreated))
    .limit(50)
}

export async function listApps(ownerId: string) {
  return db
    .select()
    .from(apps)
    .where(eq(apps.ownerId, ownerId))
    .orderBy(desc(apps.timeUpdated))
    .limit(200)
}

export async function getApp(ownerId: string, id: string) {
  const [app] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.id, id), eq(apps.ownerId, ownerId)))
  if (!app) throw errors.notFound("instruction_app")
  return app
}

export async function createAppRun(
  ownerId: string,
  app: typeof apps.$inferSelect,
  input: { sessionId: string; requestKey: string; parameters: Record<string, string>; confirmed?: boolean },
) {
  if (requiresConfirmation(app.definition) && input.confirmed !== true)
    throw errors.invalid("包含需要确认的高风险指令，请确认后再运行")
  const values = instructionParameters(app.definition, input.parameters)
  return insertRun({
    ownerId,
    appId: app.id,
    draftId: null,
    draftHash: null,
    sessionId: input.sessionId,
    requestKey: input.requestKey,
    appVersion: app.version,
    definition: app.definition,
    parameters: values,
  })
}

type NewRun = {
  ownerId: string
  appId: string | null
  draftId: string | null
  draftHash: string | null
  sessionId: string
  requestKey: string
  appVersion: number
  definition: I.Definition
  parameters: Record<string, string>
}

async function insertRun(input: NewRun) {
  const matches = (previous: typeof runs.$inferSelect) =>
    previous.appId === input.appId &&
    previous.draftId === input.draftId &&
    previous.draftHash === input.draftHash &&
    previous.sessionId === input.sessionId &&
    previous.appVersion === input.appVersion &&
    Object.keys(input.parameters).length === Object.keys(previous.parameters).length &&
    Object.keys(input.parameters).every((key) => input.parameters[key] === previous.parameters[key])
  const [previous] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.ownerId, input.ownerId), eq(runs.requestKey, input.requestKey)))
  if (previous) {
    if (!matches(previous)) throw errors.conflict("重复请求的内容不一致")
    return previous
  }
  const now = Date.now()
  const [run] = await db
    .insert(runs)
    .values({
      id: `irun_${crypto.randomUUID()}`,
      ownerId: input.ownerId,
      appId: input.appId,
      draftId: input.draftId,
      draftHash: input.draftHash,
      sessionId: input.sessionId,
      requestKey: input.requestKey,
      appVersion: input.appVersion,
      definition: input.definition,
      parameters: input.parameters,
      // 先写入步骤清单，界面立即可见进度；派发时再填 promptId。
      steps: input.definition.instructions.map((instruction, index) => ({
        index,
        title: instruction.title,
        promptId: null,
        status: "pending" as const,
        output: null,
      })),
      status: "queued",
      timeCreated: now,
      timeUpdated: now,
    })
    .onConflictDoNothing()
    .returning()
  if (run) return run
  const [accepted] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.ownerId, input.ownerId), eq(runs.requestKey, input.requestKey)))
  if (accepted && matches(accepted)) return accepted
  throw errors.conflict("该会话已有正在执行的应用，请稍后再试")
}

export async function getRun(ownerId: string, id: string) {
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.ownerId, ownerId)))
  if (!run) throw errors.notFound("instruction_run")
  return run
}

export async function resumeRun(ownerId: string, id: string, action: "retry" | "stop") {
  const run = await getRun(ownerId, id)
  if (run.status !== "paused") throw errors.conflict("运行当前没有暂停")
  if (action === "retry" && !run.promptId) throw errors.conflict("派发状态不确定，请核实后结束运行")
  const [updated] = await db
    .update(runs)
    .set({
      // 已派发的执行只恢复观察，绝不重新发送提示词，避免重复副作用。
      status: action === "stop" ? "failed" : "running",
      error: action === "stop" ? "用户结束运行" : null,
      timeUpdated: Date.now(),
    })
    .where(and(eq(runs.id, run.id), eq(runs.ownerId, ownerId), eq(runs.status, "paused"), eq(runs.timeUpdated, run.timeUpdated)))
    .returning()
  if (!updated) throw errors.conflict("运行状态已变化，请刷新")
  return updated
}
