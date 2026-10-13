import { Pool } from 'pg'
import { GraphRepository } from './repository.js'
import { GraphTraversal } from './traversal.js'
import { PgEntityChunkTracker } from '../extraction/entity-chunk-tracker.js'
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
} from '../types.js'
import type { GraphDB } from '../interface.js'
import { PgRdfQuadStore } from '../rdf/pg-quad-store.js'
import { PgOntologyRegistry } from '../ontology/pg-registry.js'

export class PgGraphAdapter implements GraphDB {
  public repository: GraphRepository
  public traversal: GraphTraversal
  public chunkTracker: PgEntityChunkTracker
  public rdfStore: PgRdfQuadStore
  public ontologyRegistry: PgOntologyRegistry
  readonly supportsCypherQueries: boolean = false

  constructor(
    private pool: Pool,
    private schemaName: string,
    embeddingDimension?: number
  ) {
    this.repository = new GraphRepository(pool, schemaName, embeddingDimension)
    this.traversal = new GraphTraversal(pool, schemaName)
    this.chunkTracker = new PgEntityChunkTracker(pool, schemaName)
    this.rdfStore = new PgRdfQuadStore(pool, schemaName)
    this.ontologyRegistry = new PgOntologyRegistry(pool, schemaName)
  }

  async init(): Promise<void> {
    await this.repository.initTables()
    await this.chunkTracker.initTables()
    await this.rdfStore.init()
    await this.ontologyRegistry.init()
  }

  async isGraphEmpty(knowledgeBaseId?: string): Promise<boolean> {
    const count = await this.repository.getNodeCount(knowledgeBaseId)
    return count === 0
  }

  async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    return this.repository.query(sql, params)
  }

  async addNode(input: CreateNodeInput): Promise<string> {
    return this.repository.addNode(input)
  }

  async addNodes(inputs: CreateNodeInput[]): Promise<string[]> {
    return this.repository.addNodes(inputs)
  }

  async getNode(id: string): Promise<GraphNode | null> {
    return this.repository.getNode(id)
  }

  async getNodes(ids: string[]): Promise<GraphNode[]> {
    return this.repository.getNodes(ids)
  }

  async deleteNode(id: string): Promise<void> {
    await this.repository.deleteNode(id)
  }

  async deleteNodes(ids: string[]): Promise<void> {
    await this.repository.deleteNodes(ids)
  }

  async updateNode(id: string, data: UpdateNodeInput): Promise<void> {
    await this.repository.updateNode(id, data)
  }

  async findNodeByName(name: string, knowledgeBaseId?: string): Promise<GraphNode | null> {
    return this.repository.findNodeByName(name, knowledgeBaseId)
  }

  async findNodesByType(type: string, knowledgeBaseId?: string): Promise<GraphNode[]> {
    return this.repository.findNodesByType(type, knowledgeBaseId)
  }

  async addEdge(input: CreateEdgeInput): Promise<void> {
    await this.repository.addEdge(input)
  }

  async addEdges(inputs: CreateEdgeInput[]): Promise<void> {
    await this.repository.addEdges(inputs)
  }

  async getEdges(nodeId: string): Promise<GraphEdge[]> {
    return this.repository.getEdges(nodeId)
  }

  async hasEdge(sourceId: string, targetId: string, relationshipName: string): Promise<boolean> {
    return this.repository.hasEdge(sourceId, targetId, relationshipName)
  }

  async hasEdges(edges: Array<Pick<CreateEdgeInput, 'sourceId' | 'targetId' | 'relationshipName'>>): Promise<CreateEdgeInput[]> {
    return this.repository.hasEdges(edges)
  }

  async deleteEdge(sourceId: string, targetId: string, relationshipName: string): Promise<void> {
    await this.repository.deleteEdge(sourceId, targetId, relationshipName)
  }

  async getNeighbors(nodeId: string): Promise<NeighborResult[]> {
    return this.repository.getNeighbors(nodeId)
  }

  async getNeighborhood(input: NeighborhoodInput): Promise<Subgraph> {
    return this.traversal.getNeighborhood(input)
  }

  async getConnections(nodeId: string): Promise<ConnectionResult[]> {
    return this.repository.getConnections(nodeId)
  }

  async getSubgraph(filter?: SubgraphFilter): Promise<Subgraph> {
    if (filter?.attributeFilters) {
      return this.repository.getFilteredGraphData(filter.attributeFilters, filter.knowledgeBaseId)
    }
    return this.repository.getGraphData(filter?.knowledgeBaseId)
  }

  async findPaths(sourceId: string, targetId: string, maxDepth?: number): Promise<Path[]> {
    return this.traversal.findPaths(sourceId, targetId, maxDepth)
  }

  async getGraphData(knowledgeBaseId?: string): Promise<Subgraph> {
    return this.repository.getGraphData(knowledgeBaseId)
  }

  async getFilteredGraphData(attributeFilters: Record<string, unknown>, knowledgeBaseId?: string): Promise<Subgraph> {
    return this.repository.getFilteredGraphData(attributeFilters, knowledgeBaseId)
  }

  async getGraphMetrics(knowledgeBaseId?: string): Promise<GraphMetrics> {
    return this.repository.getGraphMetrics(knowledgeBaseId)
  }

  async deleteGraph(knowledgeBaseId?: string): Promise<void> {
    await this.repository.deleteGraph(knowledgeBaseId)
    if (knowledgeBaseId) {
      await this.chunkTracker.clearKnowledgeBase(knowledgeBaseId)
    } else {
      await this.repository.query(`DELETE FROM ${this.schemaName}.entity_chunks`)
      await this.repository.query(`DELETE FROM ${this.schemaName}.relation_chunks`)
    }
  }

  async getNodeCount(knowledgeBaseId?: string): Promise<number> {
    return this.repository.getNodeCount(knowledgeBaseId)
  }

  async getEdgeCount(knowledgeBaseId?: string): Promise<number> {
    return this.repository.getEdgeCount(knowledgeBaseId)
  }

  async getNodeFeedbackWeights(nodeId: string) {
    return this.repository.getNodeFeedbackWeights(nodeId)
  }

  async setNodeFeedbackWeights(nodeId: string, weights: { positive: number; negative: number }) {
    await this.repository.setNodeFeedbackWeights(nodeId, weights)
  }

  async getEdgeFeedbackWeights(sourceId: string, targetId: string, relationshipName: string) {
    return this.repository.getEdgeFeedbackWeights(sourceId, targetId, relationshipName)
  }

  async setEdgeFeedbackWeights(sourceId: string, targetId: string, relationshipName: string, weights: { positive: number; negative: number }) {
    await this.repository.setEdgeFeedbackWeights(sourceId, targetId, relationshipName, weights)
  }

  async getNodeTruthState(nodeId: string) {
    return this.repository.getNodeTruthState(nodeId)
  }

  async setNodeTruthState(nodeId: string, state: { truthValue: number }) {
    await this.repository.setNodeTruthState(nodeId, state)
  }

  async linkNodesToDocument(input: {
    documentId: string
    nodeIds: string[]
    chunkIndex?: number
    pageIndex?: number
    pipelineRunId?: string
  }) {
    await this.repository.linkNodesToDocument(input)
  }

  async getProvenanceLinks(nodeIds: string[]): Promise<Array<{
    nodeId: string
    documentId: string
    chunkIndex: number | null
    pageIndex: number | null
    pipelineRunId: string | null
  }>> {
    return this.repository.getProvenanceLinks(nodeIds)
  }

  async getNodeIdsByDocument(documentId: string): Promise<string[]> {
    return this.repository.getNodeIdsByDocument(documentId)
  }

  async getDocumentsByNodeIds(nodeIds: string[]): Promise<Map<string, string[]>> {
    return this.repository.getDocumentsByNodeIds(nodeIds)
  }

  async getNodeIdsByPipelineRun(pipelineRunId: string): Promise<string[]> {
    return this.repository.getNodeIdsByPipelineRun(pipelineRunId)
  }

  async getNodeIdsByProperty(propName: string, propValue: string, knowledgeBaseId?: string): Promise<string[]> {
    return this.repository.getNodeIdsByProperty(propName, propValue, knowledgeBaseId)
  }

  async deleteDocumentLinks(documentId: string) {
    await this.repository.deleteDocumentLinks(documentId)
  }

  async storeDocumentChunks(chunks: Array<{
    documentId: string
    chunkIndex: number
    content: string
    pipelineRunId?: string
  }>) {
    await this.repository.storeDocumentChunks(chunks)
  }

  async deleteDocumentChunks(documentId: string) {
    await this.repository.deleteDocumentChunks(documentId)
  }

  async getDocumentChunks(chunkIds: string[]) {
    return this.repository.getDocumentChunks(chunkIds)
  }

  async loadDocumentChunkExtractions(documentId: string) {
    return this.repository.loadDocumentChunkExtractions(documentId)
  }

  async saveDocumentChunkExtraction(documentId: string, chunkIndex: number, extraction: unknown, chunkHash?: string) {
    await this.repository.saveDocumentChunkExtraction(documentId, chunkIndex, extraction, chunkHash)
  }

  async deleteDocumentChunkExtractions(documentId: string) {
    await this.repository.deleteDocumentChunkExtractions(documentId)
  }

  async storeRetrievalTrace(input: Parameters<GraphRepository['storeRetrievalTrace']>[0]) {
    return this.repository.storeRetrievalTrace(input)
  }

  async getRetrievalTrace(traceId: string) {
    return this.repository.getRetrievalTrace(traceId)
  }

  async updateRetrievalTraceAnswer(traceId: string, answer: string, claims?: unknown[], metrics?: unknown) {
    await this.repository.updateRetrievalTraceAnswer(traceId, answer, claims, metrics)
  }

  async listRetrievalTraces(knowledgeBaseId?: string, limit?: number) {
    return this.repository.listRetrievalTraces(knowledgeBaseId, limit)
  }

  async findSimilarNodesByEmbedding(input: {
    embedding: number[]
    topK: number
    knowledgeBaseId?: string
    excludeTypes?: string[]
  }): Promise<import('../types.js').GraphNode[]> {
    return this.repository.findSimilarNodesByEmbedding(input)
  }

  async getSubgraphByNodeSetLabel(nodeSetLabel: string, knowledgeBaseId?: string): Promise<Subgraph> {
    return this.traversal.getSubgraphByNodeSetLabel(nodeSetLabel, knowledgeBaseId)
  }

  async getTripletsBatch(input: {
    limit: number
    offset?: number
    knowledgeBaseId?: string
  }) {
    return this.repository.getTripletsBatch(input)
  }
}
