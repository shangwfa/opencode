/**
 * /gw-api/webhook/publish/callback：发布审批回调（原 webhook.controller 语义）。
 * _status=approved → 更新 publishList 项的 approval/step(env) → 全量写回 app 配置（PG）。
 */
import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { appService, NotFoundError } from "../apps/service.js"
import { db, publishes } from "../../db/index.js"
import { logger } from "../../logger.js"

export const webhookApp = new Hono()

webhookApp.post("/publish/callback", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { _status?: string; _param?: { appId?: string; id?: string; env?: string } }
    | null
  if (!body) return c.json({ success: false, message: "Invalid body" }, 400)

  if (body._status !== "approved") {
    // 原实现：非 approved 不做处理，与成功路径统一返回 'success'
    return c.text("success")
  }

  const { appId, id, env } = body._param ?? {}
  if (!appId || !id) return c.json({ success: false, message: "缺少 appId 或 version 参数" }, 400)

  const app = await appService.getAppByAppId(appId)
  if (!app) return c.json({ success: false, message: "应用不存在" }, 400)

  const publishList = Array.isArray(app.publishList) ? [...(app.publishList as Record<string, unknown>[])] : []
  const index = publishList.findIndex((item) => item.id === id)
  if (index === -1) return c.json({ success: false, message: `未找到发布记录 ${id}` }, 400)

  publishList[index] = { ...publishList[index], approval: "approved", step: env ?? "" }

  try {
    await appService.updateAppConfig(appId, "full", { ...app, publishList })
  } catch (error) {
    if (error instanceof NotFoundError) return c.json({ success: false, message: error.message }, 404)
    throw error
  }

  // 发布流水同步状态
  await db
    .update(publishes)
    .set({ status: "approved", detail: { step: env ?? "" }, updatedAt: new Date() })
    .where(eq(publishes.id, id))

  logger.info({ span: "webhook:publish-callback", msg: `审批回调完成: ${appId} ${id} ${body._status}` })
  return c.text("success")
})
