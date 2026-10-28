/**
 * /gw-api/upload：文件/文本上传（原 upload.controller 语义，转投媒体服务）。
 */
import { Hono } from "hono"
import { uploadFile, uploadText } from "../../integrations/media-upload.js"

export const uploadApp = new Hono()

uploadApp.post("/file", async (c) => {
  const body = await c.req.parseBody()
  const file = body["file"]
  if (!(file instanceof File)) {
    return c.json({ success: false, message: "缺少 file 字段" }, 400)
  }
  // 原语义：body.filename 优先；否则 latin1 → utf8 解码原始文件名
  const explicitFilename = typeof body["filename"] === "string" ? (body["filename"] as string) : ""
  const originalname =
    explicitFilename ||
    (file.name === "blob" ? "blob" : Buffer.from(file.name, "latin1").toString("utf8"))
  const contentType = originalname.slice(originalname.indexOf(".") + 1) || file.type
  const result = await uploadFile(originalname, contentType, file.size, await file.arrayBuffer())
  return c.json({ readUrl: result.readUrl })
})

uploadApp.post("/text", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { filename?: string; content?: string } | null
  if (!body?.filename || typeof body.content !== "string") {
    return c.json({ success: false, message: "filename 与 content 为必填" }, 400)
  }
  const result = await uploadText(body.filename, body.content)
  return c.json({ readUrl: result.readUrl })
})
