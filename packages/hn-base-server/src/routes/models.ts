/**
 * 模型目录：SaaS 的 `/api/model` 只接受内网服务调用，浏览器经网关读取。
 * 直接透传 `{ data: Model.Info[] }`，前端按 providerID 分组。
 */
import { Hono } from "hono"
import { saasJson } from "../lib/saas.js"
import { errors } from "../lib/errors.js"
import { requireAuth } from "../middleware/auth.js"

export const modelRoutes = new Hono()

modelRoutes.get("/", requireAuth, async (c) => {
  try {
    return c.json(await saasJson<{ data: unknown[] }>(`/api/model`))
  } catch {
    throw errors.internal("读取模型目录失败")
  }
})
