/** 数据面只信任基础服务；浏览器身份与资源授权不在此重复实现。 */
import { timingSafeEqual } from "node:crypto"
import { createMiddleware } from "hono/factory"
import { getKnowledgeServiceToken } from "../config/env.js"

export const requireKnowledgeService = createMiddleware(async (c, next) => {
  const expected = getKnowledgeServiceToken()
  if (!expected) return c.json({ code: 503, success: false, message: "未配置知识服务通信凭据", data: null }, 503)
  const actual = c.req.header("x-knowledge-service-token") ?? ""
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ code: 401, success: false, message: "需要基础服务授权", data: null }, 401)
  }
  await next()
})
