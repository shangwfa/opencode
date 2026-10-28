import { createTool } from '../utils/create-tool.js'
import type { RuntimeContext } from '../utils/runtime-context.js'
import { z } from 'zod'
import { getGraphAdapter } from '../graph/pg-adapter/index.js'
import { graphSearch } from '../graph/pipeline/search.js'
import { createGraphTracePersister } from '../graph/retrieval/trace-persister.js'
import { persistRetrievalTrace } from '../graph/retrieval/trace-persister.js'
import { hybridSearchService } from '../rag/knowledge-base/index.js'
import { appendRetrievalTraceId, getOrCreateTraceId, logRagTrace } from '../utils/rag-trace-logger.js'
import { contentHash, type RetrievalEvidence } from '../graph/retrieval/evidence.js'

export interface UnifiedSearchToolOptions {
  /** 图空间 ID（如 kb_yingdao_openapi）；不传则检索全图 */
  graphKbId?: string
  /** 文档知识库 ID */
  documentKbId?: string
  /** PG schema，默认取 DATABASE_SCHEMA */
  schemaName?: string
  /** 单路检索超时，默认 20 秒 */
  timeoutMs?: number
}

const RRF_K = 60

type BranchStatus = 'success' | 'failed' | 'timeout' | 'skipped'

interface Evidence {
  evidenceId: string
  key: string
  text: string
  source: 'graph' | 'document'
  documentId?: string
  chunkIndex?: number
  relation?: string
  reason?: string
}

class BranchTimeoutError extends Error {
  constructor(branch: string) {
    super(`${branch} 检索超时`)
    this.name = 'BranchTimeoutError'
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, branch: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BranchTimeoutError(branch)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** RRF 融合：只按排名打分，跨形态分数不可比的问题由无纲量排名规避 */
function reciprocalRankFusion(branchResults: Evidence[][]): Array<Evidence & { score: number }> {
  const merged = new Map<string, { item: Evidence; score: number }>()
  for (const items of branchResults) {
    items.forEach((item, rank) => {
      const rrfScore = 1 / (RRF_K + rank + 1)
      const current = merged.get(item.key)
      if (current) {
        current.score += rrfScore
      } else {
        merged.set(item.key, { item, score: rrfScore })
      }
    })
  }
  return [...merged.values()]
    .sort((left, right) => right.score - left.score)
    .map(({ item, score }) => ({ ...item, score }))
}

/**
 * 创建统一检索工具（对标 TrustGraph 三条检索腿的融合兜底）：
 * 知识图谱路（graphSearch）∥ 文档混合路（vector+keyword RRF，HybridSearchService）
 * 两路并发 + 单路超时降级 + RRF 融合排序。
 */
export function createUnifiedSearchTool(options?: UnifiedSearchToolOptions) {
  const timeoutMs = options?.timeoutMs ?? 20_000
  return createTool({
    id: 'unified-search',
    description:
      '统一检索兜底工具：同时查询知识图谱与文档知识库并返回带 evidenceId 的证据。回答中的每个可验证事实必须使用 [evidenceId] 引用对应证据。',
    inputSchema: z.object({
      query: z.string().describe('搜索查询字符串'),
      topK: z.number().int().positive().optional().default(10).describe('融合后返回的结果数量，默认 10'),
    }),
    outputSchema: z.object({
      results: z
        .array(
          z.object({
            text: z.string().describe('证据文本：图关系行或文档原文片段'),
            evidenceId: z.string().describe('证据 ID，回答事实时使用 [evidenceId] 引用'),
            score: z.number().describe('RRF 融合分数（仅用于排序，不表示绝对相关性）'),
            source: z.enum(['graph', 'document']).describe('证据来源：graph=知识图谱关系，document=文档原文'),
            documentId: z.string().optional().describe('来源文档 ID（溯源）'),
            chunkIndex: z.number().optional().describe('块索引'),
            relation: z.string().optional().describe('图关系类型（仅 graph 来源）'),
            reason: z.string().optional().describe('该关系与查询的关联逻辑（仅 graph 来源，启用边推理时）'),
          })
        )
        .describe('融合排序后的证据列表'),
      total: z.number().describe('结果总数'),
      degraded: z.boolean().describe('是否存在检索分支降级（超时或失败被跳过）'),
      retrievalDebug: z
        .object({
          graph: z
            .object({
              status: z.string(),
              tripletCount: z.number(),
              entityCount: z.number(),
              durationMs: z.number(),
              traceId: z.string().optional(),
            })
            .optional(),
          document: z.object({ status: z.string(), resultCount: z.number(), durationMs: z.number() }).optional(),
        })
        .optional()
        .describe('分支排查信息，不应直接面向用户展示'),
      error: z
        .string()
        .optional()
        .describe('错误信息；存在该字段表示检索失败，回答时应提示统一检索暂不可用'),
    }),
    execute: async (toolCall: any) => {
      // 兼容两种调用形态：agent 运行时传 { context, runtimeContext }，直接调用传裸数据
      const context = toolCall?.context ?? toolCall ?? {}
      const runtimeContext = toolCall?.runtimeContext as RuntimeContext | undefined
      const traceId = getOrCreateTraceId(runtimeContext)
      const startTime = Date.now()
      const topK = context.topK ?? 10
      const recallTopK = topK * 2

      logRagTrace({
        traceId,
        step: 'retrieval_start',
        input: { query: context.query, topK, graphKbId: options?.graphKbId, documentKbId: options?.documentKbId },
        runtimeContext,
        metadata: { tool: 'unified-search' },
      })

      // 图谱适配器在分支外创建，确保图分支失败时仍能写 unified trace。
      const schemaName = options?.schemaName || process.env.DATABASE_SCHEMA?.replace(/['"]/g, '') || 'test'
      const graphAdapter = getGraphAdapter(schemaName)
      const graphPromise = (async () => {
        const startedAt = Date.now()
        const result = await graphSearch(graphAdapter, {
          query: context.query,
          topK: recallTopK,
          neighborDepth: 2,
          knowledgeBaseId: options?.graphKbId,
          persistExplanation: createGraphTracePersister(graphAdapter),
        })
        const evidence: Evidence[] = result.triplets.map((t, i) => ({
          evidenceId: `ev:${traceId}:graph:${i + 1}`,
          key: `${t.source.id}|${t.relation}|${t.target.id}`,
          text: result.explanation.focus[i]?.reason
            ? `[${t.source.name}] --[${t.relation}]--> [${t.target.name}]（关联：${result.explanation.focus[i]!.reason}）`
            : `[${t.source.name}] --[${t.relation}]--> [${t.target.name}]`,
          source: 'graph' as const,
          documentId: result.explanation.focus[i]?.sourceDocumentIds?.[0],
          relation: t.relation,
          reason: result.explanation.focus[i]?.reason,
        }))
        return {
          evidence,
          graphAdapter,
          debug: {
            status: 'success' as BranchStatus,
            tripletCount: result.triplets.length,
            entityCount: result.entityCount,
            durationMs: Date.now() - startedAt,
            traceId: result.explanation.traceId,
          },
        }
      })()

      // 文档混合路（vector+keyword 已在服务内融合）
      const documentPromise = (async () => {
        if (!options?.documentKbId) {
          return { evidence: [] as Evidence[], debug: { status: 'skipped' as BranchStatus, resultCount: 0, durationMs: 0 } }
        }
        const startedAt = Date.now()
        const items = await hybridSearchService.search(options.documentKbId, context.query, {
          topK: recallTopK,
          fusionMethod: 'rrf' as const,
        })
        const evidence: Evidence[] = items.map((item) => ({
          evidenceId: `ev:${getOrCreateTraceId(runtimeContext)}:document:${item.id}`,
          key: `doc:${item.id}`,
          text: item.text,
          source: 'document' as const,
          documentId: item.documentId,
          chunkIndex: item.chunkIndex,
        }))
        return {
          evidence,
          debug: { status: 'success' as BranchStatus, resultCount: items.length, durationMs: Date.now() - startedAt },
        }
      })()

      const [graphSettled, documentSettled] = await Promise.allSettled([
        withTimeout(graphPromise, timeoutMs, '知识图谱'),
        withTimeout(documentPromise, timeoutMs, '文档'),
      ])

      const unwrap = <T>(settled: PromiseSettledResult<T>): { value: T | null; error?: string } => {
        if (settled.status === 'fulfilled') return { value: settled.value }
        const message = settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
        return { value: null, error: message }
      }

      const graph = unwrap(graphSettled)
      const document = unwrap(documentSettled)
      // skipped（未配置 documentKbId）是配置状态而非运行时降级
      const degraded = !!(graph.error || document.error)

      // 两路全部失败才报错；单路失败降级用另一路
      if (!graph.value && !document.value) {
        const message = `知识图谱与文档检索均失败：${graph.error ?? ''}；${document.error ?? ''}`
        console.error('[UnifiedSearchTool]', message)
        try {
          const failedTraceId = await persistRetrievalTrace(graphAdapter, {
            queryText: context.query,
            knowledgeBaseId: options?.graphKbId,
            source: 'unified',
            stages: { graph: { error: graph.error }, document: { error: document.error } },
            evidence: [],
          })
          appendRetrievalTraceId(runtimeContext, failedTraceId)
        } catch { /* 审计失败不阻塞错误返回 */ }
        logRagTrace({
          traceId,
          step: 'retrieval_failed',
          input: { query: context.query },
          output: { error: message },
          runtimeContext,
          metadata: { tool: 'unified-search', durationMs: Date.now() - startTime },
        })
        return { results: [], total: 0, degraded, error: `统一检索失败: ${message}` }
      }

      const branchResults: Evidence[][] = []
      if (graph.value) branchResults.push(graph.value.evidence)
      if (document.value?.evidence.length) branchResults.push(document.value.evidence)
      const fused = reciprocalRankFusion(branchResults).slice(0, topK)

      const output = {
        results: fused.map((item) => ({
          evidenceId: item.evidenceId,
          text: item.text,
          score: item.score,
          source: item.source,
          documentId: item.documentId,
          chunkIndex: item.chunkIndex,
          relation: item.relation,
          reason: item.reason,
        })),
        total: fused.length,
        degraded,
        retrievalDebug: {
          graph: graph.value
            ? {
                status: graph.value.debug.status,
                tripletCount: graph.value.debug.tripletCount,
                entityCount: graph.value.debug.entityCount,
                durationMs: graph.value.debug.durationMs,
                traceId: graph.value.debug.traceId,
              }
            : { status: 'failed' as BranchStatus, tripletCount: 0, entityCount: 0, durationMs: 0, error: graph.error },
          document: document.value
            ? document.value.debug
            : { status: 'failed' as BranchStatus, resultCount: 0, durationMs: 0 },
        },
      }

      if (graph.value?.graphAdapter) {
        try {
          const unifiedTraceId = await persistRetrievalTrace(graph.value.graphAdapter, {
            queryText: context.query,
            knowledgeBaseId: options?.graphKbId,
            source: 'unified',
            stages: { graph: output.retrievalDebug.graph, document: output.retrievalDebug.document },
            evidence: fused.map((item, index): RetrievalEvidence => ({
              evidenceId: item.evidenceId,
              sourceType: item.source,
              content: item.text,
              contentHash: contentHash(item.text),
              documentId: item.documentId,
              chunkIndex: item.chunkIndex,
              retrieval: { rank: index + 1, score: item.score, method: 'unified-rrf' },
            })),
          })
          appendRetrievalTraceId(runtimeContext, unifiedTraceId)
        } catch { /* 审计失败不阻塞检索结果 */ }
      }

      logRagTrace({
        traceId,
        step: 'retrieval_finish',
        input: { query: context.query },
        output: { total: output.total, degraded },
        runtimeContext,
        metadata: { tool: 'unified-search', durationMs: Date.now() - startTime },
      })

      return output
    },
  })
}

/** 默认统一检索工具实例（向后兼容） */
export const unifiedSearchTool = createUnifiedSearchTool()
