/**
 * Open API REST 路由(/open/**):文档编辑契约(原 /api/open/v1)的服务端实现
 *
 * 路由(kb = 知识库 slug 或 id):
 *   GET    /open/:kb/documents/tree?version=
 *   GET    /open/:kb/documents/:docUniqueId?version=
 *   GET    /open/:kb/documents/:docUniqueId/blocks/:blockId?version=
 *   POST   /open/:kb/documents
 *   PATCH  /open/:kb/documents/:docUniqueId
 *   PATCH  /open/:kb/documents/:docUniqueId/blocks/:blockId
 *   PUT    /open/:kb/documents/:docUniqueId/enabled
 *   DELETE /open/:kb/documents/:docUniqueId
 *   POST   /open/:kb/resource-upload-sessions
 *
 * 请求体上限 3MB(继承 v1 契约);鉴权插槽见 authMiddleware(决策 #4)
 */
import { Hono } from "hono"
import { BookOpenError } from "./errors.js"
import {
  CreateDocumentInputSchema,
  DeleteDocumentInputSchema,
  GetBlockInputSchema,
  GetDocumentInputSchema,
  SetDocumentEnabledInputSchema,
  UpdateBlockInputSchema,
  UpdateDocumentInputSchema,
  CreateResourceUploadInputSchema,
} from "./schemas.js"
import { OpenDocumentService } from "./open-document.service.js"
import { putResource } from "./oss.service.js"

const service = new OpenDocumentService()

const MAX_BODY_BYTES = 3 * 1024 * 1024

// 鉴权插槽(决策 #4):解析 Bearer 注入 caller;当前仅解析不校验
async function authMiddleware(c: any, next: () => Promise<void>) {
  const authorization = c.req.header("authorization")
  let callerId: string | undefined
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i)
    if (match?.[1]) callerId = "bearer"
  }
  c.set("openCaller", { id: callerId })
  await next()
}

function parseBodyOrThrow(body: unknown, schema: { safeParse: (v: any) => any }): any {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new BookOpenError(
      "VALIDATION_ERROR",
      `${issue.path.join(".") || "body"}: ${issue.message}`,
      { issues: parsed.error.issues },
    )
  }
  return parsed.data
}

export const openApp = new Hono()
  .use("/open/*", authMiddleware)
  .use("/open/*", async (c, next) => {
    // v1 契约:请求体上限 3MB
    const len = Number(c.req.header("content-length") || 0)
    if (len > MAX_BODY_BYTES) {
      throw new BookOpenError("VALIDATION_ERROR", "请求体超过 3MB 上限")
    }
    await next()
  })
  .get("/open/:kb/documents/tree", async (c) => {
    const data = await service.listDocuments({ kb: c.req.param("kb") })
    return c.json({ code: 200, success: true, message: "ok", data })
  })
  .get("/open/:kb/documents/:docUniqueId", async (c) => {
    const input = parseBodyOrThrow(
      {
        kb: c.req.param("kb"),
        docUniqueId: c.req.param("docUniqueId"),
        version: c.req.query("version") ?? undefined,
      },
      GetDocumentInputSchema,
    )
    const data = await service.getDocument(input)
    return c.json({ code: 200, success: true, message: "ok", data })
  })
  .get("/open/:kb/documents/:docUniqueId/blocks/:blockId", async (c) => {
    const input = parseBodyOrThrow(
      {
        kb: c.req.param("kb"),
        docUniqueId: c.req.param("docUniqueId"),
        blockId: c.req.param("blockId"),
        version: c.req.query("version") ?? undefined,
      },
      GetBlockInputSchema,
    )
    const data = await service.getBlock(input)
    return c.json({ code: 200, success: true, message: "ok", data })
  })
  .post("/open/:kb/documents", async (c) => {
    const body = await c.req.json()
    const input = parseBodyOrThrow({ kb: c.req.param("kb"), ...body }, CreateDocumentInputSchema)
    const data = await service.createDocument(input)
    return c.json({ code: 200, success: true, message: "ok", data })
  })
  .patch("/open/:kb/documents/:docUniqueId", async (c) => {
    const body = await c.req.json()
    const input = parseBodyOrThrow(
      { kb: c.req.param("kb"), docUniqueId: c.req.param("docUniqueId"), ...body },
      UpdateDocumentInputSchema,
    )
    const data = await service.updateDocument(input)
    return c.json({ code: 200, success: true, message: "ok", data })
  })
  .patch("/open/:kb/documents/:docUniqueId/blocks/:blockId", async (c) => {
    const body = await c.req.json()
    const input = parseBodyOrThrow(
      {
        kb: c.req.param("kb"),
        docUniqueId: c.req.param("docUniqueId"),
        blockId: c.req.param("blockId"),
        ...body,
      },
      UpdateBlockInputSchema,
    )
    const data = await service.updateBlock(input)
    return c.json({ code: 200, success: true, message: "ok", data })
  })
  .put("/open/:kb/documents/:docUniqueId/enabled", async (c) => {
    const body = await c.req.json()
    const input = parseBodyOrThrow(
      { kb: c.req.param("kb"), docUniqueId: c.req.param("docUniqueId"), ...body },
      SetDocumentEnabledInputSchema,
    )
    const data = await service.setDocumentEnabled(input)
    return c.json({ code: 200, success: true, message: "ok", data })
  })
  .delete("/open/:kb/documents/:docUniqueId", async (c) => {
    const input = parseBodyOrThrow(
      { kb: c.req.param("kb"), docUniqueId: c.req.param("docUniqueId") },
      DeleteDocumentInputSchema,
    )
    const data = await service.deleteDocument(input)
    return c.json({ code: 200, success: true, message: "ok", data })
  })
  // 客户端直传代理(Vercel Blob 模式):PUT 文件字节 → 服务端 put 到 Blob
  .put("/open/:kb/oss/blob-upload", async (c) => {
    const kb = c.req.param("kb")
    const fileName = c.req.query("fileName") || "upload.bin"
    const contentType = c.req.header("content-type") || "application/octet-stream"
    const contextId = c.req.query("contextId") || "adhoc"
    const body = await c.req.arrayBuffer()
    const uploaded = await putResource({
      bytes: new Uint8Array(body),
      contentType,
      fileName,
      contextId,
      envCode: c.req.query("envCode"),
    })
    return c.json({ code: 200, success: true, message: "ok", data: uploaded })
  })
  .post("/open/:kb/resource-upload-sessions", async (c) => {
    const body = await c.req.json()
    const input = parseBodyOrThrow(
      { kb: c.req.param("kb"), ...body },
      CreateResourceUploadInputSchema,
    )
    const data = await service.createResourceUpload(input)
    return c.json({ code: 200, success: true, message: "ok", data })
  })
  .onError((error: any, c) => {
    if (error instanceof BookOpenError) {
      return c.json(
        {
          code: error.status,
          success: false,
          message: error.message,
          error: { code: error.code, ...(error.details ?? {}) },
          data: null,
        },
        error.status as 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502,
      )
    }
    if (error?.type === "SyntaxError" || /json/i.test(error?.message ?? "")) {
      return c.json({ code: 422, success: false, message: "请求体不是合法 JSON", data: null }, 422)
    }
    console.error("[doc-platform/open] unhandled error:", error)
    return c.json({ code: 500, success: false, message: error.message || "Internal server error", data: null }, 500)
  })

export type OpenAppType = typeof openApp
