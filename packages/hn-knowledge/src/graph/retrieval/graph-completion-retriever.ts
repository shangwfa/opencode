import type { GraphDB } from '../interface.js'
import { getDefaultChatModel } from '../../config/env.js'
import type {
  GraphNode,
  TripletRerankOptions,
  RetrievalExplanation,
  Triplet,
  TripletSearchInput,
  EdgeReasonOptions,
  DecomposeOptions,
} from '../types.js'
import { generateObject } from 'ai'
import { z } from 'zod'
import { resolveModel } from '../../utils/model-resolver.js'
import { CogneeGraph } from '../knowledge-graph/cognee-graph.js'
import { TripletReranker } from './reranker.js'
import { EdgeReasoner } from './edge-reasoner.js'
import type { ExplanationPersister } from './trace-persister.js'
import { contentHash, type RetrievalEvidence } from './evidence.js'
import { OntologyValidator } from '../ontology/index.js'
import type { OntologyConfig } from '../ontology/index.js'

/** 词面通道在排序融合中的权重（对标 hybrid search 的 lexical 信号占比） */
const LEXICAL_WEIGHT = 0.35
/** RRF 常数（与 TripletReranker 一致，抑制排名靠后项的贡献波动） */
const LEXICAL_RRF_K = 60

/** 单实体词面分：1=查询提到实体名（≥3 字，特异性强）；0.5=两字品牌/通用词（如“影刀”）；0.8=实体名的连续 3 字片段出现在查询中（如“深度捕获元素”↔“使用深度捕获”） */
function entityLexicalScore(name: string, normalizedQuery: string): number {
  const normalized = name.replace(/\s+/g, '').toLowerCase()
  if (normalized.length < 2) return 0
  if (normalizedQuery.includes(normalized)) return normalized.length >= 3 ? 1 : 0.5
  if (normalized.length >= 3) {
    for (let i = 0; i + 3 <= normalized.length; i++) {
      if (normalizedQuery.includes(normalized.slice(i, i + 3))) return 0.8
    }
  }
  return 0
}

/**
 * 词面通道与现有排序做 RRF 融合：embedding rerank 分数存在 API 级波动导致边界排名抖动，
 * 词面命中是确定性信号，融合后查询明确提到的实体边稳定占据前排（hybrid 检索的 lexical 通道）。
 * 只调整顺序，不写回 score：score 保持置信度语义（minScore 阈值与展示依赖它）。
 */
function applyLexicalFusion(triplets: Triplet[], queryText?: string): Triplet[] {
  if (!queryText || triplets.length <= 1) return triplets
  const normalizedQuery = queryText.replace(/\s+/g, '').toLowerCase()
  if (!normalizedQuery) return triplets
  const lexicalOrder = triplets
    .map((triplet, index) => ({
      index,
      score: entityLexicalScore(triplet.source.name, normalizedQuery) + entityLexicalScore(triplet.target.name, normalizedQuery),
    }))
    .sort((a, b) => b.score - a.score)
  const lexicalRank = new Array<number>(triplets.length)
  lexicalOrder.forEach((entry, rank) => { lexicalRank[entry.index] = rank })
  return triplets
    .map((triplet, currentRank) => ({
      triplet,
      fusedScore: (1 - LEXICAL_WEIGHT) / (LEXICAL_RRF_K + currentRank + 1) + LEXICAL_WEIGHT / (LEXICAL_RRF_K + lexicalRank[currentRank] + 1),
    }))
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .map((fused) => fused.triplet)
}

export interface CompletionResult {
  triplets: Triplet[]
  context: string
  entityCount: number
  edgeCount: number
  /** 检索解释（grounding → exploration → focus），始终生成，便于调试与前端可视化 */
  explanation: RetrievalExplanation
  /** 命中的 chunk 原文（适配器支持时返回） */
  sourceChunks?: Array<{ chunkId: string; documentId: string; chunkIndex: number; content: string }>
  /** 实体卡：查询锚点/低度节点的名称+描述（description-only 知识的检索出口，不依赖边） */
  entityCards?: Array<{ name: string; type: string; description: string; origin: 'anchor' | 'low-degree' }>
}

export interface GraphSearchOptions {
  topK: number
  neighborDepth: number
  scoreThreshold?: number
  knowledgeBaseId?: string
  /** 三元组重要性排序权重（透传给 CogneeGraph.calculateTopTripletImportances） */
  alpha?: number
  beta?: number
  gamma?: number
  /** 是否注入节点反馈权重（positive-negative）参与排序，默认 false */
  useFeedbackWeights?: boolean
  /** 只返回指定关系，适合“有哪些功能/依赖哪些服务”等定向问题 */
  relationTypes?: string[]
  /** 排除指定关系，默认始终排除 is_a */
  excludeRelationTypes?: string[]
  /** 限定关系源实体名称，避免返回邻域中的反向或无关主体 */
  sourceNames?: string[]
  /** 限定关系目标实体名称 */
  targetNames?: string[]
  sourceTypes?: string[]
  targetTypes?: string[]
  /** rerank 精排（对标 TrustGraph cross-encoder rerank），传入即启用 */
  rerank?: TripletRerankOptions
  /** 相关性分数下限（0-1）：低于阈值的边不进结果与上下文（对标 TrustGraph MIN_RECALL_SCORE） */
  minScore?: number
  /** 查询包含明确实体时，限制结果必须连接该实体；无实体锚点的严格查询返回空结果 */
  strictRelevance?: boolean
  /** 原始查询文本：llm 精排/边推理/分解/持久化共用 */
  queryText?: string
  /** 边推理（对标 TrustGraph edge reasoning），传入即启用 */
  reason?: EdgeReasonOptions
  /** 概念分解（对标 TrustGraph 检索步骤 1-3），传入即启用 */
  decompose?: DecomposeOptions
  /** 检索解释持久化钩子（对标 TrustGraph 检索 provenance 审计），传入即启用 */
  persistExplanation?: ExplanationPersister
  /** ontology-aware retrieval：按关系 kind、domain、range 和继承关系过滤候选边 */
  ontology?: OntologyConfig
}

/** 结构化节点类型：不参与语义种子选择 */
const STRUCTURAL_NODE_TYPES = ['code_file', 'code_module', 'code_class', 'code_function', 'code_repository']

export class GraphCompletionRetriever {
  private graph: GraphDB

  constructor(graph: GraphDB) {
    this.graph = graph
  }

  async search(
    queryEmbedding: number[],
    options: GraphSearchOptions
  ): Promise<CompletionResult> {
    const startedAt = new Date()
    const startTime = Date.now()

    // 概念分解模式（对标 TrustGraph 步骤 1-3）：LLM 拆问题 → 子查询独立检索 → 去重合并
    if (options.decompose && options.decompose.enabled !== false) {
      return this.searchWithDecomposition(queryEmbedding, options, { startedAt, startTime })
    }

    return this.searchSingle(queryEmbedding, options, { startedAt, startTime })
  }

  /** 单查询检索：种子 → 邻域投影 → 重要性候选 → 统一收尾 */
  private async searchSingle(
    queryEmbedding: number[],
    options: GraphSearchOptions,
    timing: { startedAt: Date; startTime: number }
  ): Promise<CompletionResult> {
    const { topK, knowledgeBaseId } = options
    const retrieved = await this.retrieveCandidates(queryEmbedding, options)

    if (retrieved.seedNodes.length === 0) {
      return {
        triplets: [],
        context: '',
        entityCount: 0,
        edgeCount: 0,
        explanation: {
          seeds: [],
          projectedNodeCount: 0,
          candidateCount: 0,
          filteredCount: 0,
          focus: [],
          filtersApplied: describeFilters(options),
          startedAt: timing.startedAt.toISOString(),
          durationMs: Date.now() - timing.startTime,
        },
      }
    }

    return this.finalize(retrieved, queryEmbedding, options, timing)
  }

  /**
   * 概念分解检索（对标 TrustGraph 检索步骤 1-3）：
   * LLM 把问题拆为子查询 → 各子查询独立嵌入（可退化复用原向量）→
   * 逐子查询检索候选 → 跨子查询去重合并 → 统一 rerank/收尾
   */
  private async searchWithDecomposition(
    queryEmbedding: number[],
    options: GraphSearchOptions,
    timing: { startedAt: Date; startTime: number }
  ): Promise<CompletionResult> {
    const { topK, knowledgeBaseId } = options
    const queryText = options.queryText || options.rerank?.queryText
    const maxSubQueries = options.decompose?.maxSubQueries ?? 4

    let subQueries = [queryText || '']
    if (queryText) {
      try {
        const model = resolveModel(options.decompose?.model || getDefaultChatModel())
        const { object } = await generateObject({
          model,
          schema: DecomposeSchema,
          prompt: `将以下复杂问题分解为最多 ${maxSubQueries} 个可独立检索的子查询。每个子查询聚焦一个具体的关系或实体对，不要改写原意。\n\n问题：${queryText}`,
          temperature: 0.1,
        })
        if (object.subQueries.length > 0) subQueries = object.subQueries
      } catch (err: any) {
        console.warn(`[概念分解] LLM 分解失败（退化为单查询）: ${err.message}`)
      }
    }

    // 子查询独立向量化（对标 TrustGraph 每概念独立 embed）；失败退化复用原查询向量
    let subEmbeddings: number[][] | null = null
    if (subQueries.length > 1 && options.decompose?.embedTexts) {
      try {
        subEmbeddings = await options.decompose.embedTexts(subQueries)
      } catch { /* 退化 */ }
    }

    const allTriplets: Triplet[] = []
    const seen = new Set<string>()
    const mergedSeeds = new Map<string, RetrievalExplanation['seeds'][number]>()
    const mergedAnchors = new Map<string, GraphNode>()
    let projectedNodeCount = 0
    let candidateCount = 0

    for (let i = 0; i < subQueries.length; i++) {
      const subEmb = subEmbeddings?.[i] ?? queryEmbedding
      const retrieved = await this.retrieveCandidates(subEmb, {
        ...options,
        decompose: undefined,
        topK: Math.max(2, Math.ceil(topK / subQueries.length)),
      })
      for (const node of retrieved.seedNodes) {
        mergedSeeds.set(node.id, { id: node.id, name: node.name, type: node.type })
      }
      for (const node of retrieved.anchoredNodes) {
        mergedAnchors.set(node.id, node)
      }
      projectedNodeCount += retrieved.projectedNodeCount
      candidateCount += retrieved.candidateCount
      for (const t of retrieved.candidates) {
        const key = `${t.source.id}|${t.relation}|${t.target.id}`
        if (!seen.has(key)) {
          seen.add(key)
          allTriplets.push(t)
        }
      }
    }

    const result = await this.finalize(
      {
        seedNodes: [...mergedSeeds.values()].map((s) =>
          ({ id: s.id, knowledgeBaseId: knowledgeBaseId || '', name: s.name, type: s.type, properties: {}, frequency: 0, embedding: undefined, createdAt: new Date(), updatedAt: new Date() } as GraphNode),
        ),
        anchoredNodes: [...mergedAnchors.values()],
        projectedNodeCount,
        candidates: allTriplets,
        candidateCount,
        cogneeGraph: null,
      },
      queryEmbedding,
      options,
      timing,
      subQueries.length > 1 ? subQueries : undefined,
      // 对标 TrustGraph：预过滤与各 query concept 对齐（子话题命中的候选不被原查询向量系统性压低）
      subEmbeddings && subEmbeddings.length > 0 ? [queryEmbedding, ...subEmbeddings] : undefined
    )

    return result
  }

  /**
 * 候选构建期的词面优先排序：查询完整提到的实体（词面分更高）出边整体前置，组内保持原
 * importance 序。与 applyLexicalFusion 的分工：这里保障"召回"（明确实体边必进候选池，
 * 不被图中心实体的重要性分压制）；finalize 里的融合负责精排。稳定排序保持组内序。
 */
/** 候选检索（种子选择 → 邻域投影 → 距离映射 → 重要性打分 → 过滤） */
  private async retrieveCandidates(
    queryEmbedding: number[],
    options: GraphSearchOptions
  ): Promise<{
    seedNodes: GraphNode[]
    anchoredNodes: GraphNode[]
    projectedNodeCount: number
    candidates: Triplet[]
    candidateCount: number
    cogneeGraph: CogneeGraph | null
  }> {
    const { topK, neighborDepth, knowledgeBaseId } = options
    const cogneeGraph = new CogneeGraph()

    // 种子面扩到 topK*3（下限 12）：并列事实（如同模型多个字段）需要更大投影邻域才能同台竞争
    const seedNodes = await this.findSeedNodes(queryEmbedding, knowledgeBaseId, Math.max(topK * 3, 12))
    // 词面锚点：查询明确提到的图内实体（全图名匹配，≥3 字）。
    // strictRelevance 时作为唯一种子（无锚点返回空）；常规检索时并入 ANN 种子（hybrid lexical seed），
    // 避免"快捷键/263企业邮箱"这类明确实体被高频邻居（如"影刀*"家族）挤出种子面。
    const anchored = await this.findQueryAnchors(seedNodes, options.queryText, knowledgeBaseId)
    if (options.strictRelevance && anchored && anchored.length === 0) {
      return { seedNodes: [], anchoredNodes: [], projectedNodeCount: 0, candidates: [], candidateCount: 0, cogneeGraph: null }
    }
    const effectiveSeedNodes = options.strictRelevance
      ? (anchored && anchored.length > 0 ? anchored : [])
      : (anchored && anchored.length > 0
        ? [...new Map([...seedNodes, ...anchored].map((node) => [node.id, node])).values()]
        : seedNodes)
    if (effectiveSeedNodes.length === 0) {
      return { seedNodes: [], anchoredNodes: [], projectedNodeCount: 0, candidates: [], candidateCount: 0, cogneeGraph: null }
    }

    for (const node of effectiveSeedNodes) {
      cogneeGraph.addNode(node)
    }

    const seedIds = effectiveSeedNodes.map((n) => n.id)
    await cogneeGraph.projectNeighborhoodFromDb(this.graph, seedIds, neighborDepth, undefined, knowledgeBaseId)

    // 补齐投影后所有节点的 embedding（邻居节点也参与距离计算，对标 cognee 邻域向量距离）
    const graphNodeIds = [...cogneeGraph.nodes.keys()]
    let allProjectedNodes: GraphNode[] = []
    if (typeof (this.graph as any).getNodes === 'function' && graphNodeIds.length > 0) {
      try {
        allProjectedNodes = await this.graph.getNodes(graphNodeIds)
      } catch { /* 忽略：退回种子节点 embedding */ }
    }
    const embeddings = new Map<string, number[]>()
    const pool = allProjectedNodes.length > 0 ? allProjectedNodes : effectiveSeedNodes
    for (const node of pool) {
      if (node.embedding) {
        embeddings.set(node.id, node.embedding)
      }
    }
    cogneeGraph.mapVectorDistancesToNodes(queryEmbedding, embeddings)
    cogneeGraph.mapVectorDistancesToEdges(queryEmbedding, embeddings)

    // 反馈权重注入（可选）：拉取全部投影节点的 feedback weights 参与排序
    if (options.useFeedbackWeights) {
      const feedbackWeights = new Map<string, { positive: number; negative: number }>()
      const g = this.graph as any
      if (typeof g.getNodeFeedbackWeights === 'function') {
        for (const node of pool) {
          try {
            const w = await g.getNodeFeedbackWeights(node.id)
            if (w) feedbackWeights.set(node.id, w)
          } catch { /* 无反馈数据则跳过 */ }
        }
      }
      cogneeGraph.applyFeedbackWeights(feedbackWeights)
    }

    const candidateTopK = Math.max(topK * 4, 20)
    // 候选池构建：importance 全量排序（不预先截断，中低频实体的正确边排名再靠后也有机会）
    // → 词面优先排序（查询明确提到的实体边整体前置）。
    // 词面命中丰富（中文实体语义召回，如文档 QA）时保持语义序；词面全空（如英文 API 接口
    // 名查询）时启用分组轮转，防止字段级边洪峰（同一接口平铺的 20 个响应字段）垄断候选池。
    const importanceAll = cogneeGraph.calculateTopTripletImportances(Math.max(cogneeGraph.edges.length, candidateTopK * 4), {
      alpha: options.alpha,
      beta: options.beta,
      gamma: options.gamma,
    })
    const lexicalSorted = lexicalFirstSort(importanceAll, options.queryText)
    const hasLexicalHit = lexicalSorted.some((triplet) => tripletLexicalScore(triplet, options.queryText) > 0)
    const triplets = hasLexicalHit
      ? lexicalSorted.slice(0, candidateTopK * 2)
      : diversifyCandidates(lexicalSorted, candidateTopK)

    const ontologyFiltered = options.ontology
      ? filterByOntology(triplets, options.ontology)
      : triplets
    // 已被 functional/temporal resolver 取代的边不能进入默认用户检索上下文。
    const graphData = await this.graph.getGraphData(knowledgeBaseId)
    const superseded = new Set(graphData.edges
      .filter((edge) => edge.properties?.superseded === true)
      .map((edge) => `${edge.sourceId}|${edge.relationshipName}|${edge.targetId}`))
    const activeTriplets = ontologyFiltered.filter((triplet) => !superseded.has(`${triplet.source.id}|${triplet.relation}|${triplet.target.id}`))

    return {
      seedNodes: effectiveSeedNodes,
      anchoredNodes: anchored ?? [],
      projectedNodeCount: cogneeGraph.nodes.size,
      candidates: filterTriplets(activeTriplets, options),
      candidateCount: triplets.length,
      cogneeGraph,
    }
  }

  private async findQueryAnchors(
    seedNodes: GraphNode[],
    queryText?: string,
    knowledgeBaseId?: string
  ): Promise<GraphNode[] | null> {
    if (!queryText) return null
    let nodes = seedNodes
    try {
      const graphData = await this.graph.getGraphData(knowledgeBaseId)
      nodes = graphData.nodes
    } catch { /* 适配器不支持全图查询时退回 ANN 种子 */ }
    return selectQueryAnchors(nodes, queryText)
  }

  /** 统一收尾：rerank → 截断 → 文档回链 ∥ 边推理 → 上下文/解释构建 → 持久化 */
  private async finalize(
    retrieved: Awaited<ReturnType<GraphCompletionRetriever['retrieveCandidates']>>,
    queryEmbedding: number[],
    options: GraphSearchOptions,
    timing: { startedAt: Date; startTime: number },
    subQueries?: string[],
    referenceEmbeddings?: number[][]
  ): Promise<CompletionResult> {
    const { topK } = options
    const queryText = options.queryText || options.rerank?.queryText

    // rerank 精排（对标 TrustGraph cross-encoder rerank）：失败自动降级原排序
    let ranked = retrieved.candidates
    let rerankInfo: RetrievalExplanation['rerank']
    if (options.rerank && options.rerank.enabled !== false) {
      const reranker = new TripletReranker(options.rerank)
      const result = await reranker.rerank(queryEmbedding, retrieved.candidates, queryText, referenceEmbeddings)
      ranked = result.triplets
      rerankInfo = {
        mode: result.mode,
        weight: result.weight,
        applied: result.applied,
        error: result.error,
      }
    }

    // 词面通道融合：查询明确提到的实体边确定性占前，抑制 embedding rerank 的 API 级排名波动
    ranked = applyLexicalFusion(ranked, queryText)

    // 相关性下限：低分边不进结果（防幻觉上下文，对标 TrustGraph 质量过滤）
    const minScore = options.minScore
    const filtered = (minScore !== undefined ? ranked.filter((t) => t.score >= minScore) : ranked).slice(0, topK)

    // 投影图节点度数（邻域内边数），供锚点补边与实体卡使用
    const projectedDegree = new Map<string, number>()
    for (const edge of retrieved.cogneeGraph?.edges ?? []) {
      projectedDegree.set(edge.node1.id, (projectedDegree.get(edge.node1.id) ?? 0) + 1)
      projectedDegree.set(edge.node2.id, (projectedDegree.get(edge.node2.id) ?? 0) + 1)
    }

    // 锚点直达边保底：查询明确提到的实体（含去括号基准名锚定），其一跳边若被精排挤出
    // topK（聚合边与高须邻域边竞争时常见，如"四种核心能力"只回来 2/4），从候选池找回并
    // 追加到结果尾部。按锚点节点投影度数升序补齐（低度锚点的边更容易整块缺失，优先找回），
    // 不改变原有 topK 排序。
    if (retrieved.anchoredNodes.length > 0) {
      const anchorIds = new Set(retrieved.anchoredNodes.map((n) => n.id))
      const inResult = new Set(filtered.map((t) => `${t.source.id}|${t.relation}|${t.target.id}`))
      const seenCandidates = new Set<string>()
      const anchorMisses: Array<{ triplet: Triplet; minDegree: number }> = []
      for (const t of ranked) {
        const key = `${t.source.id}|${t.relation}|${t.target.id}`
        if (seenCandidates.has(key) || inResult.has(key)) continue
        seenCandidates.add(key)
        const sourceIsAnchor = anchorIds.has(t.source.id)
        const targetIsAnchor = anchorIds.has(t.target.id)
        if (!sourceIsAnchor && !targetIsAnchor) continue
        const anchorDegree = Math.min(
          sourceIsAnchor ? (projectedDegree.get(t.source.id) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER,
          targetIsAnchor ? (projectedDegree.get(t.target.id) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER,
        )
        anchorMisses.push({ triplet: t, minDegree: anchorDegree })
      }
      anchorMisses.sort((a, b) => a.minDegree - b.minDegree)
      filtered.push(...anchorMisses.slice(0, 6).map((miss) => miss.triplet))
    }

    // 文档溯源与边推理并发执行（对标 TrustGraph：steps 7 and 8 run concurrently for efficiency）
    const [docIds, sourceChunksByRank, reasons] = await Promise.all([
      this.linkSourceDocuments(filtered),
      this.linkSourceChunks(filtered),
      (async () => {
        if (options.reason && options.reason.enabled !== false && queryText) {
          const reasoner = new EdgeReasoner(options.reason)
          return reasoner.explain(queryText, filtered)
        }
        return new Map<number, string>()
      })(),
    ])

    const sourceChunks = [...new Map(
      [...sourceChunksByRank.values()].flat().map((chunk) => [chunk.chunkId, chunk])
    ).values()]

    // 实体卡通道：description-only 知识的检索出口。
    // 查询锚点命中的实体（尤其孤立/低度节点）即使投影不出边，其定义也随卡返回，
    // 修复"FDE 这类概念进了图（有名字+描述）但无边可查"的检索盲区。
    const describedInResult = new Set<string>()
    for (const t of filtered) {
      describedInResult.add(t.source.id)
      describedInResult.add(t.target.id)
    }
    const cardOf = (node: GraphNode, origin: 'anchor' | 'low-degree') => {
      const description = String(node.properties?.description ?? '').trim()
      if (!description) return null
      return { name: node.name, type: node.type, description, origin }
    }
    const entityCards: Array<{ name: string; type: string; description: string; origin: 'anchor' | 'low-degree' }> = []
    const seenCardNames = new Set<string>()
    for (const node of retrieved.anchoredNodes) {
      if (entityCards.length >= 5) break
      // 边结果已覆盖的锚点实体（有边且已入选）不再出卡，避免重复注入
      if ((projectedDegree.get(node.id) ?? 0) > 0 && describedInResult.has(node.id)) continue
      const card = cardOf(node, 'anchor')
      if (card && !seenCardNames.has(card.name)) {
        seenCardNames.add(card.name)
        entityCards.push(card)
      }
    }
    if (entityCards.length < 5) {
      const lowDegreeSeeds = retrieved.seedNodes
        .filter((node) => !seenCardNames.has(node.name) && (projectedDegree.get(node.id) ?? 0) <= 1 && !describedInResult.has(node.id))
        .slice(0, 2)
      for (const node of lowDegreeSeeds) {
        if (entityCards.length >= 5) break
        const card = cardOf(node, 'low-degree')
        if (card && !seenCardNames.has(card.name)) {
          seenCardNames.add(card.name)
          entityCards.push(card)
        }
      }
    }

    // 合成上下文：图关系与去重后的原文分开，避免同一 chunk 被每条关系重复注入。
    const context = filtered
      .map((t, rank) => {
        let line = `[${t.source.name}] --[${t.relation}]--> [${t.target.name}]`
        const reason = reasons.get(rank)
        const docs = docIds.get(rank)
        if (reason) line += `（关联：${reason}）`
        if (docs?.length) line += `（来源文档: ${docs.join(', ')}）`
        return line
      })
      .join('\n')
      + (entityCards.length > 0
        ? `\n\n实体卡片：\n${entityCards.map((card) => `【${card.name}】（${card.type}）${card.description}`).join('\n')}`
        : '')
      + (sourceChunks.length > 0
        ? `\n\n原文片段：\n${sourceChunks.map((chunk) => `[${chunk.chunkId}] ${chunk.content}`).join('\n')}`
        : '')

    const explanation: RetrievalExplanation = {
      question: queryText,
      seeds: retrieved.seedNodes.map((n) => ({ id: n.id, name: n.name, type: n.type })),
      projectedNodeCount: retrieved.projectedNodeCount,
      candidateCount: retrieved.candidateCount,
      filteredCount: retrieved.candidates.length,
      focus: filtered.map((t, rank) => ({
        source: t.source.name,
        relation: t.relation,
        target: t.target.name,
        score: t.score,
        rank: rank + 1,
        reason: reasons.get(rank),
        sourceDocumentIds: docIds.get(rank),
      })),
      filtersApplied: describeFilters(options),
      rerank: rerankInfo,
      startedAt: timing.startedAt.toISOString(),
      durationMs: Date.now() - timing.startTime,
    }
    if (subQueries) explanation.subQueries = subQueries

    // 检索解释持久化（对标 TrustGraph 检索 provenance 审计）：失败不阻塞；
    // traceId 写回解释结构，供下游 updateTraceAnswer() 回填答案
    if (options.persistExplanation) {
      try {
        const traceId = await options.persistExplanation(explanation, {
          queryText,
          knowledgeBaseId: options.knowledgeBaseId,
          evidence: filtered.map((t, rank): RetrievalEvidence => {
            const content = `[${t.source.name}] --[${t.relation}]--> [${t.target.name}]`
            return {
              // Claim 引用仅接受 [a-zA-Z0-9:_-]，避免 ISO 时间戳中的 '.' 变成无效引用。
              evidenceId: `ev:${Date.parse(explanation.startedAt)}:${rank + 1}`,
              sourceType: 'graph',
              content,
              contentHash: contentHash(content),
              documentId: docIds.get(rank)?.[0],
              retrieval: { rank: rank + 1, score: t.score, method: 'graph-completion' },
            }
          }),
        })
        if (traceId) explanation.traceId = traceId
      } catch (err: any) {
        console.warn(`[检索追踪] 持久化失败（跳过）: ${err.message}`)
      }
    }

    return {
      triplets: filtered,
      context,
      entityCount: retrieved.cogneeGraph ? retrieved.cogneeGraph.nodes.size : retrieved.projectedNodeCount,
      edgeCount: retrieved.cogneeGraph ? retrieved.cogneeGraph.edges.length : 0,
      explanation,
      sourceChunks,
      entityCards: entityCards.length > 0 ? entityCards : undefined,
    }
  }

  /** 从图存储反查每条三元组的来源文档 ID（边 properties.sourceDocumentIds） */
  private async linkSourceDocuments(triplets: Triplet[]): Promise<Map<number, string[]>> {
    const result = new Map<number, string[]>()
    // 按“边”缓存（source|relation|target），同一源节点的不同边支持不同来源文档
    const edgeCache = new Map<string, string[] | null>()

    for (let rank = 0; rank < triplets.length; rank++) {
      const t = triplets[rank]
      try {
        const cacheKey = `${t.source.id}|${t.relation}|${t.target.id}`
        let docs = edgeCache.get(cacheKey)
        if (docs === undefined) {
          const edges = await this.graph.getEdges(t.source.id)
          const match = edges.find(
            (e) => e.targetId === t.target.id && e.relationshipName === t.relation
          )
          const ids = (match?.properties?.sourceDocumentIds as string[] | undefined)?.filter(Boolean)
          docs = ids && ids.length > 0 ? ids : null
          edgeCache.set(cacheKey, docs)
        }
        if (docs) result.set(rank, docs)
      } catch { /* 溯源缺失不影响检索 */ }
    }
    return result
  }

  /** 从边/节点的 chunk 引用回查原文，适配器不支持时保持空结果。 */
  private async linkSourceChunks(triplets: Triplet[]): Promise<Map<number, Array<{
    chunkId: string
    documentId: string
    chunkIndex: number
    content: string
  }>>> {
    const result = new Map<number, Array<{ chunkId: string; documentId: string; chunkIndex: number; content: string }>>()
    const g = this.graph as any
    if (typeof g.getDocumentChunks !== 'function') return result

    for (let rank = 0; rank < triplets.length; rank++) {
      const t = triplets[rank]
      try {
        const edges = await this.graph.getEdges(t.source.id)
        const edge = edges.find((e) => e.targetId === t.target.id && e.relationshipName === t.relation)
        let chunkIds = edge?.properties?.mergedFromChunks as string[] | undefined
        // 旧数据或边未持久化 chunk 属性时，回退 chunk tracker 的 relation→chunk 溯源
        if ((!chunkIds || chunkIds.length === 0) && typeof g.chunkTracker?.getRelationChunks === 'function') {
          chunkIds = await g.chunkTracker.getRelationChunks(t.source.id, t.target.id, t.relation)
        }
        if (!chunkIds || chunkIds.length === 0) {
          const nodeChunks = [t.source.properties?.mergedFromChunks, t.target.properties?.mergedFromChunks]
            .find((value) => Array.isArray(value))
          chunkIds = nodeChunks as string[] | undefined
        }
        if (!chunkIds || chunkIds.length === 0) continue
        const chunks = await g.getDocumentChunks([...new Set(chunkIds)])
        if (chunks.length > 0) result.set(rank, chunks)
      } catch { /* 原文回链失败不影响图检索 */ }
    }
    return result
  }

  async searchByQuery(
    query: string,
    queryEmbedding: number[],
    options: GraphSearchOptions
  ): Promise<CompletionResult> {
    // query 文本供 llm 精排/边推理/分解/持久化使用；embedding 负责语义检索
    const rerank = options.rerank
      ? { ...options.rerank, queryText: options.rerank.queryText ?? query }
      : options.rerank
    return this.search(queryEmbedding, { ...options, rerank, queryText: options.queryText ?? query })
  }

  /**
   * 种子节点选择（双路径）：
   * 1. 主路径：SQL 侧 pgvector ANN top-K（ivfflat 索引，排除结构化节点类型）
   * 2. 兜底：全量拉取内存打分（适配器不支持 ANN 时，如 mock 图）
   */
  private async findSeedNodes(
    queryEmbedding: number[],
    knowledgeBaseId?: string,
    maxCandidates: number = 20
  ): Promise<GraphNode[]> {
    const g = this.graph as any

    if (typeof g.findSimilarNodesByEmbedding === 'function') {
      try {
        const nodes = await g.findSimilarNodesByEmbedding({
          embedding: queryEmbedding,
          topK: maxCandidates,
          knowledgeBaseId,
          excludeTypes: STRUCTURAL_NODE_TYPES,
        })
        if (nodes.length > 0) return nodes
      } catch (err: any) {
        console.warn(`[图补全] ANN 种子检索失败，降级内存打分: ${err.message}`)
      }
    }

    // 兜底：内存打分（小图 / mock 适配器）
    const graphData = await this.graph.getGraphData(knowledgeBaseId)
    const nodes = graphData.nodes.filter(
      (n) => !STRUCTURAL_NODE_TYPES.includes(n.type)
    )

    return nodes
      .map((node) => ({
        node,
        score: node.embedding ? cosineSimilarity(queryEmbedding, node.embedding) : 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxCandidates)
      .map((s) => s.node)
  }

  async searchTriplets(
    input: TripletSearchInput
  ): Promise<Triplet[]> {
    const cogneeGraph = new CogneeGraph()

    const seedNodes = await this.findSeedNodes(
      input.queryEmbedding,
      input.knowledgeBaseId,
      input.topK * 2
    )

    for (const node of seedNodes) {
      cogneeGraph.addNode(node)
    }

    const seedIds = seedNodes.map((n) => n.id)
    await cogneeGraph.projectNeighborhoodFromDb(this.graph, seedIds, 2)

    // 补齐投影后所有节点的 embedding（邻居节点也参与距离计算）
    const graphNodeIds = [...cogneeGraph.nodes.keys()]
    let allProjectedNodes: GraphNode[] = []
    if (typeof (this.graph as any).getNodes === 'function' && graphNodeIds.length > 0) {
      try {
        allProjectedNodes = await this.graph.getNodes(graphNodeIds)
      } catch { /* 忽略：退回种子节点 embedding */ }
    }
    const embeddings = new Map<string, number[]>()
    const pool = allProjectedNodes.length > 0 ? allProjectedNodes : seedNodes
    for (const node of pool) {
      if (node.embedding) {
        embeddings.set(node.id, node.embedding)
      }
    }
    cogneeGraph.mapVectorDistancesToNodes(input.queryEmbedding, embeddings)
    cogneeGraph.mapVectorDistancesToEdges(input.queryEmbedding, embeddings)

    if (input.usePersonalWeights && input.personalWeights) {
      const weights = new Map<string, number>()
      for (const [nodeId, weight] of Object.entries(input.personalWeights)) {
        weights.set(nodeId, weight)
      }
      cogneeGraph.applyPersonalWeights(weights)
    }

    // 反馈权重注入（可选）
    if (input.useFeedbackWeights) {
      const feedbackWeights = new Map<string, { positive: number; negative: number }>()
      const g = this.graph as any
      if (typeof g.getNodeFeedbackWeights === 'function') {
        for (const node of pool) {
          try {
            const w = await g.getNodeFeedbackWeights(node.id)
            if (w) feedbackWeights.set(node.id, w)
          } catch { /* 无反馈数据则跳过 */ }
        }
      }
      cogneeGraph.applyFeedbackWeights(feedbackWeights)
    }

    const triplets = cogneeGraph.calculateTopTripletImportances(input.topK * 3, {
      alpha: input.alpha,
      beta: input.beta,
      gamma: input.gamma,
    })
    const filteredAll = filterTriplets(triplets, input)

    if (input.rerank && input.rerank.enabled !== false) {
      const reranker = new TripletReranker(input.rerank)
      const result = await reranker.rerank(input.queryEmbedding, filteredAll, input.rerank.queryText)
      return result.triplets.slice(0, input.topK)
    }

    return filteredAll.slice(0, input.topK)
  }
}

function filterByOntology(triplets: Triplet[], config: OntologyConfig): Triplet[] {
  const validator = new OntologyValidator(config)
  return triplets.filter((triplet) => validator.isTripletAllowed(
    triplet.source.type,
    triplet.relation,
    triplet.target.type,
  ))
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1)
}

function filterTriplets(
  triplets: Triplet[],
  options: Pick<GraphSearchOptions, 'relationTypes' | 'excludeRelationTypes' | 'sourceNames' | 'targetNames' | 'sourceTypes' | 'targetTypes'>
): Triplet[] {
  const allowed = options.relationTypes?.length ? new Set(options.relationTypes) : undefined
  const excluded = new Set(['is_a', ...(options.excludeRelationTypes || [])])
  const sources = options.sourceNames?.length ? new Set(options.sourceNames) : undefined
  const targets = options.targetNames?.length ? new Set(options.targetNames) : undefined
  const sourceTypes = options.sourceTypes?.length ? new Set(options.sourceTypes) : undefined
  const targetTypes = options.targetTypes?.length ? new Set(options.targetTypes) : undefined
  return triplets.filter((triplet) =>
    (!allowed || allowed.has(triplet.relation)) &&
    !excluded.has(triplet.relation) &&
    (!sources || sources.has(triplet.source.name)) &&
    (!targets || targets.has(triplet.target.name)) &&
    (!sourceTypes || sourceTypes.has(triplet.source.type)) &&
    (!targetTypes || targetTypes.has(triplet.target.type))
  )
}

/** 实体基准名：剥离消歧括号后缀（"智能体（Agent）"→"智能体"），供词面锚定与查询简称对齐 */
function entityBaseName(name: string): string {
  return name
    .replace(/[（(][^）)]*[)）]/g, '')
    .replace(/^[*#>\-•·\s]+/, '')
    .replace(/[*#>\s]+$/, '')
    .trim()
}

function selectQueryAnchors(seedNodes: GraphNode[], queryText?: string): GraphNode[] | null {
  if (!queryText) return null
  const normalized = queryText.toLowerCase()
  const anchors = seedNodes.filter((node) => {
    const name = node.name.trim().toLowerCase()
    // 两字品牌/通用词（如“影刀”）不足以证明查询命中具体主题，避免负例被它们误锚定。
    if (name.length >= 3 && normalized.includes(name)) return true
    // 去括号基准名匹配：查询简称（"智能体"）可锚定带消歧后缀的实体（"智能体（Agent）"）。
    // 基准名需比原名短（确实剥掉了括号）且满足同样的长度门槛。
    const base = entityBaseName(name)
    return base.length >= 3 && base.length < name.length && normalized.includes(base)
  })
  // 明确实体词没有命中图谱时，避免 ANN 用无关节点“凑结果”。
  const hasSpecificPhrase = /[\u4e00-\u9fff]{4,}/.test(queryText.replace(/是什么|有什么|如何|哪些|可以|能够|功能|作用|方法|使用|配置|介绍/g, ''))
  if (anchors.length > 0) return [...new Map(anchors.map((node) => [node.id, node])).values()]
  return hasSpecificPhrase ? [] : null
}

function describeFilters(
  options: Pick<GraphSearchOptions, 'relationTypes' | 'excludeRelationTypes' | 'sourceNames' | 'targetNames' | 'sourceTypes' | 'targetTypes'>
): string[] {
  const desc: string[] = ['exclude:is_a（默认）']
  if (options.relationTypes?.length) desc.push(`relationTypes: ${options.relationTypes.join('|')}`)
  if (options.excludeRelationTypes?.length) desc.push(`excludeRelationTypes: ${options.excludeRelationTypes.join('|')}`)
  if (options.sourceNames?.length) desc.push(`sourceNames: ${options.sourceNames.join('|')}`)
  if (options.targetNames?.length) desc.push(`targetNames: ${options.targetNames.join('|')}`)
  if (options.sourceTypes?.length) desc.push(`sourceTypes: ${options.sourceTypes.join('|')}`)
  if (options.targetTypes?.length) desc.push(`targetTypes: ${options.targetTypes.join('|')}`)
  return desc
}

/**
 * 候选多样性：按 (relation, target 类型) 分组轮转进入候选池。
 * 字段级边平铺入图后数量远超模型级边（如 20 个响应字段 vs 2 个响应模型），
 * 纯重要性截断会让单组垄断候选，精排再好也无边可选；轮转保证每组都有代表。
 */
function diversifyCandidates(triplets: Triplet[], limit: number): Triplet[] {
  if (triplets.length <= limit) return triplets
  const groups = new Map<string, Triplet[]>()
  for (const triplet of triplets) {
    const key = `${triplet.relation}|${triplet.target.type}`
    const list = groups.get(key)
    if (list) list.push(triplet)
    else groups.set(key, [triplet])
  }
  const queues = [...groups.values()]
  const out: Triplet[] = []
  let index = 0
  while (out.length < limit && queues.some((queue) => queue.length > 0)) {
    const queue = queues[index % queues.length]
    const next = queue.shift()
    if (next) out.push(next)
    index++
  }
  return out
}

/**
 * 候选构建期的词面优先排序：查询完整提到的实体（词面分更高）出边整体前置，组内保持原
 * importance 序。与 applyLexicalFusion 的分工：这里保障"召回"（明确实体边必进候选池，
 * 不被图中心实体的重要性分压制）；finalize 里的融合负责精排。稳定排序保持组内序。
 */
function lexicalFirstSort(triplets: Triplet[], queryText?: string): Triplet[] {
  if (!queryText || triplets.length <= 1) return triplets
  const normalizedQuery = queryText.replace(/\s+/g, '').toLowerCase()
  if (!normalizedQuery) return triplets
  const scored = triplets.map((triplet) => ({
    triplet,
    score: Math.max(
      entityLexicalScore(triplet.source.name, normalizedQuery),
      entityLexicalScore(triplet.target.name, normalizedQuery),
    ),
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored.map((entry) => entry.triplet)
}

/** 单条边的词面分（source/target 取高者），供自适应分支判断词面是否命中 */
function tripletLexicalScore(triplet: Triplet, queryText?: string): number {
  if (!queryText) return 0
  const normalizedQuery = queryText.replace(/\s+/g, '').toLowerCase()
  if (!normalizedQuery) return 0
  return Math.max(
    entityLexicalScore(triplet.source.name, normalizedQuery),
    entityLexicalScore(triplet.target.name, normalizedQuery),
  )
}

const DecomposeSchema = z.object({
  subQueries: z.array(z.string().min(1)).min(1),
})
