import type { GraphDB } from '../interface.js'
import type { GraphNode, GraphEdge, CreateNodeInput, CreateEdgeInput, CombinedExtraction } from '../types.js'
import { entityNodeId, entityTypeNodeId, ENTITY_TYPE_KB } from '../ontology/index.js'

export type EmbedEntityFn = (texts: string[]) => Promise<number[][]>

export interface GraphBuildOptions {
  knowledgeBaseId: string
  pipelineRunId?: string
  chunkIndex?: number
  documentId?: string
  /** 是否为实体类型创建 EntityType 节点 + is_a 边（对齐 cognee EntityType 体系，默认 true） */
  buildEntityTypeNodes?: boolean
}

export class GraphBuilder {
  private graph: GraphDB
  private embedFn?: EmbedEntityFn

  constructor(graph: GraphDB, embedFn?: EmbedEntityFn) {
    this.graph = graph
    this.embedFn = embedFn
  }

  setEmbedFn(fn: EmbedEntityFn | undefined): void {
    this.embedFn = fn
  }

  async buildFromExtraction(
    extraction: CombinedExtraction,
    options: GraphBuildOptions
  ): Promise<{ nodeIds: string[]; edgeCount: number }> {
    if (extraction.entities.length === 0 && extraction.triplets.length === 0) {
      return { nodeIds: [], edgeCount: 0 }
    }

    // 可选：为实体生成嵌入向量（用于图补全检索的语义种子选择）
    let embeddings: number[][] | undefined
    if (this.embedFn) {
      try {
        const texts = extraction.entities.map(
          (e) => `${e.name}${e.description ? `：${e.description}` : ''}`
        )
        embeddings = await this.embedFn(texts)
      } catch (err: any) {
        console.warn(`[图构建] 实体嵌入生成失败（降级为无向量）: ${err.message}`)
      }
    }

    const nodeInputs: CreateNodeInput[] = extraction.entities.map((entity, i) => ({
      // 确定性 id：同 kb 同名实体跨摄入 id 恒定（对齐 cognee Entity.id_for）
      id: entityNodeId(options.knowledgeBaseId, entity.name),
      knowledgeBaseId: options.knowledgeBaseId,
      name: entity.name,
      type: entity.type,
      properties: {
        description: entity.description || '',
        ...(entity.attributes ? { attributes: entity.attributes } : {}),
        ...(options.documentId ? { sourceDocumentId: options.documentId } : {}),
        ...(options.chunkIndex !== undefined ? { sourceChunkIndex: options.chunkIndex } : {}),
        ...(options.pipelineRunId ? { pipelineRunId: options.pipelineRunId } : {}),
      },
      embedding: embeddings?.[i],
    }))

    const nodeIds = await this.graph.addNodes(nodeInputs)

    const nameToId = new Map<string, string>()
    for (let i = 0; i < extraction.entities.length; i++) {
      nameToId.set(extraction.entities[i].name, nodeIds[i])
    }

    // 对齐 cognee EntityType 体系：为实体的类型创建 EntityType 节点 + is_a 边
    // （EntityType 节点放独立虚拟 kb，不污染业务 kb 的节点统计）
    if (options.buildEntityTypeNodes !== false) {
      await this.ensureEntityTypeNodes(extraction, options, nameToId)
    }

    if (extraction.triplets.length === 0) {
      return { nodeIds, edgeCount: 0 }
    }

    const edgeInputs: CreateEdgeInput[] = []
    for (const triplet of extraction.triplets) {
      const sourceId = nameToId.get(triplet.source)
      const targetId = nameToId.get(triplet.target)

      if (!sourceId || !targetId) {
        console.warn(`[图构建] 跳过三元组: 找不到实体 "${triplet.source}" 或 "${triplet.target}"`)
        continue
      }

      if (triplet.confidence < 0.3) {
        continue
      }

      edgeInputs.push({
        sourceId,
        targetId,
        relationshipName: triplet.relation,
        knowledgeBaseId: options.knowledgeBaseId,
        // 权重契约：weight >= evidence count（每个 distinct source 至少贡献 1）
        weight: Math.max(triplet.confidence, 1),
        properties: {
          ...(options.documentId ? { sourceDocumentId: options.documentId } : {}),
          ...(options.chunkIndex !== undefined ? { sourceChunkIndex: options.chunkIndex } : {}),
          ...(options.pipelineRunId ? { pipelineRunId: options.pipelineRunId } : {}),
          ...(triplet.effectiveDate ? { effectiveDate: triplet.effectiveDate } : {}),
          extractedAt: new Date().toISOString(),
        },
      })
    }

    if (edgeInputs.length > 0) {
      await this.graph.addEdges(edgeInputs)
    }

    // 写入文档-节点关联表（溯源主路径：供按文档删除/按 run 回滚使用）
    if (options.documentId && nodeIds.length > 0 && typeof (this.graph as any).linkNodesToDocument === 'function') {
      try {
        await (this.graph as any).linkNodesToDocument({
          documentId: options.documentId,
          nodeIds,
          chunkIndex: options.chunkIndex,
          pipelineRunId: options.pipelineRunId,
        })
      } catch (err: any) {
        console.warn(`[图构建] 文档-节点关联写入失败（不影响主流程）: ${err.message}`)
      }
    }

    return { nodeIds, edgeCount: edgeInputs.length }
  }

  /**
   * 为实体的类型创建 EntityType 节点（幂等）+ 实体 → EntityType 的 is_a 边
   *
   * 对齐 cognee EntityType 体系：
   * - EntityType 节点：独立虚拟 kb `__entity_types__`，确定性 id，type='entity_type'
   * - is_a 边：从业务 kb 的实体节点指向 EntityType 节点（边归属业务 kb，可被业务图检索）
   */
  private async ensureEntityTypeNodes(
    extraction: CombinedExtraction,
    options: GraphBuildOptions,
    nameToId: Map<string, string>
  ): Promise<void> {
    // 收集本次提取出现的类型（去重）
    const typeNames = [...new Set(extraction.entities.map((e) => e.type).filter(Boolean))]

    // 为每个类型 upsert EntityType 节点（虚拟 kb，确定性 id）
    const typeInputs: CreateNodeInput[] = typeNames.map((typeName) => ({
      id: entityTypeNodeId(typeName),
      knowledgeBaseId: ENTITY_TYPE_KB,
      name: typeName,
      type: 'entity_type',
      properties: { kind: 'EntityType' },
    }))
    if (typeInputs.length > 0) {
      await this.graph.addNodes(typeInputs)
    }

    // is_a 边：实体 → EntityType（幂等由 addEdge upsert 保证）
    // 边归属虚拟 kb `__entity_types__`：实体节点在业务 kb，但边按 nodeId 查询
    // （getEdges）仍可达；归虚拟 kb 避免污染业务 kb 的 getGraphData 统计
    const isaEdges: CreateEdgeInput[] = []
    for (const entity of extraction.entities) {
      const entityId = nameToId.get(entity.name)
      if (!entityId || !entity.type) continue
      isaEdges.push({
        sourceId: entityId,
        targetId: entityTypeNodeId(entity.type),
        relationshipName: 'is_a',
        knowledgeBaseId: ENTITY_TYPE_KB,
        weight: 1,
        properties: {
          ...(options.documentId ? { sourceDocumentId: options.documentId } : {}),
          ...(options.pipelineRunId ? { pipelineRunId: options.pipelineRunId } : {}),
        },
      })
    }
    if (isaEdges.length > 0) {
      await this.graph.addEdges(isaEdges)
    }
  }
}
