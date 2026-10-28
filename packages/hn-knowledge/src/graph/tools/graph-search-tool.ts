import { getDatabaseSchema } from '../../config/env.js'
import { createTool } from '../../utils/create-tool.js'
import type { RuntimeContext } from '../../utils/runtime-context.js'
import { z } from 'zod'
import { getGraphAdapter } from '../pg-adapter/index.js'
import { graphSearch } from '../pipeline/search.js'
import { createGraphTracePersister } from '../retrieval/trace-persister.js'
import { appendRetrievalTraceId, getOrCreateTraceId, logRagTrace } from '../../utils/rag-trace-logger.js'

export interface GraphSearchToolOptions {
  /** 图空间 ID（如 kb_yingdao_openapi）；不传则检索全图 */
  knowledgeBaseId?: string
  /** PG schema，默认取 DATABASE_SCHEMA */
  schemaName?: string
  /** 单次检索超时，默认 20 秒 */
  timeoutMs?: number
  /** 边推理（LLM 解释每条边为何相关），默认关闭以控制延迟 */
  reason?: { enabled: boolean }
}

const GraphSearchInputSchema = z.object({
  query: z.string().describe('搜索查询，描述需要查找的实体关系或需要关联分析的多个概念'),
  topK: z.number().int().positive().optional().default(10).describe('返回的关系数量，默认 10'),
  neighborDepth: z.number().int().positive().optional().default(2).describe('实体邻域搜索深度，默认 2'),
})

/**
 * 创建知识图谱搜索工具（对标 TrustGraph GraphRAG 检索腿的 Agent 接入）
 *
 * - 一站式走 graphSearch：查询嵌入（与摄入同一通道）→ 概念分解 → 邻域投影 →
 *   rerank 精排 → 文档/chunk 溯源回链 → 边推理（可选）
 * - persistExplanation：检索解释持久化为 trace 图节点，答案可经 updateTraceAnswer 回填
 * - 错误不抛出：返回 error 字段，agent 可看到错误后继续回答
 */
export function createGraphSearchTool(options?: GraphSearchToolOptions) {
  const timeoutMs = options?.timeoutMs ?? 20_000
  return createTool({
    id: 'graph-search',
    description:
      '在知识图谱中搜索实体之间的关系。适合回答需要理解多个概念之间关联、跨文档多跳推理的复杂问题，比如"XXX和YYY有什么关系"、"哪些功能依赖某个服务"。返回实体之间的三元组关系、关联原因与来源文档。',
    inputSchema: GraphSearchInputSchema,
    outputSchema: z.object({
      triplets: z
        .array(
          z.object({
            source: z.string().describe('源实体名称'),
            sourceType: z.string().describe('源实体类型'),
            relation: z.string().describe('关系类型'),
            target: z.string().describe('目标实体名称'),
            targetType: z.string().describe('目标实体类型'),
            score: z.number().describe('相关性分数 (0-1)'),
            reason: z.string().optional().describe('该关系与查询的关联逻辑（边推理，启用 reason 时返回）'),
            sourceDocumentIds: z.array(z.string()).optional().describe('来源文档 ID（溯源）'),
          })
        )
        .describe('搜索到的三元组列表'),
      sourceChunks: z
        .array(
          z.object({
            chunkId: z.string(),
            documentId: z.string(),
            chunkIndex: z.number(),
            content: z.string(),
          })
        )
        .optional()
        .describe('三元组命中的 chunk 原文片段（溯源回链）'),
      context: z.string().describe('三元组聚合后的文本上下文，可直接用于回答'),
      entityCount: z.number().describe('涉及的实体数量'),
      retrievalDebug: z
        .object({
          seeds: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })),
          durationMs: z.number(),
          traceId: z.string().optional().describe('检索解释 trace 节点 ID，用于答案回填审计'),
        })
        .optional()
        .describe('检索排查信息，不应直接面向用户展示'),
      error: z.string().optional().describe('错误信息；存在该字段表示检索失败，回答时应提示图谱搜索暂不可用'),
    }),
    execute: async (toolCall: any) => {
      // 兼容两种调用形态：agent 运行时传 { context, runtimeContext }，直接调用传裸数据
      const context = toolCall?.context ?? toolCall ?? {}
      const runtimeContext = toolCall?.runtimeContext as RuntimeContext | undefined
      const traceId = getOrCreateTraceId(runtimeContext)
      const startTime = Date.now()

      try {
        const schemaName = options?.schemaName || getDatabaseSchema()
        const graphAdapter = getGraphAdapter(schemaName)

        logRagTrace({
          traceId,
          step: 'retrieval_start',
          input: { query: context.query, topK: context.topK ?? 10, knowledgeBaseId: options?.knowledgeBaseId },
          runtimeContext,
          metadata: { tool: 'knowledge-graph-search' },
        })

        // 超时保护：LLM 精排/边推理可能慢，超时后 agent 仍可基于其他工具继续回答
        let timeoutId: NodeJS.Timeout | null = null
        const result = await Promise.race([
          graphSearch(graphAdapter, {
            query: context.query,
            topK: context.topK ?? 10,
            neighborDepth: context.neighborDepth ?? 2,
            knowledgeBaseId: options?.knowledgeBaseId,
            reason: options?.reason,
            persistExplanation: createGraphTracePersister(graphAdapter),
          }),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`知识图谱搜索超时（${timeoutMs / 1000}秒）`)), timeoutMs)
          }),
        ]).finally(() => {
          if (timeoutId) clearTimeout(timeoutId)
        })

        const output = {
          triplets: result.triplets.map((t, i) => ({
            source: t.source.name,
            sourceType: t.source.type,
            relation: t.relation,
            target: t.target.name,
            targetType: t.target.type,
            score: t.score,
            reason: result.explanation.focus[i]?.reason,
            sourceDocumentIds: result.explanation.focus[i]?.sourceDocumentIds,
          })),
          sourceChunks: result.sourceChunks?.length ? result.sourceChunks : undefined,
          context: result.context,
          entityCount: result.entityCount,
          retrievalDebug: {
            seeds: result.explanation.seeds,
            durationMs: result.explanation.durationMs,
            traceId: result.explanation.traceId,
          },
        }
        if (result.explanation.traceId) appendRetrievalTraceId(runtimeContext, result.explanation.traceId)

        logRagTrace({
          traceId,
          step: 'retrieval_finish',
          input: { query: context.query, knowledgeBaseId: options?.knowledgeBaseId },
          output: {
            total: output.triplets.length,
            traceId: output.retrievalDebug.traceId,
          },
          runtimeContext,
          metadata: { tool: 'knowledge-graph-search', durationMs: Date.now() - startTime },
        })

        return output
      } catch (error: any) {
        console.error('[GraphSearchTool] 执行失败:', error.message)
        logRagTrace({
          traceId,
          step: 'retrieval_failed',
          input: { query: context.query, knowledgeBaseId: options?.knowledgeBaseId },
          output: { error: error.message },
          runtimeContext,
          metadata: { tool: 'knowledge-graph-search', durationMs: Date.now() - startTime },
        })
        return {
          triplets: [],
          context: '',
          entityCount: 0,
          error: `知识图谱搜索失败: ${error.message}`,
        }
      }
    },
  })
}

/** 默认知识图谱搜索工具实例（向后兼容） */
export const graphSearchTool = createGraphSearchTool()
