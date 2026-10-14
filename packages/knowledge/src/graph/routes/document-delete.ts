import { Hono } from 'hono'
import { getGraphHttpService } from '../services.js'

/** DELETE /document/:documentId?knowledgeBaseId=xx —— 按文档删除图数据（unowned 硬删 / shared detach） */
export const deleteGraphDocument = new Hono().delete('/document/:documentId', async (c) => {
  const documentId = c.req.param('documentId')
  const knowledgeBaseId = c.req.query('knowledgeBaseId')
  if (!documentId) {
    return c.json({ code: 400, success: false, message: 'documentId 必填', data: null }, 400)
  }
  if (!knowledgeBaseId) {
    return c.json({ code: 400, success: false, message: 'knowledgeBaseId 必填（query）', data: null }, 400)
  }
  try {
    const { engine } = await getGraphHttpService()
    const result = await engine.deleteByDocument(documentId, knowledgeBaseId)
    return c.json({ code: 200, success: true, message: 'ok', data: result })
  } catch (e: any) {
    return c.json({ code: 500, success: false, message: e.message || '图删除失败', data: null }, 500)
  }
})
