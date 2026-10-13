/**
 * 知识库图检索工具（普通异步函数形态）。
 *
 * 由源工程 @mastra/rag createGraphRAGTool 改写。源实现依赖 @mastra/rag 的 GraphRAG 类：
 * 对向量检索返回的 chunks 建图（节点 = chunk 文本 + embedding，边 = 语义相似度 > threshold），
 * 再以查询向量为种子做 random walk with restart 重排序，输出 relevantContext + sources。
 * 因不允许依赖 @mastra/*（@mastra/rag 的 tool 形态绑定 mastra 运行时），
 * 这里按其语义用普通 TS 重写同等能力（triplet 语义边提取 + 社区随机游走检索）。
 *
 * 与源实现的差异：
 * - 源从向量库读取 chunk 存储向量（includeVectors）；本实现用 embedMany 对检索回的
 *   chunk 文本重新嵌入得到节点向量（同一模型下向量等价），因为 vectorService.query
 *   不透传 includeVector。
 * - 源的 GraphRAG 实例跨调用缓存（isInitialized）；本实现每次调用对本次检索结果
 *   重建局部图（无状态函数，语义等价，避免跨知识库残留状态）。
 * - 不硬编码 dimension=1536，按实际向量长度计算。
 */
import { embed, embedMany } from 'ai'
import { vectorService } from '../rag/knowledge-base/index.js'
import { createEmbeddingModel } from '../providers/llm.js'

/** 源 createGraphRAGTool 的默认 graphOptions */
export const GRAPH_QUERY_DEFAULTS = {
  topK: 10,
  threshold: 0.7,
  randomWalkSteps: 100,
  restartProb: 0.15
} as const

interface GraphNode {
  id: string
  content: string
  embedding: number[]
  metadata: Record<string, any>
}

interface GraphEdge {
  source: string
  target: string
  weight: number
  type: string
}

interface RerankedResult {
  id: string
  content: string
  metadata: Record<string, any>
  score: number
}

export interface GraphQuerySource {
  id: string
  score: number
  metadata: Record<string, any>
  document: string
}

export interface GraphQueryResult {
  /** 重排序后的 chunk 文本列表 */
  relevantContext: string[]
  /** 带来源信息的明细 */
  sources: GraphQuerySource[]
}

export interface GraphQueryParams {
  /** 知识库 ID（内部解析为 pgvector 索引名） */
  knowledgeBaseId: string
  /** 查询文本 */
  query: string
  /** 返回结果数量，默认 10 */
  topK?: number
  /** 语义边相似度阈值，默认 0.7 */
  threshold?: number
  /** 随机游走步数，默认 100 */
  randomWalkSteps?: number
  /** 重启概率，默认 0.15 */
  restartProb?: number
  /** 元数据过滤条件（透传向量检索） */
  filter?: Record<string, any>
  /** 嵌入模型名称，默认取环境默认模型 */
  embeddingModel?: string
  /** 是否返回 sources，默认 true */
  includeSources?: boolean
}

function cosineSimilarity(vec1: number[], vec2: number[]): number {
  if (!vec1 || !vec2) throw new Error('Vectors must not be null or undefined')
  if (vec1.length !== vec2.length) {
    throw new Error(`Vector dimensions must match: vec1(${vec1.length}) !== vec2(${vec2.length})`)
  }
  let dotProduct = 0
  let normVec1 = 0
  let normVec2 = 0
  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i]
    normVec1 += vec1[i] * vec1[i]
    normVec2 += vec2[i] * vec2[i]
  }
  const magnitudeProduct = Math.sqrt(normVec1 * normVec2)
  if (magnitudeProduct === 0) return 0
  return Math.max(-1, Math.min(1, dotProduct / magnitudeProduct))
}

/** 按 @mastra/rag GraphRAG.createGraph 语义：两两 chunk 相似度 > threshold 建无向语义边 */
function createGraph(chunks: Array<{ text: string; metadata: Record<string, any> }>, embeddings: number[][], threshold: number): { nodes: Map<string, GraphNode>; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []

  chunks.forEach((chunk, index) => {
    nodes.set(index.toString(), {
      id: index.toString(),
      content: chunk.text,
      embedding: embeddings[index],
      metadata: { ...chunk.metadata }
    })
  })

  for (let i = 0; i < chunks.length; i++) {
    for (let j = i + 1; j < chunks.length; j++) {
      const similarity = cosineSimilarity(embeddings[i], embeddings[j])
      if (similarity > threshold) {
        // 源 addEdge 同时 push 正反两条边（无向图）
        edges.push({ source: i.toString(), target: j.toString(), weight: similarity, type: 'semantic' })
        edges.push({ source: j.toString(), target: i.toString(), weight: similarity, type: 'semantic' })
      }
    }
  }

  return { nodes, edges }
}

function getNeighbors(edges: GraphEdge[], nodeId: string): Array<{ id: string; weight: number }> {
  return edges
    .filter((edge) => edge.source === nodeId)
    .map((edge) => ({ id: edge.target, weight: edge.weight }))
}

function selectWeightedNeighbor(neighbors: Array<{ id: string; weight: number }>): string {
  const totalWeight = neighbors.reduce((sum, n) => sum + n.weight, 0)
  let remainingWeight = Math.random() * totalWeight
  for (const neighbor of neighbors) {
    remainingWeight -= neighbor.weight
    if (remainingWeight <= 0) return neighbor.id
  }
  return neighbors[neighbors.length - 1]?.id
}

/** 按 @mastra/rag GraphRAG.randomWalkWithRestart 语义 */
function randomWalkWithRestart(
  edges: GraphEdge[],
  startNodeId: string,
  steps: number,
  restartProb: number
): Map<string, number> {
  const visits = new Map<string, number>()
  let currentNodeId = startNodeId
  for (let step = 0; step < steps; step++) {
    visits.set(currentNodeId, (visits.get(currentNodeId) || 0) + 1)
    if (Math.random() < restartProb) {
      currentNodeId = startNodeId
      continue
    }
    const neighbors = getNeighbors(edges, currentNodeId)
    if (neighbors.length === 0) {
      currentNodeId = startNodeId
      continue
    }
    currentNodeId = selectWeightedNeighbor(neighbors)
  }
  const totalVisits = Array.from(visits.values()).reduce((a, b) => a + b, 0)
  const normalizedVisits = new Map<string, number>()
  for (const [nodeId, count] of visits) {
    normalizedVisits.set(nodeId, count / totalVisits)
  }
  return normalizedVisits
}

/** 按 @mastra/rag GraphRAG.query 语义：相似种子 + 随机游走重排序 */
function queryGraph(
  graph: { nodes: Map<string, GraphNode>; edges: GraphEdge[] },
  queryEmbedding: number[],
  topK: number,
  randomWalkSteps: number,
  restartProb: number
): RerankedResult[] {
  const similarities = Array.from(graph.nodes.values()).map((node) => ({
    node,
    similarity: cosineSimilarity(queryEmbedding, node.embedding)
  }))
  similarities.sort((a, b) => b.similarity - a.similarity)
  const topNodes = similarities.slice(0, topK)

  const rerankedNodes = new Map<string, { node: GraphNode; score: number }>()
  for (const { node, similarity } of topNodes) {
    const walkScores = randomWalkWithRestart(graph.edges, node.id, randomWalkSteps, restartProb)
    for (const [nodeId, walkScore] of walkScores) {
      const walkNode = graph.nodes.get(nodeId)!
      const existingScore = rerankedNodes.get(nodeId)?.score || 0
      rerankedNodes.set(nodeId, { node: walkNode, score: existingScore + similarity * walkScore })
    }
  }

  return Array.from(rerankedNodes.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((item) => ({
      id: item.node.id,
      content: item.node.content,
      metadata: item.node.metadata,
      score: item.score
    }))
}

/**
 * 图检索指定知识库（替代 createGraphRAGTool）：
 * 向量召回种子 chunks → 建语义图（triplet 提取）→ 随机游走社区检索重排。
 */
export async function graphQuery(params: GraphQueryParams): Promise<GraphQueryResult> {
  const {
    knowledgeBaseId,
    query,
    filter,
    includeSources = true
  } = params
  const topK = params.topK ?? GRAPH_QUERY_DEFAULTS.topK
  const threshold = params.threshold ?? GRAPH_QUERY_DEFAULTS.threshold
  const randomWalkSteps = params.randomWalkSteps ?? GRAPH_QUERY_DEFAULTS.randomWalkSteps
  const restartProb = params.restartProb ?? GRAPH_QUERY_DEFAULTS.restartProb

  try {
    const embeddingModel = createEmbeddingModel(params.embeddingModel || 'openai/text-embedding-3-small')

    // 1. 查询向量召回种子 chunks（源 vectorQuerySearch 语义）
    const { embedding: queryEmbedding } = await embed({ value: query, model: embeddingModel })
    const vectorResults = await vectorService.query(knowledgeBaseId, queryEmbedding, topK, filter)

    // 2. 对 chunk 文本重新嵌入得到节点向量（替代源的 includeVectors）
    const chunkTexts = vectorResults.map((result: any) => result?.metadata?.text ?? '')
    let chunks: Array<{ text: string; metadata: Record<string, any> }> = []
    let embeddings: number[][] = []
    if (chunkTexts.length > 0) {
      const { embeddings: nodeEmbeddings } = await embedMany({ values: chunkTexts, model: embeddingModel })
      chunks = vectorResults.map((result: any) => ({ text: result?.metadata?.text, metadata: result?.metadata ?? {} }))
      embeddings = nodeEmbeddings.map((e) => Array.from(e))
    }

    if (chunks.length === 0) {
      return { relevantContext: [], sources: [] }
    }

    // 3. 建语义图（triplet 提取：两两 chunk 相似度 > threshold 连边）
    const graph = createGraph(chunks, embeddings, threshold)

    // 4. 随机游走社区检索重排序
    const rerankedResults = queryGraph(graph, queryEmbedding, topK, randomWalkSteps, restartProb)

    // 5. 输出（源 tool 输出语义：relevantContext + convertToSources）
    return {
      relevantContext: rerankedResults.map((result) => result.content),
      sources: includeSources
        ? rerankedResults.map((result) => ({
            id: result.id,
            score: result.score,
            metadata: result.metadata,
            document: result.content || ''
          }))
        : []
    }
  } catch {
    // 源 tool 的容错语义：执行异常时返回空结果而非抛出
    return { relevantContext: [], sources: [] }
  }
}
