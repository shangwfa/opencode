/** 原帮助中心页面的兼容接口；所有请求先按知识库执行基础服务授权。 */
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { env } from "../config/env.js"
import { errors } from "../lib/errors.js"
import { assertKnowledgePermission, knowledgeFetch, knowledgeJson } from "../lib/knowledge.js"
import { requireAuth, requireSession, type AppEnv } from "../middleware/auth.js"
import { createUploadTicket, verifyUploadTicket } from "../lib/upload-ticket.js"

type Node = { id: string; name: string; menuTrees?: Node[] }
export const knowledgeLegacyRoutes = new Hono<AppEnv>()
knowledgeLegacyRoutes.use("*", bodyLimit({ maxSize: 3 * 1024 * 1024 }))
knowledgeLegacyRoutes.all("/:baseId/*", async (c) => {
  const id = c.req.param("baseId")
  const prefix = `/api/knowledge-legacy/${encodeURIComponent(id)}/`
  const path = c.req.path.slice(prefix.length)
  const method = c.req.method
  const origin = c.req.header("origin")
  if (origin && !env.trustedOrigins.includes(origin)) throw errors.forbidden()
  const query = new URLSearchParams(new URL(c.req.url).search)
  // 正文上传走短时效签名票据，浏览器跨端口 PUT 时不携带会话。
  const uploadKey = query.get("key") ?? ""
  const isUpload = method === "PUT" && path.startsWith("compat/oss/upload")
  const isRead = method === "GET" && path.startsWith("compat/oss/read/")
  if (isUpload) {
    if (!verifyUploadTicket(query.get("ticket"), id, uploadKey)) throw errors.unauthorized("上传票据无效或已过期")
  } else if (isRead) {
    // 读取地址本身是随机 capability key，按 key 直读，等价于 OSS 预签名读。
  } else {
    await requireSession(c)
  }
  if (!isUpload && !isRead) await assertKnowledgePermission(c.get("userId"), id, method === "GET" ? "read" : "write")
  c.header("cache-control", "no-store")
  const root = `/kb-admin/knowledge-bases/${encodeURIComponent(id)}`
  const body = method === "POST" ? await c.req.json().catch(() => null) : null
  const trees = await knowledgeJson<Node[]>(`${root}/menus/tree?includeDisabled=1`)
  const nodes = new Map<string, Node>()
  const visit = (items: Node[]) => { for (const node of items) { nodes.set(node.id, node); visit(node.menuTrees ?? []) } }
  visit(trees)
  for (const key of ["id", "menuId", "parentId", "previousId", "targetParentId", "targetPreviousId"]) {
    const value = body?.[key] ?? query.get(key)
    if (value && value !== "0" && value !== id && !nodes.has(String(value))) throw errors.notFound()
  }
  const ok = (data: unknown) => c.json({ code: 200, success: true, message: "ok", data })
  // 正文上传：浏览器 PUT 到基础服务，再由基础服务带服务凭据转发到知识服务。
  if (method === "PUT" && path.startsWith("compat/oss/upload")) {
    const response = await knowledgeFetch(`/compat/oss/upload${new URL(c.req.url).search}`, {
      method: "PUT",
      headers: { "content-type": c.req.header("content-type") ?? "application/octet-stream" },
      body: await c.req.arrayBuffer(),
    })
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
  }
  if (method === "GET" && path.startsWith("compat/oss/read/")) {
    const key = path.slice("compat/oss/read/".length)
    const response = await knowledgeFetch(`/compat/oss/read/${encodeURIComponent(key)}`)
    return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } })
  }
  if (method === "POST" && path === "boss/helpdoc/oss/getUploadUrl") {
    const data = await knowledgeJson<{ key: string; uploadUrl: string; readUrl: string }>("/compat/boss/helpdoc/oss/getUploadUrl", { method: "POST", body: JSON.stringify(body ?? {}) })
    // 上传地址必须回到基础服务，浏览器不能直连知识服务；票据让跨端口 PUT 无需会话。
    const publicBase = env.publicBaseUrl.replace(/\/+$/, "")
    const uploadQuery = new URL(data.uploadUrl).search
    return ok({
      key: data.key,
      uploadUrl: `${publicBase}/api/knowledge-legacy/${encodeURIComponent(id)}/compat/oss/upload${uploadQuery}&ticket=${encodeURIComponent(createUploadTicket(id, data.key))}`,
      readUrl: `${publicBase}/api/knowledge-legacy/${encodeURIComponent(id)}/compat/oss/read/${encodeURIComponent(data.key)}`,
    })
  }
  if (method === "GET" && path === "boss/helpdoc/menu/queryById") {
    const menuId = query.get("id") ?? ""
    if (!nodes.has(menuId)) throw errors.notFound()
    const doc = await knowledgeJson<{ contentJson: unknown; draftContentJson: unknown; contentType: string }>(`${root}/documents/${encodeURIComponent(menuId)}`)
    return ok({ id: menuId, menuId, docUniqueId: menuId, name: nodes.get(menuId)!.name, content: doc.contentJson ? JSON.stringify(doc.contentJson) : "", contentType: doc.contentType, hasDraft: doc.draftContentJson != null })
  }
  if (method === "GET" && path === "boss/helpdoc/draft/queryByMenuId") {
    const menuId = query.get("menuId") ?? ""
    if (!nodes.has(menuId)) throw errors.notFound()
    const doc = await knowledgeJson<{ draftContentJson: unknown; contentType: string }>(`${root}/documents/${encodeURIComponent(menuId)}`)
    return ok({ content: doc.draftContentJson ? JSON.stringify(doc.draftContentJson) : "", contentType: doc.contentType })
  }
  const reads = ["yddoc/oss/domain", "yddoc/envConfig/queryByBrandCodeAndLanguageCode", "boss/helpdoc/menu/getAdminMenuTreeByBrandCode", "boss/helpdoc/envConfig/getDocEnvConfig", "boss/helpdoc/envConfig/queryAllDocEnvByBrandCode", "oem/query", "sys/sceneDataSource/listBySceneCode", "sys/fullIndex/helpDoc/tips", "sys/spm/record/log"]
  if (method === "POST" && path === "boss/helpdoc/menu/add") {
    if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.length > 200 || !["folder", "doc"].includes(body.type)) throw errors.invalid("文档参数不正确")
    return ok(await knowledgeJson(`${root}/menus`, { method: "POST", body: JSON.stringify({ name: body.name.trim(), type: body.type, parentId: body.parentId && body.parentId !== "0" ? body.parentId : null, previousId: body.previousId && body.previousId !== "0" ? body.previousId : null }) }))
  }
  if (method === "POST" && (path === "boss/helpdoc/draft/add" || path === "boss/helpdoc/draft/update")) {
    return ok(await knowledgeJson(`/compat/${path}`, { method: "POST", body: JSON.stringify(body ?? {}) }))
  }
  if (method === "POST" && path === "boss/helpdoc/menu/save") {
    return ok(await knowledgeJson(`/compat/${path}`, { method: "POST", body: JSON.stringify(body ?? {}) }))
  }
  if (method === "DELETE" && path === "boss/helpdoc/draft/deleteByMenuId") {
    return ok(await knowledgeJson(`/compat/${path}${new URL(c.req.url).search}`, { method: "DELETE" }))
  }
  if (method !== "GET" || !reads.includes(path)) throw errors.notFound()
  query.set("brandCode", id)
  query.set("id", id)
  return ok(await knowledgeJson(`/compat/${path}?${query}`))
})
