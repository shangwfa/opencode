/**
 * 公开读接口(/kb):按 slug 访问,仅公开知识库可见(私密库一律 404)
 */
import { Hono } from "hono"
import { KbService } from "../services/kb.service.js"
import { MenuService } from "../services/menu.service.js"
import { DocumentService } from "../services/document.service.js"
import { SearchShellService } from "../services/search-shell.service.js"
import { DocPlatformError } from "../types.js"

const kbService = new KbService()
const menuService = new MenuService()
const documentService = new DocumentService()
const searchShellService = new SearchShellService()

export const kbPublicApp = new Hono()
  .get("/kb/:slug/tree", async (c) => {
    const slug = c.req.param("slug")
    const kb = await kbService.getKbBySlug(slug)
    if (!kb.isPublic) throw new DocPlatformError("NOT_FOUND", `知识库未公开: ${slug}`)
    const tree = await menuService.getTree(kb.id, { includeDisabled: false })
    return c.json({ code: 200, success: true, message: "ok", data: tree })
  })
  .get("/kb/:slug/documents/:menuId/content", async (c) => {
    const content = await documentService.getPublicContent(
      c.req.param("slug"),
      c.req.param("menuId"),
    )
    return c.json({ code: 200, success: true, message: "ok", data: content })
  })
  .post("/kb/:slug/search", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const data = await searchShellService.searchPublic(c.req.param("slug"), {
      q: String(body.q ?? ""),
      page: Number(body.page ?? 1),
      pageSize: Number(body.pageSize ?? 10),
    })
    return c.json({ code: 200, success: true, message: "ok", data })
  })
  .onError((error, c) => {
    if (error instanceof DocPlatformError) {
      // 公开面:私密/不存在一律 404,不泄露存在性
      return c.json({ code: 404, success: false, message: "Not Found", data: null }, 404)
    }
    const statusCode = (error as any)?.statusCode === 404 ? 404 : 500
    if (statusCode === 500) {
      console.error("[doc-platform/public] unhandled error:", error)
    }
    return c.json(
      { code: statusCode, success: false, message: statusCode === 404 ? "Not Found" : error.message || "Internal server error", data: null },
      statusCode as 404 | 500,
    )
  })
