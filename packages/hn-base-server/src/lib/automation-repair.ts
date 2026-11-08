import { and, eq } from "drizzle-orm"
import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { db } from "../db/index.js"
import { automationApp as apps, automationRun as runs } from "../db/schema.js"
import { definition } from "./automation-app.js"
import { errors } from "./errors.js"
import { writeAudit } from "./audit.js"

/**
 * 把一次运行里"真正重跑成功"的修复固化为应用的新版本。
 * 跳过（skipped）或未完成的步骤不算验证成功，不保存——避免把没跑通的动作写进已发布应用。
 * 应用版本已变化时不覆盖，返回 false。
 */
export async function applyVerifiedRepair(run: typeof runs.$inferSelect): Promise<boolean> {
  if (!run.appId || run.status !== "succeeded" || run.repairApplied) return false
  if (run.results.length !== run.definition.steps.length || run.results.some((r) => r.status !== "succeeded" || r.skipped))
    return false
  const repairs = run.results.filter((r) => r.status === "succeeded" && r.repairedOperation && !r.skipped)
  if (!repairs.length) return false
  const [app] = await db.select().from(apps).where(and(eq(apps.id, run.appId), eq(apps.ownerId, run.ownerId)))
  if (!app || app.version !== run.appVersion) return false
  const value = definition({
    ...run.definition,
    steps: run.definition.steps.map((step) => {
      const result = repairs.find((r) => r.stepId === step.id)
      return result ? { ...step, operation: result.repairedOperation } : step
    }),
  })
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(apps)
      .set({ definition: value, version: app.version + 1, timeUpdated: Date.now() })
      .where(and(eq(apps.id, app.id), eq(apps.version, app.version)))
      .returning()
    if (!rows.length) return false
    await tx.update(runs).set({ repairApplied: true, timeUpdated: Date.now() }).where(eq(runs.id, run.id))
    return true
  })
  if (!updated) return false
  await writeAudit({ actorId: run.ownerId, action: "automation.apply_repair", resourceType: "automation", resourceId: app.id })
  return true
}

/** 手动入口用：不满足条件时抛出可读冲突，而不是静默跳过。 */
export async function applyVerifiedRepairOrThrow(run: typeof runs.$inferSelect): Promise<void> {
  if (run.status !== "succeeded" || run.repairApplied) throw errors.conflict("只能保存成功且尚未应用的修复")
  if (!run.appId) throw errors.conflict("草稿修复需先更新草稿并重新测试")
  const [app] = await db.select().from(apps).where(and(eq(apps.id, run.appId), eq(apps.ownerId, run.ownerId)))
  if (!app) throw errors.notFound("automation")
  if (app.version !== run.appVersion) throw errors.conflict("应用已有新版本，不能覆盖")
  if (run.results.length !== run.definition.steps.length || run.results.some((r) => r.status !== "succeeded" || r.skipped))
    throw errors.conflict("运行含跳过或未完成步骤，不能保存修复")
  if (!run.results.some((r) => r.status === "succeeded" && r.repairedOperation && !r.skipped))
    throw errors.conflict("没有已验证的修复")
  const applied = await applyVerifiedRepair(run)
  if (!applied) throw errors.conflict("应用版本已变化")
}
