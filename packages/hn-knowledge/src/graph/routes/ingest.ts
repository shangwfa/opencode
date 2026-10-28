import { Hono } from 'hono'
import { z } from 'zod'
import { getGraphHttpService } from '../services.js'

const IngestBodySchema = z.object({
  knowledgeBaseId: z.string().min(1),
  documentId: z.string().min(1),
  /** 文档内容：markdown/text 为字符串；tiptap 为文档 JSON 对象 */
  content: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
  type: z.enum(['markdown', 'text', 'tiptap']).optional().default('markdown'),
  /** append（默认，叠加语义）| replace（先清本文档旧图数据再写入） */
  updateMode: z.enum(['append', 'replace']).optional(),
  /** 单 chunk LLM 抽取超时（ms），默认 90s */
  extractTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
  /** chunk 抽取并发，默认 4 */
  concurrency: z.number().int().min(1).max(8).optional(),
  /** chunk 级检查点：中断后重传可跳过已抽取 chunk */
  chunkCheckpoint: z.boolean().optional(),
})

export const ingestGraphDocument = new Hono().post('/ingest', async (c) => {
  let parsed: z.infer<typeof IngestBodySchema>
  try {
    parsed = IngestBodySchema.parse(await c.req.json())
  } catch (e: any) {
    return c.json({ code: 400, success: false, message: `参数校验失败: ${e.message}`, data: null }, 400)
  }
  try {
    const { pipeline } = await getGraphHttpService()
    const result = await pipeline.ingest(parsed.content, {
      type: parsed.type,
      knowledgeBaseId: parsed.knowledgeBaseId,
      documentId: parsed.documentId,
      updateMode: parsed.updateMode,
      extractTimeoutMs: parsed.extractTimeoutMs,
      concurrency: parsed.concurrency,
      chunkCheckpoint: parsed.chunkCheckpoint,
    })
    return c.json({ code: 200, success: true, message: 'ok', data: result })
  } catch (e: any) {
    return c.json({ code: 500, success: false, message: e.message || '图摄入失败', data: null }, 500)
  }
})
