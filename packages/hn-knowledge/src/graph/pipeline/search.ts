/**
 * 一站式图检索：查询文本 → 嵌入 → 检索（终端用户不接触向量细节）
 */
import { defaultEmbedFn } from '../extraction/index.js'
import { GraphCompletionRetriever } from '../retrieval/graph-completion-retriever.js'
import type { CompletionResult, GraphSearchOptions } from '../retrieval/graph-completion-retriever.js'
import type { GraphDB } from '../interface.js'
import type { OntologyConfig } from '../ontology/index.js'

export interface GraphSearchInput {
  query: string
  topK?: number
  neighborDepth?: number
  knowledgeBaseId?: string
  /** 查询/边文本嵌入函数（缺省使用内置 openai embedding，走 LLM 代理） */
  embedFn?: (texts: string[]) => Promise<number[][]>
  /** rerank 精排（传入即启用；缺省嵌入函数与上面一致） */
  rerank?: GraphSearchOptions['rerank']
  /** 边推理（LLM 解释每条边为何相关），传入即启用 */
  reason?: GraphSearchOptions['reason']
  /** 概念分解（LLM 拆子查询分别检索），传入即启用 */
  decompose?: GraphSearchOptions['decompose']
  /** 检索解释持久化钩子（返回 traceId 供答案回填） */
  persistExplanation?: GraphSearchOptions['persistExplanation']
  /** 相关性分数下限（0-1）：低于阈值的边不返回（防幻觉上下文） */
  minScore?: number
  /** 排除指定关系类型（透传给检索器，如评估时排除 is_a/包含 等结构边） */
  excludeRelationTypes?: string[]
  /** 严格相关性：查询中的明确实体未命中图谱时返回空结果 */
  strictRelevance?: boolean
  /** 可选本体约束，过滤不符合 domain/range 的检索路径 */
  ontology?: OntologyConfig
}

export async function graphSearch(
  graph: GraphDB,
  input: GraphSearchInput
): Promise<CompletionResult> {
  const embedTexts = input.embedFn ?? (await defaultEmbedFn())
  const [queryEmbedding] = await embedTexts([input.query])

  const retriever = new GraphCompletionRetriever(graph)
  return retriever.searchByQuery(input.query, queryEmbedding, {
    topK: input.topK ?? 5,
    neighborDepth: input.neighborDepth ?? 2,
    knowledgeBaseId: input.knowledgeBaseId,
    queryText: input.query,
    rerank: input.rerank && {
      ...input.rerank,
      embedTexts: input.rerank.embedTexts ?? embedTexts,
    },
    persistExplanation: input.persistExplanation,
    minScore: input.minScore,
    excludeRelationTypes: input.excludeRelationTypes,
    strictRelevance: input.strictRelevance,
    ontology: input.ontology,
    reason: input.reason,
    decompose: input.decompose,
  })
}
