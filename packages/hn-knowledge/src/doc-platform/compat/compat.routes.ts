/**
 * v1 兼容路由:原 yddoc/Boss 帮助中心接口的 doc-platform 实现
 * (原 UI/交互零改动 —— hn-docs 旧组件经 rewrite 直达本层)
 *
 * scope 语义:brandCode = 知识库 slug(或 id);languageCode 校验库语言
 * 响应信封:{ code, success, message, data }(与 resultResolve 兼容)
 *
 * yddoc 公开:
 *   GET /compat/yddoc/menus/getMenuTreeByBrandCode?brandCode&languageCode
 *   GET /compat/yddoc/menus/:menuId/contents
 *   GET /compat/yddoc/oss/domain
 *   GET /compat/yddoc/envConfig/queryByBrandCodeAndLanguageCode
 * Boss 管理(/compat/boss/helpdoc):
 *   GET  /menu/getAdminMenuTreeByBrandCode | /menu/queryById | /draft/queryByMenuId
 *   GET  /envConfig/getDocEnvConfig | /envConfig/queryAllDocEnvByBrandCode | /alias/listByDocId
 *   POST /menu/add|update|save|enable|disable|tuneUpOrder|sync
 *   POST /draft/add|update | /oss/getUploadUrl | /alias/update
 *   DELETE /menu/delete?id= | /draft/delete?id= | /draft/deleteByMenuId?menuId=
 *   PUT  /oss/upload?key=...&fileName=...&contentType=...(v1 上传字节落点)
 *   GET  /oss/read/{key}(v1 readUrl 读取点)
 * 其他:
 *   POST /compat/knowledge-base/sync-from-doc-platform(空操作:派生已同进程自动化)
 *   GET  /compat/oem/query(空 OEM 信息)
 */
import { Hono } from "hono"
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm"
import {
  compatUploads,
  db,
  documents,
  kbAliases,
  knowledgeBases,
  menus,
} from "../../db/index.js"
import { syncWorkerService } from "../services/sync-worker.service.js"
import { SearchShellService } from "../services/search-shell.service.js"
import { putResource, uploadMode } from "../open/oss.service.js"
import { getCompatUpload, putCompatUpload, compatUploadKey } from "./uploads.js"

// ── 工具 ──

async function resolveKb(brandCode: string) {
  const [byId] = await db
    .select()
    .from(knowledgeBases)
    .where(eq(knowledgeBases.id, brandCode))
    .limit(1)
  const kb =
    byId ??
    (
      await db
        .select()
        .from(knowledgeBases)
        .where(eq(knowledgeBases.slug, brandCode))
        .limit(1)
    )[0]
  if (!kb) throw Object.assign(new Error(`知识库不存在: ${brandCode}`), { statusCode: 404 })
  return kb
}

type MenuRow = typeof menus.$inferSelect

async function listMenuRows(kbId: string): Promise<MenuRow[]> {
  return db.select().from(menus).where(eq(menus.knowledgeBaseId, kbId))
}

/** dp 菜单行 → v1 MenuData 树(兄弟链表排序;includeDisabled 控制禁用项) */
function buildV1Tree(rows: MenuRow[], includeDisabled: boolean): any[] {
  const byParent = new Map<string | null, MenuRow[]>()
  for (const row of rows) {
    if (!includeDisabled && row.enable !== 1) continue
    const key = row.parentId
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(row)
  }

  function build(parent: MenuRow | null): any[] {
    const group = byParent.get(parent ? parent.id : null) ?? []
    const inGroup = new Set(group.map((r) => r.id))
    const ordered: MenuRow[] = []
    const visited = new Set<string>()
    for (const head of group.filter((r) => !r.previousId || !inGroup.has(r.previousId))) {
      let cursor: MenuRow | undefined = head
      while (cursor && !visited.has(cursor.id)) {
        visited.add(cursor.id)
        ordered.push(cursor)
        cursor = group.find((r) => r.previousId === cursor!.id)
      }
    }
    for (const row of group) if (!visited.has(row.id)) ordered.push(row)

    return ordered.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type === "folder" ? "folder" : "doc",
      menuTrees: build(row),
      iconUrl: row.iconUrl ?? "",
      slug: row.slug ?? "",
      url: "",
      enable: row.enable === 1,
      parentId: row.parentId ? Number(row.parentId) || row.parentId : 0,
      previousId: row.previousId ?? "",
      scope: "public",
      docUniqueId: row.docUniqueId ?? row.id,
    }))
  }

  return build(null)
}

function v1DocRecord(doc: typeof documents.$inferSelect) {
  return {
    menuId: doc.menuId ?? doc.id,
    docUniqueId: doc.id,
    id: doc.id,
    name: "",
    enable: true,
    contentKey: `dp://${doc.id}`,
    contentType: doc.type,
    hasDraft: !!doc.draftContentJson,
    scope: "public",
  }
}

// ── 路由 ──

/** 基于请求 origin 的绝对地址(rewrite 转发后取 x-forwarded-host,回退请求 origin) */
function absoluteOrigin(c: any): string {
  const fwdHost = c.req.header("x-forwarded-host")
  const fwdProto = c.req.header("x-forwarded-proto") || "http"
  if (fwdHost) return `${fwdProto}://${fwdHost}`
  return new URL(c.req.url).origin
}

export const compatApp = new Hono()

// ── yddoc 公开(noauth) ──

compatApp.get("/yddoc/menus/getMenuTreeByBrandCode", async (c) => {
  const kb = await resolveKb(c.req.query("brandCode") || "")
  const languageCode = c.req.query("languageCode")
  if (languageCode && kb.languageCode && languageCode !== kb.languageCode) {
    return c.json({ code: 200, success: true, message: "ok", data: [] })
  }
  const tree = buildV1Tree(await listMenuRows(kb.id), false)
  return c.json({ code: 200, success: true, message: "ok", data: tree })
})

compatApp.get("/yddoc/menus/:menuId/contents", async (c) => {
  const menuId = c.req.param("menuId")
  const [doc] = await db.select().from(documents).where(eq(documents.id, menuId)).limit(1)
  const [menu] = await db.select({ name: menus.name }).from(menus).where(eq(menus.id, menuId)).limit(1)
  // v1 契约:{ content } —— content 原为 OSS docUrl;v2 直出内联 JSON(前端 getDocData 已支持直通)
  // 无正文或正文非有效 TipTap 文档(如残留空对象)时返回空串,前端渲染为空页
  const contentJson = doc?.contentJson as { type?: string } | undefined
  const content =
    contentJson && contentJson.type === "doc" ? JSON.stringify(doc.contentJson) : ""
  return c.json({
    code: 200,
    success: true,
    message: "ok",
    data: {
      menuId,
      docUniqueId: doc?.id ?? menuId,
      name: menu?.name ?? "",
      content,
      contentType: doc?.type ?? "text",
      hasDraft: !!doc?.draftContentJson,
    },
  })
})

compatApp.get("/yddoc/oss/domain", async (c) => {
  // blob 模式资源为完整 URL,前端 docDomainAssemble 对 blob 域名直接放行(已适配)
  // 域名解析:env 配置优先,回落最近一次上传的 blob URL origin
  let domain = ""
  try {
    if (uploadMode() === "vercel-blob") {
      domain = process.env.KNOWLEDGE_BLOB_PUBLIC_DOMAIN?.trim() || ""
      if (!domain) {
        const { compatUploads: cu } = await import("../../db/index.js")
        const [row] = await db
          .select({ url: cu.blobUrl })
          .from(cu)
          .where(isNotNull(cu.blobUrl))
          .limit(1)
        if (row?.url) domain = new URL(row.url).origin
      }
    }
  } catch {
    domain = ""
  }
  return c.json({ code: 200, success: true, message: "ok", data: domain })
})

compatApp.get("/yddoc/envConfig/queryByBrandCodeAndLanguageCode", async (c) => {
  const kb = await resolveKb(c.req.query("brandCode") || "")
  const settings = (kb.settings as Record<string, unknown>) ?? {}
  const extraInfo = JSON.stringify({
    languages: {},
    title: kb.name,
    logo: "",
  })
  return c.json({
    code: 200,
    success: true,
    message: "ok",
    data: {
      docEnvConfigExtraInfo: extraInfo,
      envCode: (settings.envCode as string) || "test",
      docEnvConfigReference: null,
      defaultLanguageCode: kb.languageCode || "zh-cn",
      languageBOList: [
        { languageCode: kb.languageCode || "zh-cn", languageName: "简体中文", brandCode: kb.slug },
      ],
      docBrandId: kb.id,
      id: kb.id,
      brandCode: kb.slug,
      languageCode: kb.languageCode,
    },
  })
})

compatApp.get("/yddoc/products/:productCode", async (c) =>
  c.json({ code: 200, success: true, message: "ok", data: { productCode: c.req.param("productCode"), name: "" } }),
)

// ── 别名(走 BASE_URL 网关的原路径) ──

compatApp.get("/yddoc/cornerstone/helpdoc/alias/queryDocIdByAlias", async (c) => {
  const alias = c.req.query("alias")
  if (!alias) return c.json({ code: 200, success: true, message: "ok", data: null })
  const rows = await db
    .select({ menuId: kbAliases.menuId })
    .from(kbAliases)
    .where(eq(kbAliases.alias, alias))
    .limit(1)
  return c.json({
    code: 200,
    success: true,
    message: "ok",
    data: rows[0]?.menuId ? { docId: rows[0].menuId } : null,
  })
})

compatApp.get("/cornerstone/helpdoc/alias/queryDocIdByAlias", async (c) => {
  const alias = c.req.query("alias")
  if (!alias) return c.json({ code: 200, success: true, message: "ok", data: null })
  const rows = await db
    .select({ menuId: kbAliases.menuId })
    .from(kbAliases)
    .where(eq(kbAliases.alias, alias))
    .limit(1)
  return c.json({
    code: 200,
    success: true,
    message: "ok",
    data: rows[0]?.menuId ? { docId: rows[0].menuId } : null,
  })
})

// ── Boss 管理(helpdoc) ──

compatApp.get("/boss/helpdoc/menu/getAdminMenuTreeByBrandCode", async (c) => {
  const kb = await resolveKb(c.req.query("brandCode") || "")
  const languageCode = c.req.query("languageCode")
  if (languageCode && kb.languageCode && languageCode !== kb.languageCode) {
    return c.json({ code: 200, success: true, message: "ok", data: [] })
  }
  const tree = buildV1Tree(await listMenuRows(kb.id), true)
  return c.json({ code: 200, success: true, message: "ok", data: tree })
})

compatApp.post("/boss/helpdoc/menu/add", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const kb = await resolveKb(body.brandCode || "")
  const id = `${Date.now()}${Math.random().toString(36).substring(2, 8)}`
  const type = body.type === "folder" ? "folder" : "doc"
  await db.insert(menus).values({
    id,
    knowledgeBaseId: kb.id,
    parentId: body.parentId ? String(body.parentId) : null,
    previousId: body.previousId ? String(body.previousId) : null,
    name: body.name,
    type,
    iconUrl: body.iconUrl || null,
    enable: 1,
    docUniqueId: type === "doc" ? id : null,
  })
  if (type === "doc") {
    await db.insert(documents).values({
      id,
      knowledgeBaseId: kb.id,
      content: "",
      type: "tiptap",
      status: "draft",
      menuId: id,
    })
  }
  return c.json({ code: 200, success: true, message: "ok", data: { id, docUniqueId: type === "doc" ? id : "" } })
})

compatApp.post("/boss/helpdoc/menu/update", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const kb = await resolveKb(body.brandCode || "")
  const values: Record<string, unknown> = { updatedAt: new Date() }
  if (body.name !== undefined) values.name = body.name
  if (body.parentId !== undefined) values.parentId = body.parentId ? String(body.parentId) : null
  if (body.previousId !== undefined) values.previousId = body.previousId ? String(body.previousId) : null
  if (body.iconUrl !== undefined) values.iconUrl = body.iconUrl
  await db
    .update(menus)
    .set(values as any)
    .where(and(eq(menus.id, String(body.id)), eq(menus.knowledgeBaseId, kb.id)))
  return c.json({ code: 200, success: true, message: "ok", data: null })
})

compatApp.delete("/boss/helpdoc/menu/delete", async (c) => {
  const menuId = c.req.query("id") || ""
  const [menuRow] = await db.select().from(menus).where(eq(menus.id, menuId)).limit(1)
  const kbId = menuRow?.knowledgeBaseId || ""
  if (!kbId) return c.json({ code: 200, success: true, message: "ok", data: null })
  const rows = await listMenuRows(kbId)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const ids: string[] = []
  const stack = [menuId]
  while (stack.length) {
    const current = stack.pop()!
    if (!byId.has(current) || ids.includes(current)) continue
    ids.push(current)
    for (const row of rows) if (row.parentId === current) stack.push(row.id)
  }
  if (ids.length) {
    for (const id of ids) {
      const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1)
      if (doc) {
        await syncWorkerService.enqueueDocumentSync(kbId, id, "delete", true)
      }
    }
    await db.delete(documents).where(and(eq(documents.knowledgeBaseId, kbId), inArray(documents.id, ids)))
    await db.delete(menus).where(and(eq(menus.knowledgeBaseId, kbId), inArray(menus.id, ids)))
  }
  return c.json({ code: 200, success: true, message: "ok", data: null })
})

compatApp.post("/boss/helpdoc/menu/save", async (c) => {
  // v1 saveDoc:{menuId, contentType, content(上传 key), plainTextContent}
  const body = await c.req.json().catch(() => ({}))
  const upload = await getCompatUpload(body.content)
  if (!upload?.payload) {
    return c.json({ code: 500, success: false, message: `正文内容不存在: ${body.content}`, data: null })
  }
  const menuId = String(body.menuId)
  const [doc] = await db.select().from(documents).where(eq(documents.id, menuId)).limit(1)
  if (!doc) {
    return c.json({ code: 500, success: false, message: `文档不存在: ${menuId}`, data: null })
  }
  await db
    .update(documents)
    .set({
      contentJson: upload.payload as object,
      content: String(body.plainTextContent ?? ""),
      // 发布即覆盖草稿，避免后续进入编辑时仍提示“有未发布内容”。
      draftContentJson: null,
      type: body.contentType === "oss" ? "tiptap" : body.contentType || "tiptap",
      publishedAt: new Date(),
      status: "published",
      updatedAt: new Date(),
    })
    .where(eq(documents.id, menuId))
  await syncWorkerService.enqueueDocumentSync(doc.knowledgeBaseId, menuId, "upsert", true)
  return c.json({ code: 200, success: true, message: "ok", data: { menuId, contentKey: body.content } })
})

compatApp.post("/boss/helpdoc/menu/enable", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  await db
    .update(menus)
    .set({ enable: 1, updatedAt: new Date() } as any)
    .where(eq(menus.id, String(body.id)))
  return c.json({ code: 200, success: true, message: "ok", data: null })
})

compatApp.post("/boss/helpdoc/menu/disable", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  await db
    .update(menus)
    .set({ enable: 0, updatedAt: new Date() } as any)
    .where(eq(menus.id, String(body.id)))
  return c.json({ code: 200, success: true, message: "ok", data: null })
})

compatApp.post("/boss/helpdoc/menu/tuneUpOrder", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const menuId = String(body.id)
  const targetParentId = body.targetParentId ? String(body.targetParentId) : null
  const targetPreviousId = body.targetPreviousId ? String(body.targetPreviousId) : null

  const [menu] = await db.select().from(menus).where(eq(menus.id, menuId)).limit(1)
  if (!menu) return c.json({ code: 500, success: false, message: "菜单不存在", data: null })

  // 摘除旧链
  const oldSiblingRows =
    menu.parentId === null
      ? await db
          .select()
          .from(menus)
          .where(and(eq(menus.knowledgeBaseId, menu.knowledgeBaseId), isNull(menus.parentId)))
      : await db
          .select()
          .from(menus)
          .where(and(eq(menus.knowledgeBaseId, menu.knowledgeBaseId), eq(menus.parentId, menu.parentId)))
  const next = oldSiblingRows.find((r) => r.previousId === menu.id && r.id !== menu.id)
  if (next) {
    await db
      .update(menus)
      .set({ previousId: menu.previousId, updatedAt: new Date() })
      .where(eq(menus.id, next.id))
  }
  // 插入新链
  await db
    .update(menus)
    .set({ parentId: targetParentId, previousId: targetPreviousId, updatedAt: new Date() })
    .where(eq(menus.id, menu.id))
  const newSiblingRows =
    targetParentId === null
      ? await db
          .select()
          .from(menus)
          .where(and(eq(menus.knowledgeBaseId, menu.knowledgeBaseId), isNull(menus.parentId)))
      : await db
          .select()
          .from(menus)
          .where(and(eq(menus.knowledgeBaseId, menu.knowledgeBaseId), eq(menus.parentId, targetParentId)))
  const displaced = newSiblingRows.find((r) => r.previousId === targetPreviousId && r.id !== menu.id)
  if (displaced) {
    await db
      .update(menus)
      .set({ previousId: menu.id, updatedAt: new Date() })
      .where(eq(menus.id, displaced.id))
  }
  return c.json({ code: 200, success: true, message: "ok", data: null })
})

compatApp.get("/boss/helpdoc/menu/queryById", async (c) => {
  const menuId = c.req.query("id") || ""
  const [doc] = await db.select().from(documents).where(eq(documents.id, menuId)).limit(1)
  if (!doc) return c.json({ code: 200, success: true, message: "ok", data: null })
  return c.json({
    code: 200,
    success: true,
    message: "ok",
    data: {
      ...v1DocRecord(doc),
      name: "",
      hasDraft: !!doc.draftContentJson,
      contentType: doc.type,
    },
  })
})

compatApp.get("/boss/helpdoc/draft/queryByMenuId", async (c) => {
  const menuId = c.req.query("menuId") || ""
  const [doc] = await db.select().from(documents).where(eq(documents.id, menuId)).limit(1)
  if (!doc?.draftContentJson) {
    return c.json({ code: 200, success: true, message: "ok", data: { content: "", contentType: "" } })
  }
  // v1 契约:{ content(key), contentType } —— 前端 getDocData(key) 读取;compat key 指向缓存读取端点
  const readKey = `draft_${menuId}`
  await putCompatUpload({
    key: readKey,
    knowledgeBaseId: doc.knowledgeBaseId,
    kind: "doc",
    contentType: doc.type,
    payload: doc.draftContentJson,
  })
  return c.json({
    code: 200,
    success: true,
    message: "ok",
    data: {
      content: `${absoluteOrigin(c)}/api/doc-platform/compat/oss/read/${readKey}`,
      contentType: doc.type,
      draftId: readKey,
    },
  })
})

compatApp.post("/boss/helpdoc/draft/add", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const upload = await getCompatUpload(body.content)
  const [doc] = await db.select().from(documents).where(eq(documents.id, String(body.menuId))).limit(1)
  if (!doc || !upload?.payload) {
    return c.json({ code: 404, success: false, message: "文档或草稿内容不存在", data: null }, 404)
  }
  await db
      .update(documents)
      .set({ draftContentJson: upload.payload as object, type: body.contentType || doc.type, updatedAt: new Date() })
      .where(eq(documents.id, String(body.menuId)))
  return c.json({
    code: 200,
    success: true,
    message: "ok",
    data: { id: doc.id, menuId: doc.menuId ?? doc.id },
  })
})

compatApp.post("/boss/helpdoc/draft/update", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const upload = await getCompatUpload(body.content)
  const [doc] = await db.select().from(documents).where(eq(documents.id, String(body.menuId))).limit(1)
  if (!doc || !upload?.payload) {
    return c.json({ code: 404, success: false, message: "文档或草稿内容不存在", data: null }, 404)
  }
  await db
      .update(documents)
      .set({ draftContentJson: upload.payload as object, type: body.contentType || doc.type, updatedAt: new Date() })
      .where(eq(documents.id, String(body.menuId)))
  return c.json({
    code: 200,
    success: true,
    message: "ok",
    data: { id: doc.id, menuId: doc.menuId ?? doc.id },
  })
})

compatApp.delete("/boss/helpdoc/draft/delete", async (c) => {
  return c.json({ code: 200, success: true, message: "ok", data: null })
})

compatApp.delete("/boss/helpdoc/draft/deleteByMenuId", async (c) => {
  const menuId = c.req.query("menuId") || ""
  await db
    .update(documents)
    .set({ draftContentJson: null, updatedAt: new Date() })
    .where(eq(documents.id, menuId))
  return c.json({ code: 200, success: true, message: "ok", data: null })
})

compatApp.post("/boss/helpdoc/oss/getUploadUrl", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const origin = absoluteOrigin(c)
  const contentType = body.contentType || "application/octet-stream"
  const isDoc = body.fileType === "doc"

  if (isDoc) {
    // 正文 JSON:走 compat 缓存(uploadUrl/readUrl 均为本服务端点)
    const key = compatUploadKey()
    await putCompatUpload({ key, kind: "doc", contentType, payload: {} })
    return c.json({
      code: 200,
      success: true,
      message: "ok",
      data: {
        key,
        uploadUrl: `${origin}/api/doc-platform/compat/oss/upload?key=${encodeURIComponent(key)}&contentType=${encodeURIComponent(contentType)}&kind=doc`,
        readUrl: `${origin}/api/doc-platform/compat/oss/read/${encodeURIComponent(key)}`,
      },
    })
  }

  // 资源(doc_asset 等):key 预生成 → PUT 代理端点按 key 落 Vercel Blob;readUrl = 代理读端点(PUT 后可读)
  const key = `res_${compatUploadKey()}`
  await putCompatUpload({ key, kind: "asset", contentType, payload: {} })
  return c.json({
    code: 200,
    success: true,
    message: "ok",
    data: {
      key,
      uploadUrl: `${origin}/api/doc-platform/compat/oss/upload?key=${encodeURIComponent(key)}&contentType=${encodeURIComponent(contentType)}&fileName=${encodeURIComponent(body.fileName || "file")}&kind=asset`,
      readUrl: `${origin}/api/doc-platform/compat/oss/read/${encodeURIComponent(key)}`,
    },
  })
})

// v1 上传字节落点:doc → 缓存表;asset → Vercel Blob(blob URL 回填缓存)
compatApp.put("/oss/upload", async (c) => {
  const key = c.req.query("key") || ""
  const contentType = c.req.query("contentType") || "application/octet-stream"
  const fileName = c.req.query("fileName") || "file"
  const kind = c.req.query("kind") || "doc"
  if (!key) return c.json({ code: 500, success: false, message: "缺少 key", data: null })
  const bytes = new Uint8Array(await c.req.arrayBuffer())

  if (kind === "asset") {
    const uploaded = await putResource({
      bytes,
      contentType,
      fileName,
      contextId: "compat-upload",
      keyOverride: key,
    })
    await db
      .update(compatUploads)
      .set({ blobUrl: uploaded.readUrl })
      .where(eq(compatUploads.key, key))
    return c.json({ code: 200, success: true, message: "ok", data: { key, url: uploaded.readUrl } })
  }

  const text = new TextDecoder().decode(bytes)
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    payload = text
  }
  await putCompatUpload({ key, kind: "doc", contentType, payload })
  return c.json({ code: 200, success: true, message: "ok", data: { key } })
})

// v1 readUrl 读取点
compatApp.get("/oss/read/:key", async (c) => {
  const upload = await getCompatUpload(c.req.param("key"))
  if (!upload) return c.json({ code: 404, success: false, message: "Not Found", data: null }, 404)
  if (upload.blobUrl) return c.redirect(upload.blobUrl)
  if (upload.kind === "asset") {
    // 资源尚未上传完成:返回占位 1x1 png,避免前端破图
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    )
    return c.body(png, 200, { "Content-Type": "image/png" })
  }
  return c.json(upload.payload)
})

// ── 次要兼容(空操作/空数据) ──

compatApp.get("/boss/helpdoc/envConfig/getDocEnvConfig", async (c) => {
  const kb = await resolveKb(c.req.query("id") || "")
  const settings = (kb.settings as Record<string, unknown>) ?? {}
  return c.json({
    code: 200,
    success: true,
    message: "ok",
    data: {
      id: kb.id,
      envCode: (settings.envCode as string) || "test",
      docEnvConfigReference: null,
      docEnvConfigExtraInfo: null,
      defaultLanguageCode: kb.languageCode,
      brandCode: kb.slug,
      languageCode: kb.languageCode,
    },
  })
})

compatApp.get("/boss/helpdoc/envConfig/queryAllDocEnvByBrandCode", async (c) => {
  const kb = await resolveKb(c.req.query("brandCode") || "")
  return c.json({
    code: 200,
    success: true,
    message: "ok",
    data: [
      {
        brandCode: kb.slug,
        brandName: kb.name,
        languageCode: kb.languageCode || "zh-cn",
        languageName: "简体中文",
        docEnvConfigId: kb.id,
      },
    ],
  })
})

compatApp.get("/boss/helpdoc/alias/listByDocId", async (c) => {
  return c.json({ code: 200, success: true, message: "ok", data: [] })
})

compatApp.post("/boss/helpdoc/alias/update", async (c) => {
  return c.json({ code: 200, success: true, message: "ok", data: null })
})

compatApp.post("/boss/helpdoc/menu/sync", async (c) => {
  // 跨语言同步:单语言知识库模型下为空操作
  return c.json({ code: 200, success: true, message: "ok", data: null })
})

compatApp.post("/knowledge-base/sync-from-doc-platform", async (c) => {
  // 知识库同步任务已由发布链路同进程自动化,此处兼容返回排队形态
  const body = await c.req.json().catch(() => ({}))
  return c.json({
    code: 200,
    success: true,
    message: "ok",
    data: {
      taskId: `inline_${Date.now()}`,
      knowledgeBaseId: "",
      operation: body.operation ?? "upsertDocument",
      documentCount: Array.isArray(body.documents) ? body.documents.length : 0,
      status: "queued",
    },
  })
})

compatApp.get("/oem/query", async (c) => {
  return c.json({ code: 200, success: true, message: "ok", data: { title: "", iconUrl: "", configValue: null } })
})

// ── 原 sys 服务兼容(门户页 QuickStart/搜索等组件) ──

compatApp.get("/sys/sceneDataSource/listBySceneCode", async (c) => {
  // 无场景数据源配置:返回空,QuickStart 组件不渲染
  return c.json({ code: 200, success: true, message: "ok", data: [] })
})

compatApp.get("/sys/fullIndex/tips", async (c) => {
  return c.json({ code: 200, success: true, message: "ok", data: [] })
})

async function searchHelpDocuments(c: any) {
  const productCode = c.req.query("productCode") || ""
  const query = c.req.query("key") || ""
  const page = Math.max(1, Number(c.req.query("page") || 1))
  const size = Math.min(50, Math.max(1, Number(c.req.query("size") || 20)))
  const source = c.req.query("source")

  // 论坛结果由外部系统提供；此兼容服务只承载帮助文档检索。
  if (!query.trim() || source === "forum") {
    return c.json({ code: 200, success: true, message: "ok", data: [], page: { page, pages: 0, total: 0 } })
  }

  const candidates = await db.select().from(knowledgeBases)
  const kb = candidates.find((candidate) => {
    const settings = candidate.settings as Record<string, unknown> | null
    return candidate.slug === productCode || candidate.id === productCode || settings?.envCode === productCode
  }) ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (!kb?.slug) {
    return c.json({ code: 200, success: true, message: "ok", data: [], page: { page, pages: 0, total: 0 } })
  }

  const result = await new SearchShellService().searchPublic(kb.slug, {
    q: query,
    page,
    pageSize: size,
    // 原帮助中心路由本身面向公开页面，文档菜单 enable 状态仍由检索服务过滤。
    allowPrivate: true,
  })

  // 旧全站搜索不能把只有向量相似、正文却完全不含查询词的结果展示出来。
  // 中文按词分段后至少命中一半词；英文/数字按完整词匹配。
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" })
  const queryTerms = [...segmenter.segment(query.toLocaleLowerCase())]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment.trim())
    .filter((term) => term.length > 1)
  const relevantItems = result.items.filter((item) => {
    const searchableText = `${item.name} ${item.path.join(" ")} ${item.snippet}`.toLocaleLowerCase()
    if (queryTerms.length === 0) return searchableText.includes(query.toLocaleLowerCase())
    const matchedTerms = queryTerms.filter((term) => searchableText.includes(term)).length
    return matchedTerms >= Math.ceil(queryTerms.length / 2)
  })

  const data = relevantItems.map((item) => ({
    id: item.menuId,
    menuId: item.menuId,
    title: item.name,
    body: item.snippet.replace(/!?\[[^\]]*\]\([^)]*\)/g, "").replace(/[*_`#]/g, "").trim(),
    url: `/${result.kb}/${kb.languageCode || "zh-cn"}/${item.menuId}`,
    source: "yd_doc",
    sourceName: result.kbName,
    tag: "",
    score: item.score,
    officialTag: true,
    isAccept: false,
  }))
  const pages = relevantItems.length ? Math.ceil(relevantItems.length / size) : 0
  return c.json({
    code: 200,
    success: true,
    message: "ok",
    data,
    page: { page, pages, total: relevantItems.length },
  })
}

compatApp.get("/sys/fullIndex/search", searchHelpDocuments)
compatApp.get("/sys/fullIndex/searchNew", searchHelpDocuments)

compatApp.post("/sys/spm/record/log", async (c) => {
  return c.json({ code: 200, success: true, message: "ok", data: null })
})

// hn-docs 的 recordLogs 实际以 GET 方式发送埋点参数。
compatApp.get("/sys/spm/record/log", async (c) => {
  return c.json({ code: 200, success: true, message: "ok", data: null })
})

compatApp.get("/user/info/rich", async (c) => {
  return c.json({ code: 200, success: true, message: "ok", data: null })
})

compatApp.post("/user/token/createJumpToken", async (c) => {
  return c.json({ code: 200, success: true, message: "ok", data: { token: "" } })
})

compatApp.post("/proxy/token", async (c) => {
  return c.json({ code: 200, success: true, message: "ok", data: { token: "" } })
})

compatApp.get("/sys/sceneDataSource/listBySceneCode", async (c) => {
  return c.json({ code: 200, success: true, message: "ok", data: [] })
})

compatApp.onError((error: any, c) => {
  const status = error?.statusCode ?? 500
  if (status >= 500) console.error("[doc-platform/compat] error:", error)
  return c.json(
    { code: status, success: false, message: error?.message || "Internal server error", data: null },
    status as 400 | 404 | 500,
  )
})
