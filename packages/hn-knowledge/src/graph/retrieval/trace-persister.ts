import { randomUUID } from 'crypto'
import type { GraphDB } from '../interface.js'
import type { RetrievalExplanation } from '../types.js'
import type { AnswerClaim, EvidenceCoverage, RetrievalEvidence } from './evidence.js'

export interface TracePersistContext {
  queryText?: string
  knowledgeBaseId?: string
  evidence?: RetrievalEvidence[]
}

/**
 * 检索解释持久化钩子（对标 TrustGraph 检索 provenance 持久化，tg-show-explain-trace 的等价能力）
 *
 * 检索器在每次 search 结束时调用；实现方可将解释写入任意存储。
 * 返回 traceId（可回传给 updateTraceAnswer 做答案回填），无持久化需求时返回 void。
 */
export type ExplanationPersister = (
  explanation: RetrievalExplanation,
  context: TracePersistContext
) => Promise<string | void>

/** retrieval_trace 节点的 type 标识 */
export const RETRIEVAL_TRACE_NODE_TYPE = 'retrieval_trace'
/** retrieval trace 的物理 named graph 名称。 */
export const RETRIEVAL_GRAPH_NAME = 'urn:graph:retrieval'
const LEGACY_RETRIEVAL_KB_PREFIX = '__retrieval__:'

export function retrievalKnowledgeBaseId(knowledgeBaseId?: string): string {
  return `${LEGACY_RETRIEVAL_KB_PREFIX}${knowledgeBaseId || 'global'}`
}

/**
 * 非关系型适配器的兼容实现：把检索解释写为 retrieval_trace 类型节点。
 * PostgreSQL 适配器会优先写入独立的 graph_retrieval_traces 表。
 *
 * 节点 properties 结构：
 * - kind: 'retrieval_trace'
 * - queryText: 原始查询文本
 * - explanation: 完整解释结构（seeds/focus/rerank/耗时/answer 等）
 *
 * 返回 traceId，供下游 LLM 生成答案后调用 updateTraceAnswer() 回填
 * （对标 TrustGraph Synthesis 阶段：答案与所用边关联持久化）。
 *
 * 后续可用 listRetrievalTraces() 查询，实现事后审计与检索行为回放。
 */
export function createGraphTracePersister(graph: GraphDB): ExplanationPersister {
  return async (explanation, context) => {
    const queryLabel = (context.queryText || explanation.focus[0]?.source || '未知查询').slice(0, 80)
    const id = randomUUID()
    if (graph.storeRetrievalTrace) {
      await graph.storeRetrievalTrace({
        id,
        knowledgeBaseId: context.knowledgeBaseId,
        source: 'graph',
        queryText: context.queryText || queryLabel,
        payload: { graphName: RETRIEVAL_GRAPH_NAME, explanation },
        evidence: context.evidence,
      })
      return id
    }
    await graph.addNode({
      id,
      knowledgeBaseId: retrievalKnowledgeBaseId(context.knowledgeBaseId),
      name: `检索: ${queryLabel}`,
      type: RETRIEVAL_TRACE_NODE_TYPE,
      properties: {
        kind: RETRIEVAL_TRACE_NODE_TYPE,
        graphName: RETRIEVAL_GRAPH_NAME,
        queryText: context.queryText || null,
        explanation,
        evidence: context.evidence || [],
      },
      frequency: 0,
    })
    return id
  }
}

/**
 * 持久化非 GraphRAG 分支（Document RAG / Agent）的统一检索记录。
 * PostgreSQL 中写入独立 retrieval named graph，其他适配器走兼容节点存储。
 */
export async function persistRetrievalTrace(
  graph: GraphDB,
  input: {
    queryText: string
    knowledgeBaseId?: string
    source: 'document' | 'agent' | 'unified'
    stages: unknown
    evidence?: RetrievalEvidence[]
  },
): Promise<string> {
  const id = randomUUID()
  if (graph.storeRetrievalTrace) {
    await graph.storeRetrievalTrace({
      id,
      knowledgeBaseId: input.knowledgeBaseId,
      source: input.source,
      queryText: input.queryText,
      payload: { graphName: RETRIEVAL_GRAPH_NAME, stages: input.stages },
      evidence: input.evidence,
    })
    return id
  }
  await graph.addNode({
    id,
    knowledgeBaseId: retrievalKnowledgeBaseId(input.knowledgeBaseId),
    name: `检索: ${input.queryText.slice(0, 80)}`,
    type: RETRIEVAL_TRACE_NODE_TYPE,
      properties: {
      kind: RETRIEVAL_TRACE_NODE_TYPE,
      graphName: RETRIEVAL_GRAPH_NAME,
      queryText: input.queryText,
      source: input.source,
        stages: input.stages,
        evidence: input.evidence || [],
    },
    frequency: 0,
  })
  return id
}

/**
 * 答案回填（对标 TrustGraph Synthesis 溯源：最终答案与所用边关联持久化）
 *
 * 下游 LLM 生成答案后调用，把答案写回对应 trace 节点的解释结构，
 * 形成"问题 → 选中边(含理由) → 答案"的完整可审计闭环。
 */
export async function updateTraceAnswer(
  graph: GraphDB,
  traceId: string,
  answer: string,
  claims?: AnswerClaim[],
  metrics?: EvidenceCoverage
): Promise<void> {
  if (graph.updateRetrievalTraceAnswer) {
    await graph.updateRetrievalTraceAnswer(traceId, answer, claims, metrics)
    return
  }
  const node = await graph.getNode(traceId)
  if (!node) {
    console.warn(`[检索追踪] 回填答案失败：trace 节点 ${traceId} 不存在`)
    return
  }
  const explanation = node.properties.explanation as RetrievalExplanation | undefined
  if (explanation) explanation.answer = answer
  await graph.updateNode(traceId, {
    properties: {
      ...node.properties,
      ...(explanation ? { explanation } : {}),
      answer,
      ...(claims ? { claims } : {}),
      ...(metrics ? { evidenceMetrics: metrics } : {}),
    },
  })
}

/**
 * 列出检索追踪节点（新→旧）
 */
export async function listRetrievalTraces(
  graph: GraphDB,
  knowledgeBaseId?: string,
  limit = 50
): Promise<Array<{
  id: string
  name: string
  createdAt: Date
  source?: 'graph' | 'document' | 'agent' | 'unified'
  explanation?: RetrievalExplanation
  stages?: unknown
  answer?: string
  claims?: AnswerClaim[]
  evidenceMetrics?: EvidenceCoverage
}>> {
  if (graph.listRetrievalTraces) {
    const rows = await graph.listRetrievalTraces(knowledgeBaseId, limit)
    return rows.map((row) => ({
      id: row.id,
      name: `检索: ${row.queryText.slice(0, 80)}`,
      createdAt: row.createdAt,
      source: row.source as 'graph' | 'document' | 'agent' | 'unified',
      explanation: row.payload?.explanation,
      stages: row.payload?.stages,
      answer: row.answer || row.payload?.answer,
      claims: row.payload?.claims,
      evidenceMetrics: row.payload?.evidenceMetrics,
    }))
  }
  const nodes = await graph.findNodesByType(
    RETRIEVAL_TRACE_NODE_TYPE,
    knowledgeBaseId ? retrievalKnowledgeBaseId(knowledgeBaseId) : undefined,
  )
  // 兼容逻辑命名空间上线前写入的 trace，避免升级后历史审计记录消失。
  const legacyNodes = await graph.findNodesByType(
    RETRIEVAL_TRACE_NODE_TYPE,
    knowledgeBaseId ? knowledgeBaseId : '__traces__',
  )
  const allNodes = [...new Map([...nodes, ...legacyNodes].map((node) => [node.id, node])).values()]
  return allNodes
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit)
    .map((n) => ({
      id: n.id,
      name: n.name,
      createdAt: n.createdAt,
      source: n.properties.source as 'graph' | 'document' | 'agent' | 'unified' | undefined,
      explanation: (n.properties.explanation || undefined) as RetrievalExplanation | undefined,
      stages: n.properties.stages,
      answer: (n.properties.answer || undefined) as string | undefined,
      claims: n.properties.claims as AnswerClaim[] | undefined,
      evidenceMetrics: n.properties.evidenceMetrics as EvidenceCoverage | undefined,
    }))
    .filter((t) => t.explanation !== undefined || t.stages !== undefined)
}

// ============================================================
// 审计链贯通查询（对标 TrustGraph 两层连接：answer → edge → chunk → document）
// ============================================================

export interface EdgeProvenanceRef {
  sourceId: string
  targetId: string
  relationshipName: string
}

export interface NodeProvenanceLink {
  nodeId: string
  nodeName: string
  documentId: string
  chunkIndex: number | null
  pageIndex: number | null
  pipelineRunId: string | null
}

export interface EdgeProvenanceChain {
  edge: EdgeProvenanceRef
  /** 文档级来源（边 properties.sourceDocumentIds 快路径） */
  documents: string[]
  /** 节点级 chunk/page 溯源（graph_document_nodes 慢路径，含页码定位） */
  nodeProvenance: NodeProvenanceLink[]
  /** 边级来源 chunk（优先 relation_chunks，避免把节点来源误归因给关系） */
  chunks: Array<{
    chunkId: string
    documentId: string
    chunkIndex: number
    content: string
  }>
}

/**
 * 沿一条知识边反查完整来源链（对标 TrustGraph 审计链：edge → subgraph → chunk → page → document）
 *
 * 双通道汇聚：
 * 1. 快路径：边 properties.sourceDocumentIds（merge 管线聚合的文档级来源）
 * 2. 慢路径：getProvenanceLinks（graph_document_nodes 的节点级 chunk/page 明细，
 *    依赖可选方法——不支持时该通道为空）
 */
export async function traceEdgeProvenance(
  graph: GraphDB,
  edge: EdgeProvenanceRef
): Promise<EdgeProvenanceChain> {
  const chain: EdgeProvenanceChain = {
    edge: { ...edge },
    documents: [],
    nodeProvenance: [],
    chunks: [],
  }

  // 快路径：边 properties 聚合的文档来源
  try {
    const edges = await graph.getEdges(edge.sourceId)
    const match = edges.find(
      (e) => e.targetId === edge.targetId && e.relationshipName === edge.relationshipName
    )
    const docIds = (match?.properties?.sourceDocumentIds as string[] | undefined)?.filter(Boolean)
    if (docIds) chain.documents = docIds
  } catch { /* 溯源缺失不抛错 */ }

  // 慢路径：节点级 chunk/page 明细（适配器不支持时跳过）
  try {
    const g = graph as any
    if (typeof g.getProvenanceLinks === 'function') {
      const links = await g.getProvenanceLinks([edge.sourceId, edge.targetId])
      const nameCache = new Map<string, string>()
      for (const link of links) {
        if (!nameCache.has(link.nodeId)) {
          const node = await graph.getNode(link.nodeId).catch(() => null)
          nameCache.set(link.nodeId, node?.name || link.nodeId)
        }
        chain.nodeProvenance.push({
          nodeId: link.nodeId,
          nodeName: nameCache.get(link.nodeId)!,
          documentId: link.documentId,
          chunkIndex: link.chunkIndex,
          pageIndex: link.pageIndex,
          pipelineRunId: link.pipelineRunId,
        })
      }
    }
  } catch { /* 溯源缺失不抛错 */ }

  // 关系级慢路径：直接查询 relation_chunks，再回查 chunk 原文。
  // 这比仅依赖 sourceDocumentIds 或端点节点来源更精确。
  try {
    const tracker = (graph as any).chunkTracker
    const chunkStore = graph as any
    if (tracker?.getRelationChunks && typeof chunkStore.getDocumentChunks === 'function') {
      const chunkIds = await tracker.getRelationChunks(edge.sourceId, edge.targetId, edge.relationshipName)
      if (chunkIds.length > 0) {
        chain.chunks = await chunkStore.getDocumentChunks(chunkIds)
      }
    }
  } catch { /* 关系级溯源缺失不影响其他来源链 */ }

  return chain
}
