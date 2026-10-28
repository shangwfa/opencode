import type {
  GraphNode,
  GraphEdge,
  CreateNodeInput,
  UpdateNodeInput,
  CreateEdgeInput,
  NeighborResult,
  NeighborhoodInput,
  Subgraph,
  SubgraphFilter,
  Path,
  GraphMetrics,
  ConnectionResult,
} from './types.js'

export interface GraphDB {
  /** 能力声明：是否支持原生 Cypher 查询（PG 适配器为 false） */
  readonly supportsCypherQueries: boolean

  isGraphEmpty(knowledgeBaseId?: string): Promise<boolean>
  query(sql: string, params?: unknown[]): Promise<unknown[]>

  addNode(input: CreateNodeInput): Promise<string>
  addNodes(inputs: CreateNodeInput[]): Promise<string[]>
  getNode(id: string): Promise<GraphNode | null>
  getNodes(ids: string[]): Promise<GraphNode[]>
  deleteNode(id: string): Promise<void>
  deleteNodes(ids: string[]): Promise<void>
  updateNode(id: string, data: UpdateNodeInput): Promise<void>
  findNodeByName(name: string, knowledgeBaseId?: string): Promise<GraphNode | null>
  findNodesByType(type: string, knowledgeBaseId?: string): Promise<GraphNode[]>

  addEdge(input: CreateEdgeInput): Promise<void>
  addEdges(inputs: CreateEdgeInput[]): Promise<void>
  getEdges(nodeId: string): Promise<GraphEdge[]>
  hasEdge(sourceId: string, targetId: string, relationshipName: string): Promise<boolean>
  hasEdges(edges: Array<Pick<CreateEdgeInput, 'sourceId' | 'targetId' | 'relationshipName'>>): Promise<CreateEdgeInput[]>
  deleteEdge(sourceId: string, targetId: string, relationshipName: string): Promise<void>

  getNeighbors(nodeId: string): Promise<NeighborResult[]>
  getNeighborhood(input: NeighborhoodInput): Promise<Subgraph>
  getConnections(nodeId: string): Promise<ConnectionResult[]>
  getSubgraph(filter?: SubgraphFilter): Promise<Subgraph>
  findPaths(sourceId: string, targetId: string, maxDepth?: number): Promise<Path[]>

  getGraphData(knowledgeBaseId?: string): Promise<Subgraph>
  getFilteredGraphData(attributeFilters: Record<string, unknown>, knowledgeBaseId?: string): Promise<Subgraph>
  getGraphMetrics(knowledgeBaseId?: string): Promise<GraphMetrics>
  deleteGraph(knowledgeBaseId?: string): Promise<void>

  getNodeCount(knowledgeBaseId?: string): Promise<number>
  getEdgeCount(knowledgeBaseId?: string): Promise<number>

  /** 独立 retrieval named graph 存储，PG 适配器实现；其他适配器可选降级到节点存储。 */
  storeRetrievalTrace?(input: {
    id: string
    knowledgeBaseId?: string
    source: string
    queryText: string
    payload: unknown
    evidence?: unknown[]
  }): Promise<string>
  getRetrievalTrace?(traceId: string): Promise<{
    id: string
    knowledgeBaseId: string | null
    source: string
    queryText: string
    payload: any
    answer: string | null
  } | null>
  updateRetrievalTraceAnswer?(traceId: string, answer: string, claims?: unknown[], metrics?: unknown): Promise<void>
  listRetrievalTraces?(knowledgeBaseId?: string, limit?: number): Promise<Array<{
    id: string
    knowledgeBaseId: string | null
    source: string
    queryText: string
    payload: any
    answer: string | null
    createdAt: Date
  }>>

  storeDocumentChunks?(chunks: Array<{
    documentId: string
    chunkIndex: number
    content: string
    pipelineRunId?: string
  }>): Promise<void>
  deleteDocumentChunks?(documentId: string): Promise<void>
  getDocumentChunks?(chunkIds: string[]): Promise<Array<{
    chunkId: string
    documentId: string
    chunkIndex: number
    content: string
  }>>
  /** chunk 级检查点：加载某文档已成功抽取的 chunk 结果（供 resume 跳过 LLM） */
  loadDocumentChunkExtractions?(documentId: string): Promise<Array<{ chunkIndex: number; extraction: unknown }>>
  saveDocumentChunkExtraction?(documentId: string, chunkIndex: number, extraction: unknown): Promise<void>
  deleteDocumentChunkExtractions?(documentId: string): Promise<void>

  // ========== 反馈权重与真值状态（对标 cognee feedback weights / truth state） ==========
  getNodeFeedbackWeights(nodeId: string): Promise<{ positive: number; negative: number } | null>
  setNodeFeedbackWeights(nodeId: string, weights: { positive: number; negative: number }): Promise<void>
  getEdgeFeedbackWeights(sourceId: string, targetId: string, relationshipName: string): Promise<{ positive: number; negative: number } | null>
  setEdgeFeedbackWeights(sourceId: string, targetId: string, relationshipName: string, weights: { positive: number; negative: number }): Promise<void>
  getNodeTruthState(nodeId: string): Promise<{ truthValue: number; lastEvaluatedAt: string | null } | null>
  setNodeTruthState(nodeId: string, state: { truthValue: number }): Promise<void>
}
