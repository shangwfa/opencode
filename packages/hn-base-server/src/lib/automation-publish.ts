import { and, desc, eq } from "drizzle-orm"
import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { db } from "../db/index.js"
import { automationApp as apps, automationDraft as drafts, automationRun as runs } from "../db/schema.js"
import { definition } from "./automation-app.js"
import { errors } from "./errors.js"
import { writeAudit } from "./audit.js"

/**
 * 发布门槛（唯一实现）：草稿必须有一份「当前版本 + 完整成功 + 无跳过 + 无修复」的测试运行。
 * 手动发布、AI 请求沉淀都走这里，避免两套判断漂移。
 */
export function publishableRun(
  current: typeof drafts.$inferSelect,
  run: typeof runs.$inferSelect | undefined,
): boolean {
  return !!run &&
    run.status === "succeeded" &&
    run.appVersion === current.version &&
    run.draftHash === current.contentHash &&
    run.results.length === current.definition.steps.length &&
    run.results.every((item, index) =>
      item.stepId === current.definition.steps[index]?.id &&
      item.status === "succeeded" &&
      !item.skipped &&
      !item.repairedOperation,
    )
}

/** 找出该草稿当前版本可用的成功测试运行。 */
export async function findPublishableRun(ownerId: string, draft: typeof drafts.$inferSelect) {
  const items = await db
    .select()
    .from(runs)
    .where(and(eq(runs.ownerId, ownerId), eq(runs.draftId, draft.id)))
    .orderBy(desc(runs.timeCreated))
    .limit(20)
  return items.find((run) => publishableRun(draft, run))
}

/**
 * 发布草稿为应用；幂等（已发布直接返回既有应用）。
 * 调用方需已校验会话权限；这里只保证门槛与事务一致性。
 */
export async function publishDraft(input: {
  ownerId: string
  draftId: string
  version: number
  runId: string
}): Promise<A.App> {
  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, input.draftId), eq(drafts.ownerId, input.ownerId)))
      .for("update")
    if (!current) throw errors.notFound("automation_draft")
    if (current.version !== input.version) throw errors.conflict("草稿版本已变化")
    if (current.publishedAppId) {
      const [app] = await tx.select().from(apps).where(and(eq(apps.id, current.publishedAppId), eq(apps.ownerId, input.ownerId)))
      if (!app) throw errors.conflict("已发布的应用不存在")
      return app
    }
    const [run] = await tx
      .select()
      .from(runs)
      .where(and(eq(runs.id, input.runId), eq(runs.ownerId, input.ownerId), eq(runs.draftId, current.id)))
    if (!publishableRun(current, run))
      throw errors.conflict("请先完整测试当前草稿；修复或跳过步骤后需更新草稿并重新测试")
    const now = Date.now()
    const value = definition(current.definition)
    const [app] = await tx
      .insert(apps)
      .values({
        id: `auto_${crypto.randomUUID()}`,
        ownerId: current.ownerId,
        legacyAppId: current.legacyAppId,
        definition: value,
        version: 1,
        timeCreated: now,
        timeUpdated: now,
      })
      .returning()
    await tx.update(drafts).set({ publishedAppId: app!.id, timeUpdated: now }).where(eq(drafts.id, current.id))
    return app!
  })
  await writeAudit(
    {
      actorId: input.ownerId,
      action: "automation.create",
      resourceType: "automation",
      resourceId: result.id,
      metadata: { draftId: input.draftId, runId: input.runId },
    },
  )
  return result
}
