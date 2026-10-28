export interface GraphNode {
  id: string
  knowledgeBaseId: string
  name: string
  type: string
  properties: Record<string, unknown>
  embedding?: number[]
  frequency: number
  createdAt: Date
  updatedAt: Date
}

export interface GraphEdge {
  sourceId: string
  targetId: string
  relationshipName: string
  properties: Record<string, unknown>
  weight: number
  knowledgeBaseId: string
  createdAt: Date
  updatedAt: Date
}

export interface GraphMetadata {
  key: string
  value: string
}

export interface DocumentNodeLink {
  documentId: string
  nodeId: string
  chunkIndex: number | null
  /** 来源页码（对标 TrustGraph Document→Page→Chunk 链的 Page 层） */
  pageIndex?: number | null
  pipelineRunId: string | null
}

export interface CreateNodeInput {
  id?: string
  knowledgeBaseId: string
  name: string
  type: string
  properties?: Record<string, unknown>
  embedding?: number[]
  frequency?: number
}

export interface UpdateNodeInput {
  name?: string
  type?: string
  properties?: Record<string, unknown>
  embedding?: number[]
  frequency?: number
}

export interface CreateEdgeInput {
  sourceId: string
  targetId: string
  relationshipName: string
  properties?: Record<string, unknown>
  weight?: number
  knowledgeBaseId: string
}

export interface NeighborResult {
  node: GraphNode
  edge: GraphEdge
  depth: number
}

export interface ConnectionResult {
  sourceId: string
  targetId: string
  relationshipName: string
  edgeProperties: Record<string, unknown>
  weight: number
}

export interface NeighborhoodInput {
  seedIds: string[]
  maxDepth: number
  edgeTypes?: string[]
  knowledgeBaseId?: string
}

export interface Subgraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface SubgraphFilter {
  knowledgeBaseId?: string
  nodeTypes?: string[]
  nodeIds?: string[]
  attributeFilters?: Record<string, unknown>
}

export interface Path {
  nodes: GraphNode[]
  edges: GraphEdge[]
  totalWeight: number
}

export interface GraphMetrics {
  nodeCount: number
  edgeCount: number
  nodeTypeDistribution: Record<string, number>
  relationshipDistribution: Record<string, number>
  connectedComponents: number
  avgDegree: number
  density: number
}

export interface Triplet {
  source: GraphNode
  relation: string
  target: GraphNode
  weight: number
  score: number
}

export interface TripletSearchInput {
  queryEmbedding: number[]
  topK: number
  knowledgeBaseId?: string
  usePersonalWeights?: boolean
  personalWeights?: Record<string, number>
  useFeedbackWeights?: boolean
  alpha?: number
  beta?: number
  gamma?: number
  relationTypes?: string[]
  excludeRelationTypes?: string[]
  sourceNames?: string[]
  targetNames?: string[]
  sourceTypes?: string[]
  targetTypes?: string[]
  rerank?: TripletRerankOptions
}

/**
 * 三元组重排选项（对标 TrustGraph graph_rag 的 cross-encoder rerank）
 */
export interface TripletRerankOptions {
  /** 默认 true，设为 false 跳过精排 */
  enabled?: boolean
  /** embedding（默认，bi-encoder 精排）| llm（cross-encoder 式精排，更准更贵） */
  mode?: 'embedding' | 'llm'
  /** embedding 模式必需：文本批量嵌入函数 */
  embedTexts?: (texts: string[]) => Promise<number[][]>
  /** RRF 融合权重（rerank 排序占比，0-1），默认 0.5 */
  weight?: number
  /** llm 模式的模型名 */
  model?: string
  /** 原始查询文本（llm 模式必需） */
  queryText?: string
  /** llm 模式最大候选数，默认 30 */
  maxLLMCandidates?: number
}

/**
 * 检索解释结构（对标 TrustGraph 的检索解释 DAG：question → grounding → exploration → focus）
 */
export interface RetrievalExplanation {
  /** 解释 DAG 起点：原始查询文本（对标 TrustGraph trace 记录的 question） */
  question?: string
  /** grounding：种子实体（查询语义锚点） */
  seeds: Array<{ id: string; name: string; type: string }>
  /** exploration：邻域投影节点数 */
  projectedNodeCount: number
  /** exploration：过滤前候选三元组数 */
  candidateCount: number
  /** exploration：过滤后三元组数 */
  filteredCount: number
  /** focus：最终返回的三元组（含排名与分数） */
  focus: Array<{
    source: string
    relation: string
    target: string
    score: number
    rank: number
    /** 边推理（对标 TrustGraph edge reasoning）：该边为何与问题相关 */
    reason?: string
    /** 文档回链（对标 TrustGraph document tracing）：来源文档 ID */
    sourceDocumentIds?: string[]
  }>
  /** 应用的过滤条件描述 */
  filtersApplied: string[]
  /** rerank 精排信息 */
  rerank?: { mode: string; weight: number; applied: boolean; error?: string }
  /** 概念分解模式下的子查询列表 */
  subQueries?: string[]
  /** Synthesis 回填：下游 LLM 生成的最终答案（对标 TrustGraph Synthesis 溯源） */
  answer?: string
  /** 持久化 trace 节点 id（回填答案时定位用） */
  traceId?: string
  startedAt: string
  durationMs: number
}

/** 边推理选项（对标 TrustGraph edge reasoning：LLM 解释每条边为何与问题相关） */
export interface EdgeReasonOptions {
  /** 默认 true，设为 false 跳过 */
  enabled?: boolean
  /** llm 模型名 */
  model?: string
  /** 最多解释条数，默认 10 */
  maxEdges?: number
}

/**
 * 概念分解选项（对标 TrustGraph 检索步骤 1-3：LLM 拆问题→独立嵌入→跨子查询去重）
 *
 * 适用边界（2026-09 实测，API 图谱 10 用例 A/B）：
 * - ✅ 结构性比较/聚合查询收益显著：如"接口 A 和 B 共享哪些字段" 35→95 分
 *   （子查询各自精准命中离散对象：字段/模型/参数清单）
 * - ❌ 语义/流程对比查询有害："同步与通知日志的区别" 76→40 分
 *   （知识在描述文本里，分解打散上下文语义）
 * - 单实体直查查询无需开启
 * 路由建议：查询含两个以上明确名词实体 + 聚合词（共享/都/分别）→ 开；
 * 含语义词（区别/差异/为什么）→ 不开；拿不准 → 不开（误开代价 > 漏开）。
 */
export interface DecomposeOptions {
  /** 默认 true（传入即启用），设为 false 跳过 */
  enabled?: boolean
  /** 最多子查询数，默认 4 */
  maxSubQueries?: number
  /** llm 模型名 */
  model?: string
  /** 子查询文本嵌入函数（独立向量化）；缺省时子查询复用原查询向量 */
  embedTexts?: (texts: string[]) => Promise<number[][]>
}

export interface GraphExtraction {
  entities: Array<{
    name: string
    type: string
    description?: string
    attributes?: Array<{
      name: string
      value: string | number | boolean
      datatype?: string
    }>
  }>
  triplets: Array<{
    source: string
    relation: string
    target: string
    confidence: number
    effectiveDate?: string
  }>
}

export type CombinedExtraction = GraphExtraction
