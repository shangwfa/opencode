/**
 * 管理接口(/kb-admin):KB CRUD、菜单树、文档草稿/发布
 * 鉴权后置(决策 #4):当前 passthrough,预留中间件插槽
 */
import { Hono } from "hono"
import { KbService } from "../services/kb.service.js"
import { MenuService } from "../services/menu.service.js"
import { DocumentService } from "../services/document.service.js"
import { DocPlatformError } from "../types.js"

const kbService = new KbService()
const menuService = new MenuService()
const documentService = new DocumentService()

// 鉴权插槽(决策 #4):后续在此追加 token/身份校验中间件
// app.use("*", authMiddleware())

export const kbAdminApp = new Hono()

  // ── 知识库 CRUD ──
  .post("/knowledge-bases", async (c) => {
    const body = await c.req.json()
    const kb = await kbService.createKb({
      name: body.name,
      slug: body.slug,
      languageCode: body.languageCode,
      description: body.description,
      modes: body.modes,
      settings: body.settings,
      defaultChunkStrategy: body.defaultChunkStrategy,
      defaultChunkConfig: body.defaultChunkConfig,
    })
    return c.json({ code: 200, success: true, message: "ok", data: kb })
  })
  .get("/knowledge-bases", async (c) => {
    const list = await kbService.listKbs()
    return c.json({ code: 200, success: true, message: "ok", data: list })
  })
  .get("/knowledge-bases/:kbId", async (c) => {
    const kb = await kbService.getKb(c.req.param("kbId"))
    return c.json({ code: 200, success: true, message: "ok", data: kb })
  })
  .patch("/knowledge-bases/:kbId", async (c) => {
    const body = await c.req.json()
    const kb = await kbService.updateKb(c.req.param("kbId"), body)
    return c.json({ code: 200, success: true, message: "ok", data: kb })
  })
  .delete("/knowledge-bases/:kbId", async (c) => {
    await kbService.deleteKb(c.req.param("kbId"))
    return c.json({ code: 200, success: true, message: "ok", data: null })
  })
  .post("/knowledge-bases/:kbId/public", async (c) => {
    const body = await c.req.json()
    const kb = await kbService.updateKb(c.req.param("kbId"), { isPublic: !!body.isPublic })
    return c.json({ code: 200, success: true, message: "ok", data: kb })
  })

  // ── 菜单树 ──
  .post("/knowledge-bases/:kbId/menus", async (c) => {
    const body = await c.req.json()
    const menu = await menuService.createMenu(c.req.param("kbId"), {
      name: body.name,
      type: body.type,
      parentId: body.parentId ?? null,
      previousId: body.previousId ?? null,
      iconUrl: body.iconUrl ?? null,
      slug: body.slug ?? null,
    })
    return c.json({ code: 200, success: true, message: "ok", data: menu })
  })
  .get("/knowledge-bases/:kbId/menus/tree", async (c) => {
    const includeDisabled = c.req.query("includeDisabled") === "1"
    const tree = await menuService.getTree(c.req.param("kbId"), { includeDisabled })
    return c.json({ code: 200, success: true, message: "ok", data: tree })
  })
  .put("/knowledge-bases/:kbId/menus/:menuId", async (c) => {
    const body = await c.req.json()
    const menu = await menuService.updateMenu(c.req.param("kbId"), c.req.param("menuId"), body)
    return c.json({ code: 200, success: true, message: "ok", data: menu })
  })
  .post("/knowledge-bases/:kbId/menus/reorder", async (c) => {
    const body = await c.req.json()
    const menu = await menuService.reorderMenu(c.req.param("kbId"), {
      menuId: body.menuId,
      targetParentId: body.targetParentId ?? null,
      targetPreviousId: body.targetPreviousId ?? null,
    })
    return c.json({ code: 200, success: true, message: "ok", data: menu })
  })
  .post("/knowledge-bases/:kbId/menus/:menuId/enable", async (c) => {
    await menuService.setEnable(c.req.param("kbId"), c.req.param("menuId"), true)
    return c.json({ code: 200, success: true, message: "ok", data: null })
  })
  .post("/knowledge-bases/:kbId/menus/:menuId/disable", async (c) => {
    await menuService.setEnable(c.req.param("kbId"), c.req.param("menuId"), false)
    return c.json({ code: 200, success: true, message: "ok", data: null })
  })
  .delete("/knowledge-bases/:kbId/menus/:menuId", async (c) => {
    await menuService.deleteMenu(c.req.param("kbId"), c.req.param("menuId"))
    return c.json({ code: 200, success: true, message: "ok", data: null })
  })

  // ── 文档:草稿/发布/读取 ──
  .get("/knowledge-bases/:kbId/documents", async (c) => {
    const items = await documentService.listForAdmin(c.req.param("kbId"))
    return c.json({ code: 200, success: true, message: "ok", data: items })
  })
  .put("/knowledge-bases/:kbId/documents/:menuId/draft", async (c) => {
    const body = await c.req.json()
    const doc = await documentService.saveDraft(c.req.param("kbId"), c.req.param("menuId"), {
      contentJson: body.contentJson,
      contentType: body.contentType,
    })
    return c.json({ code: 200, success: true, message: "ok", data: doc })
  })
  .delete("/knowledge-bases/:kbId/documents/:menuId/draft", async (c) => {
    const doc = await documentService.discardDraft(c.req.param("kbId"), c.req.param("menuId"))
    return c.json({ code: 200, success: true, message: "ok", data: doc })
  })
  .get("/knowledge-bases/:kbId/documents/:menuId", async (c) => {
    const doc = await documentService.getForAdmin(c.req.param("kbId"), c.req.param("menuId"))
    return c.json({ code: 200, success: true, message: "ok", data: doc })
  })
  .post("/knowledge-bases/:kbId/documents/:menuId/publish", async (c) => {
    const body = await c.req.json()
    const doc = await documentService.publish(c.req.param("kbId"), c.req.param("menuId"), {
      contentJson: body.contentJson,
      contentType: body.contentType,
      plainTextContent: body.plainTextContent,
    })
    return c.json({ code: 200, success: true, message: "ok", data: doc })
  })

  // 统一错误映射
  .onError((error, c) => {
    if (error instanceof DocPlatformError) {
      const status =
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "CONFLICT"
            ? 409
            : error.code === "UNSUPPORTED_MODE"
              ? 400
              : 400
      return c.json({ code: status, success: false, message: error.message, data: null }, status as 400 | 404 | 409)
    }
    console.error("[doc-platform/admin] unhandled error:", error)
    return c.json({ code: 500, success: false, message: error.message || "Internal server error", data: null }, 500)
  })
