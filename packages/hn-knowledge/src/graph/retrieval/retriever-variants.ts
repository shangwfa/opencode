import { z } from 'zod'
import { getDefaultChatModel } from '../../config/env.js'
import { GraphCompletionRetriever, type CompletionResult, type GraphSearchOptions } from './graph-completion-retriever.js'
import { filterActiveEdges } from '../algorithms/temporal-conflict-resolver.js'
import type { GraphDB } from '../interface.js'
import type { Triplet } from '../types.js'

/**
 * 懒加载 LLM（避免模块导入期拉起 provider 链）
 */
async function loadLlm(modelName: string): Promise<{ generateObject: any; model: any } | null> {
  try {
    const [{ generateObject }, { resolveModel }] = await Promise.all([
      import('ai'),
      import('../../utils/model-resolver.js'),
    ])
    return { generateObject, model: resolveModel(modelName) }
  } catch {
    return null
  }
}

/**
 * 懒加载 embedding（对子查询单独向量化用）
 */
async function loadEmbedder(): Promise<((texts: string[]) => Promise<number[][]>) | null> {
  try {
    const [{ embedMany }, { openaiEmbedding }] = await Promise.all([
      import('ai'),
      import('../../providers/llm.js'),
    ])
    const model = openaiEmbedding('text-embedding-3-small')
    return async (texts: string[]) => (await embedMany({ model, values: texts })).embeddings
  } catch {
    return null
  }
}

export interface ReasoningResult {
  triplets: Triplet[]
  context: string
  reasoning: string
  subQueries: string[]
  entityCount: number
  edgeCount: number
}

const DecomposeSchema = z.object({
  subQueries: z.array(z.string()).min(1).max(4).describe('分解出的子查询列表'),
})

const ReasoningSchema = z.object({
  reasoning: z.string().describe('基于三元组的推理过程'),
  conclusion: z.string().describe('推理结论'),
})

/**
 * 图检索器变体（对标 cognee 的图补全检索器家族）
 *
 * - GraphCompletionCotRetriever: CoT 推理（检索→推理→结论）
 * - GraphCompletionDecompositionRetriever: 问题分解（复杂问题→子查询→分别检索→合并）
 * - GraphCompletionContextExtensionRetriever: 上下文扩展（多轮，基于上轮结果扩展）
 * - TemporalRetriever: 时间感知（提取时间范围，过滤失效边，优先时间线索）
 * - TripletRetriever: 三元组直接检索（无 LLM，最轻量）
 */
export class GraphCompletionCotRetriever {
  private base: GraphCompletionRetriever
  private modelName: string

  constructor(graph: GraphDB, options?: { model?: string }) {
    this.base = new GraphCompletionRetriever(graph)
    this.modelName = options?.model || getDefaultChatModel()
  }

  async search(
    queryEmbedding: number[],
    query: string,
    options: GraphSearchOptions
  ): Promise<ReasoningResult> {
    const result = await this.base.search(queryEmbedding, options)

    let reasoning = ''
    const llm = await loadLlm(this.modelName)
    if (llm) {
      try {
        const resp = await llm.generateObject({
          model: llm.model,
          schema: ReasoningSchema,
        prompt: `基于以下知识图谱三元组，对问题进行推理。

问题：${query}

三元组：
${result.context || '（无相关三元组）'}

请给出推理过程和结论。`,
        temperature: 0.2,
        })
        reasoning = `${resp.object.reasoning}\n\n结论：${resp.object.conclusion}`
      } catch {
        reasoning = result.context
      }
    } else {
      reasoning = result.context
    }

    return {
      triplets: result.triplets,
      context: result.context,
      reasoning,
      subQueries: [],
      entityCount: result.entityCount,
      edgeCount: result.edgeCount,
    }
  }
}

export class GraphCompletionDecompositionRetriever {
  private base: GraphCompletionRetriever
  private modelName: string

  constructor(graph: GraphDB, options?: { model?: string }) {
    this.base = new GraphCompletionRetriever(graph)
    this.modelName = options?.model || getDefaultChatModel()
  }

  async search(
    queryEmbedding: number[],
    query: string,
    options: GraphSearchOptions
  ): Promise<ReasoningResult> {
    let subQueries: string[] = [query]
    const llm = await loadLlm(this.modelName)
    if (llm) {
      try {
        const resp = await llm.generateObject({
          model: llm.model,
          schema: DecomposeSchema,
          prompt: `将以下复杂问题分解为最多 4 个可独立检索的子查询。每个子查询应聚焦一个具体的关系或实体对。

问题：${query}`,
          temperature: 0.1,
        })
        subQueries = resp.object.subQueries
      } catch {
        // 分解失败则退化为原查询
      }
    }

    // 对每个子查询独立向量化（对标 cognee query_decomposition + 逐子查询检索）；
    // embedding 不可用时退化为复用原始查询向量
    let subEmbeddings: number[][] | null = null
    if (subQueries.length > 1) {
      const embedder = await loadEmbedder()
      if (embedder) {
        try {
          subEmbeddings = await embedder(subQueries)
        } catch { /* embedding 失败则退化 */ }
      }
    }

    const allTriplets: Triplet[] = []
    const seen = new Set<string>()
    let entityCount = 0
    let edgeCount = 0

    for (let i = 0; i < subQueries.length; i++) {
      // 子查询独立向量（降级为原查询向量）——语义区分不再丢失
      const subEmb = subEmbeddings?.[i] ?? queryEmbedding
      const result = await this.base.search(subEmb, {
        ...options,
        topK: Math.max(2, Math.ceil(options.topK / subQueries.length)),
      })
      entityCount = Math.max(entityCount, result.entityCount)
      edgeCount = Math.max(edgeCount, result.edgeCount)
      for (const t of result.triplets) {
        const key = `${t.source.id}|${t.relation}|${t.target.id}`
        if (!seen.has(key)) {
          seen.add(key)
          allTriplets.push(t)
        }
      }
    }

    // 合并后按距离升序（距离空间，越小越重要，与 GraphCompletionRetriever 一致）
    allTriplets.sort((a, b) => a.score - b.score)

    const context = allTriplets
      .map((t) => `[${t.source.name}] --[${t.relation}]--> [${t.target.name}]`)
      .join('\n')

    return {
      triplets: allTriplets,
      context,
      reasoning: '',
      subQueries,
      entityCount,
      edgeCount,
    }
  }
}

export class GraphCompletionContextExtensionRetriever {
  private base: GraphCompletionRetriever

  constructor(graph: GraphDB) {
    this.base = new GraphCompletionRetriever(graph)
  }

  /**
   * 多轮扩展检索：每轮基于上一轮命中的实体扩大邻域深度再检索
   */
  async search(
    queryEmbedding: number[],
    options: GraphSearchOptions & { rounds?: number }
  ): Promise<ReasoningResult> {
    const rounds = options.rounds || 2
    const collected: Triplet[] = []
    const seen = new Set<string>()
    let entityCount = 0
    let edgeCount = 0
    let currentDepth = options.neighborDepth

    for (let round = 0; round < rounds; round++) {
      const result = await this.base.search(queryEmbedding, {
        ...options,
        neighborDepth: currentDepth,
      })
      entityCount = Math.max(entityCount, result.entityCount)
      edgeCount = Math.max(edgeCount, result.edgeCount)

      let added = 0
      for (const t of result.triplets) {
        const key = `${t.source.id}|${t.relation}|${t.target.id}`
        if (!seen.has(key)) {
          seen.add(key)
          collected.push(t)
          added++
        }
      }
      if (added === 0) break // 无新增则提前终止
      currentDepth += 1 // 下一轮扩大邻域
    }

    // 距离空间升序（越小越重要，与 GraphCompletionRetriever 一致）
    collected.sort((a, b) => a.score - b.score)
    const top = collected.slice(0, options.topK)
    const context = top
      .map((t) => `[${t.source.name}] --[${t.relation}]--> [${t.target.name}]`)
      .join('\n')

    return {
      triplets: top,
      context,
      reasoning: '',
      subQueries: [],
      entityCount,
      edgeCount,
    }
  }
}

export class TemporalRetriever {
  private graph: GraphDB
  private base: GraphCompletionRetriever

  constructor(graph: GraphDB) {
    this.graph = graph
    this.base = new GraphCompletionRetriever(graph)
  }

  /**
   * 时间感知检索：过滤已被 superseded 的边，按时间线索优先排序
   */
  async search(
    queryEmbedding: number[],
    options: GraphSearchOptions & { before?: string; after?: string }
  ): Promise<ReasoningResult> {
    const graphData = await this.graph.getGraphData(options.knowledgeBaseId)
    const activeEdges = filterActiveEdges(graphData.edges)
    // 活跃边键集合：用于过滤已失效（superseded）的三元组
    const activeEdgeKeys = new Set(
      activeEdges.map((e) => `${e.sourceId}|${e.relationshipName}|${e.targetId}`)
    )

    const result = await this.base.search(queryEmbedding, options)

    // 过滤失效三元组（superseded 边产出的三元组不返回）
    const active = result.triplets.filter((t) => {
      const key = `${t.source.id}|${t.relation}|${t.target.id}`
      return activeEdgeKeys.size === 0 ? true : activeEdgeKeys.has(key)
    })

    // 时间范围过滤（基于节点的 effectiveDate 属性）
    let filtered = active
    if (options.before || options.after) {
      const beforeTs = options.before ? Date.parse(options.before) : Infinity
      const afterTs = options.after ? Date.parse(options.after) : -Infinity
      filtered = active.filter((t) => {
        const ts = (t.source.properties?.effectiveDate as string)
          ? Date.parse(t.source.properties.effectiveDate as string)
          : Number.isFinite(beforeTs) || Number.isFinite(afterTs) ? Date.now() : null
        if (ts === null || Number.isNaN(ts)) return false
        return ts <= beforeTs && ts >= afterTs
      })
      // 时间过滤清空时回退到未过滤结果
      if (filtered.length === 0) filtered = active
    }

    const context = filtered
      .map((t) => `[${t.source.name}] --[${t.relation}]--> [${t.target.name}]`)
      .join('\n')

    return {
      triplets: filtered,
      context,
      reasoning: '',
      subQueries: [],
      entityCount: result.entityCount,
      edgeCount: activeEdges.length,
    }
  }
}

export class TripletRetriever {
  private graph: GraphDB

  constructor(graph: GraphDB) {
    this.graph = graph
  }

  /**
   * 三元组直接检索（无 LLM 参与）：按节点 embedding 相似度 + 边权重排序，最轻量
   *
   * 语义：距离空间（与 GraphCompletionRetriever 一致，score 越小越重要）。
   * 用图内节点 embedding 近似 cognee 的 Triplet_text 向量集合检索。
   */
  async search(
    queryEmbedding: number[],
    options: GraphSearchOptions
  ): Promise<ReasoningResult> {
    const graphData = await this.graph.getGraphData(options.knowledgeBaseId)
    const nodesById = new Map(graphData.nodes.map((n) => [n.id, n]))
    const allowed = options.relationTypes?.length ? new Set(options.relationTypes) : undefined
    const excluded = new Set(['is_a', ...(options.excludeRelationTypes || [])])
    const sources = options.sourceNames?.length ? new Set(options.sourceNames) : undefined
    const targets = options.targetNames?.length ? new Set(options.targetNames) : undefined
    const sourceTypes = options.sourceTypes?.length ? new Set(options.sourceTypes) : undefined
    const targetTypes = options.targetTypes?.length ? new Set(options.targetTypes) : undefined
    const edges = filterActiveEdges(graphData.edges)
      .filter((edge) => (!allowed || allowed.has(edge.relationshipName)) && !excluded.has(edge.relationshipName))

    // 用查询向量给节点打分：距离空间（余弦距离 1 - cosine，越小越接近）
    const nodeDistances = new Map<string, number>()
    for (const node of graphData.nodes) {
      nodeDistances.set(node.id, node.embedding ? 1 - cosine(queryEmbedding, node.embedding) : 1)
    }

    const triplets: Triplet[] = edges
      .map((edge) => {
        const source = nodesById.get(edge.sourceId)
        const target = nodesById.get(edge.targetId)
        if (!source || !target) return null
        if (sources && !sources.has(source.name)) return null
        if (targets && !targets.has(target.name)) return null
        if (sourceTypes && !sourceTypes.has(source.type)) return null
        if (targetTypes && !targetTypes.has(target.type)) return null
        // 距离空间得分：两端节点平均距离 × 0.6 + 边权重（越小越重要）
        const score =
          (nodeDistances.get(edge.sourceId)! + nodeDistances.get(edge.targetId)!) / 2 * 0.6 +
          (1 - edge.weight) * 0.4
        return {
          source,
          relation: edge.relationshipName,
          target,
          weight: edge.weight,
          score,
        } as Triplet
      })
      .filter((t): t is Triplet => t !== null)
      .sort((a, b) => a.score - b.score)
      .slice(0, options.topK)

    const context = triplets
      .map((t) => `[${t.source.name}] --[${t.relation}]--> [${t.target.name}]`)
      .join('\n')

    return {
      triplets,
      context,
      reasoning: '',
      subQueries: [],
      entityCount: graphData.nodes.length,
      edgeCount: edges.length,
    }
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}
