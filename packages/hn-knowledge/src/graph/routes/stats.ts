import { Hono } from 'hono'
import { getGraphStats } from '../services.js'

/** GET /stats?knowledgeBaseId=xx —— 图库规模/类型分布/溯源覆盖统计 */
export const graphStats = new Hono().get('/stats', async (c) => {
  const knowledgeBaseId = c.req.query('knowledgeBaseId')
  if (!knowledgeBaseId) {
    return c.json({ code: 400, success: false, message: 'knowledgeBaseId 必填（query）', data: null }, 400)
  }
  try {
    const stats = await getGraphStats(knowledgeBaseId)
    return c.json({ code: 200, success: true, message: 'ok', data: stats })
  } catch (e: any) {
    return c.json({ code: 500, success: false, message: e.message || '统计失败', data: null }, 500)
  }
})
