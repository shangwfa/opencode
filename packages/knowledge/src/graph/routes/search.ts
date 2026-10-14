import { Hono } from 'hono'
import { z } from 'zod'
import { searchGraph } from '../services.js'

const SearchBodySchema = z.object({
  query: z.string().min(1),
  knowledgeBaseId: z.string().optional(),
  topK: z.number().int().min(1).max(50).optional(),
  neighborDepth: z.number().int().min(1).max(4).optional(),
  /** 相关性分数下限（0-1） */
  minScore: z.number().min(0).max(1).optional(),
  /** 排除的关系类型（如结构边「包含」） */
  excludeRelationTypes: z.array(z.string()).optional(),
  /** 查询含明确实体但图内未命中时返回空（防无关上下文） */
  strictRelevance: z.boolean().optional(),
  /** 精排：embedding（向量重排）| llm（模型打分） */
  rerank: z.object({ mode: z.enum(['embedding', 'llm']).optional(), weight: z.number().min(0).max(1).optional() }).optional(),
})

export const searchGraphRoute = new Hono().post('/search', async (c) => {
  let parsed: z.infer<typeof SearchBodySchema>
  try {
    parsed = SearchBodySchema.parse(await c.req.json())
  } catch (e: any) {
    return c.json({ code: 400, success: false, message: `参数校验失败: ${e.message}`, data: null }, 400)
  }
  try {
    const result = await searchGraph({
      query: parsed.query,
      knowledgeBaseId: parsed.knowledgeBaseId,
      topK: parsed.topK,
      neighborDepth: parsed.neighborDepth,
      minScore: parsed.minScore,
      excludeRelationTypes: parsed.excludeRelationTypes,
      strictRelevance: parsed.strictRelevance,
      rerank: parsed.rerank,
    })
    return c.json({
      code: 200,
      success: true,
      message: 'ok',
      data: {
        triplets: result.triplets.map((t) => ({
          source: t.source.name,
          relation: t.relation,
          target: t.target.name,
          score: t.score,
          sourceDocumentIds: [
            ...new Set([
              ...(t.source.properties?.sourceDocumentIds as string[] | undefined ?? []),
              ...(t.target.properties?.sourceDocumentIds as string[] | undefined ?? []),
            ]),
          ],
        })),
        context: result.context,
        entityCount: result.entityCount,
        edgeCount: result.edgeCount,
        sourceChunks: result.sourceChunks ?? [],
        entityCards: result.entityCards ?? [],
        explanation: {
          seeds: result.explanation.seeds.map((s) => s.name),
          candidateCount: result.explanation.candidateCount,
          durationMs: result.explanation.durationMs,
          traceId: result.explanation.traceId,
        },
      },
    })
  } catch (e: any) {
    return c.json({ code: 500, success: false, message: e.message || '图检索失败', data: null }, 500)
  }
})
