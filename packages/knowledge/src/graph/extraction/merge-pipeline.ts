import type { GraphDB } from '../interface.js'
import type { EntityChunkTracker } from './entity-chunk-tracker.js'
import type { CreateNodeInput, CreateEdgeInput, CombinedExtraction } from '../types.js'
import type { EmbedEntityFn } from './graph-builder.js'
import { entityNodeId, entityTypeNodeId, ENTITY_TYPE_KB } from '../ontology/index.js'
import { OntologyValidator } from '../ontology/index.js'
import type { OntologyConfig, OntologyValidationResult } from '../ontology/index.js'

export interface ChunkExtraction {
  extraction: CombinedExtraction
  chunkId: string
  chunkIndex: number
  documentId?: string
  /** chunk 来源页码（对标 TrustGraph Document→Page→Chunk 链的 Page 层） */
  pageIndex?: number
  pipelineRunId?: string
  /** chunk 原文（可选）：提供后用于提取实体上下文片段，增强嵌入语义（对标 TrustGraph EntityContexts） */
  chunkText?: string
}

export interface MergeOptions {
  knowledgeBaseId: string
  /** 绑定本次抽取使用的不可变 ontology 快照 */
  ontologyVersion?: string
  buildEntityTypeNodes?: boolean
  /** 本体约束：传入后写入前做 domain/range 硬校验，剔除违规实体/三元组（对标 TrustGraph OntoRAG is_valid_triple） */
  ontology?: OntologyConfig
}

export interface MergeResult {
  nodeIds: string[]
  edgeCount: number
  mergedEntities: number
  mergedRelations: number
  /** 本体硬校验剔除明细（仅传入 ontology 时产生） */
  violations?: OntologyValidationResult['violations']
}

/**
 * 跨 chunk 实体合并管线（对标 LightRAG merge_nodes_and_edges）
 *
 * 流程：
 * 1. 收集所有 chunk 的提取结果
 * 2. 按实体名称聚合，合并描述和类型（Counter 统计）
 * 3. 按 (src, rel, tgt) 聚合关系，合并权重和 chunk 引用
 * 4. 写前日志：先持久化候选列表到 chunk tracking
 * 5. 一次性写入图存储
 * 6. 写入 chunk tracking 关联
 */
export class GraphMergePipeline {
  private graph: GraphDB
  private tracker: EntityChunkTracker
  private embedFn?: EmbedEntityFn

  constructor(
    graph: GraphDB,
    tracker: EntityChunkTracker,
    embedFn?: EmbedEntityFn
  ) {
    this.graph = graph
    this.tracker = tracker
    this.embedFn = embedFn
  }

  setEmbedFn(fn: EmbedEntityFn | undefined): void {
    this.embedFn = fn
  }

  async merge(
    chunks: ChunkExtraction[],
    options: MergeOptions
  ): Promise<MergeResult> {
    const { knowledgeBaseId } = options
    let filtered = chunks.filter((c) => c.extraction.entities.length > 0 || c.extraction.triplets.length > 0)

    // === Phase -1: 本体硬校验（对标 TrustGraph OntoRAG is_valid_triple 写前校验） ===
    let violations: OntologyValidationResult['violations'] | undefined
    if (options.ontology) {
      const validator = new OntologyValidator(options.ontology)
      violations = []
      const validated: ChunkExtraction[] = []
      for (const chunk of filtered) {
        const result = validator.validate(chunk.extraction)
        violations.push(...result.violations)
        validated.push({ ...chunk, extraction: result.filtered })
      }
      filtered = validated.filter((c) => c.extraction.entities.length > 0 || c.extraction.triplets.length > 0)
      if (violations.length > 0) {
        console.warn(`[合并管线] 本体校验剔除 ${violations.length} 项违规（实体/三元组）`)
      }
    }

    if (filtered.length === 0) {
      return { nodeIds: [], edgeCount: 0, mergedEntities: 0, mergedRelations: 0, violations }
    }

    // === Phase 1: 聚合实体 ===
    // allEntities[entityNameLower] = { name, types: Counter, descriptions: [], chunkIds: Set, ... }
    const allEntities = new Map<string, {
      name: string
      types: Map<string, number>
      descriptions: string[]
      attributes: Array<{ name: string; value: string | number | boolean; datatype?: string }>
      contextSnippets: string[]
      chunkIds: Set<string>
      documentIds: Set<string>
      pipelineRunIds: Set<string>
    }>()

    for (const chunk of filtered) {
      for (const entity of chunk.extraction.entities) {
        const key = entity.name.toLowerCase().trim()
        if (!key) continue
        if (!allEntities.has(key)) {
          allEntities.set(key, {
            name: entity.name.trim(),
            types: new Map(),
            descriptions: [],
            attributes: [],
            contextSnippets: [],
            chunkIds: new Set(),
            documentIds: new Set(),
            pipelineRunIds: new Set(),
          })
        }
        const entry = allEntities.get(key)!
        entry.types.set(entity.type, (entry.types.get(entity.type) || 0) + 1)
        if (entity.description) {
          entry.descriptions.push(entity.description)
        }
        if (entity.attributes) {
          entry.attributes.push(...entity.attributes)
        }
        if (chunk.chunkText) {
          const snippets = extractContextSnippets(chunk.chunkText, entry.name)
          entry.contextSnippets.push(...snippets)
        }
        entry.chunkIds.add(chunk.chunkId)
        if (chunk.documentId) entry.documentIds.add(chunk.documentId)
        if (chunk.pipelineRunId) entry.pipelineRunIds.add(chunk.pipelineRunId)
      }
    }

    // === Phase 2: 聚合关系 ===
    // allRelations[key] = { source, target, relation, confidences: [], chunkIds: Set, ... }
    const allRelations = new Map<string, {
      source: string
      target: string
      relation: string
      confidences: number[]
      chunkIds: Set<string>
      documentIds: Set<string>
      pipelineRunIds: Set<string>
      effectiveDates: Set<string>
    }>()

    for (const chunk of filtered) {
      for (const triplet of chunk.extraction.triplets) {
        const srcKey = triplet.source.toLowerCase().trim()
        const tgtKey = triplet.target.toLowerCase().trim()
        if (!srcKey || !tgtKey || srcKey === tgtKey) continue
        if (!allEntities.has(srcKey) || !allEntities.has(tgtKey)) continue

        const relKey = `${srcKey}|${triplet.relation.trim()}|${tgtKey}`
        if (!allRelations.has(relKey)) {
          allRelations.set(relKey, {
            source: triplet.source.trim(),
            target: triplet.target.trim(),
            relation: triplet.relation.trim(),
            confidences: [],
            chunkIds: new Set(),
            documentIds: new Set(),
            pipelineRunIds: new Set(),
            effectiveDates: new Set(),
          })
        }
        const entry = allRelations.get(relKey)!
        entry.confidences.push(triplet.confidence)
        entry.chunkIds.add(chunk.chunkId)
        if (chunk.documentId) entry.documentIds.add(chunk.documentId)
        if (chunk.pipelineRunId) entry.pipelineRunIds.add(chunk.pipelineRunId)
        if (triplet.effectiveDate) entry.effectiveDates.add(triplet.effectiveDate)
      }
    }

    // === Phase 3: 写前日志 — 先持久化 chunk tracking（Phase 0 等价） ===
    // 这一步在修改图之前完成，确保崩溃后可恢复
    for (const [key, entry] of allEntities) {
      for (const chunkId of entry.chunkIds) {
        const eid = entityNodeId(knowledgeBaseId, entry.name)
        await this.tracker.addEntityChunk(eid, chunkId, knowledgeBaseId)
      }
    }
    for (const [, entry] of allRelations) {
      const srcEid = entityNodeId(knowledgeBaseId, entry.source)
      const tgtEid = entityNodeId(knowledgeBaseId, entry.target)
      for (const chunkId of entry.chunkIds) {
        await this.tracker.addRelationChunk(srcEid, tgtEid, entry.relation, chunkId, knowledgeBaseId)
      }
    }

    // === Phase 4: 构建实体写入 ===
    const entityNames = [...allEntities.values()]
    const ontologyNodes = new Map((options.ontology?.nodes || []).map((node) => [node.type, node]))
    const ontologyEdges = new Map((options.ontology?.edges || []).map((edge) => [edge.name, edge]))
    // 嵌入文本 = 实体名 + 描述 + 上下文片段（对标 TrustGraph EntityContexts：
    // 实体的文本上下文参与嵌入，使同名实体可按出现语境被召回）
    const entityTexts = entityNames.map((e) => buildEntityEmbeddingText(e))

    let embeddings: number[][] | undefined
    if (this.embedFn && entityTexts.length > 0) {
      try {
        embeddings = await this.embedFn(entityTexts)
      } catch (err: any) {
        console.warn(`[合并管线] 实体嵌入生成失败（降级无向量）: ${err.message}`)
      }
    }

    const nodeInputs: CreateNodeInput[] = entityNames.map((entry, i) => {
      // 类型取出现最多的
      const bestType = [...entry.types.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'entity'
      // 描述取最长
      const bestDesc = entry.descriptions.sort((a, b) => b.length - a.length)[0] || ''

      const props: Record<string, unknown> = {
        description: bestDesc,
        ...(entry.attributes.length > 0 ? { attributes: dedupeAttributes(entry.attributes) } : {}),
        mergedChunkCount: entry.chunkIds.size,
        mergedFromChunks: [...entry.chunkIds],
      }
      const ontologyNode = ontologyNodes.get(bestType)
      if (ontologyNode?.uri) props.ontologyClassUri = ontologyNode.uri
      if (options.ontologyVersion) props.ontologyVersion = options.ontologyVersion
      if (entry.documentIds.size > 0) {
        props.sourceDocumentIds = [...entry.documentIds]
      }
      if (entry.pipelineRunIds.size > 0) {
        props.pipelineRunIds = [...entry.pipelineRunIds]
      }

      return {
        id: entityNodeId(knowledgeBaseId, entry.name),
        knowledgeBaseId,
        name: entry.name,
        type: bestType,
        properties: props,
        embedding: embeddings?.[i],
        frequency: entry.chunkIds.size,
      }
    })

    const nodeIds = await this.graph.addNodes(nodeInputs)

    // 根据 name 查询实际写入的 id
    const nameToId = new Map<string, string>()
    for (let i = 0; i < entityNames.length; i++) {
      nameToId.set(entityNames[i].name.toLowerCase(), nodeIds[i])
    }

    // EntityType 节点
    if (options.buildEntityTypeNodes !== false) {
      await this.ensureEntityTypeNodes(entityNames, knowledgeBaseId, nameToId)
    }

    // === Phase 5: 文档-节点关联（chunk 级溯源：每个 chunk 只关联它实际抽取出的实体） ===
    const allNodeIds = [...nameToId.values()]
    for (const chunk of filtered) {
      if (!chunk.documentId || allNodeIds.length === 0) continue
      if (typeof (this.graph as any).linkNodesToDocument !== 'function') continue
      const chunkNodeIds = chunk.extraction.entities
        .map((e) => nameToId.get(e.name.toLowerCase().trim()))
        .filter((id): id is string => Boolean(id))
      if (chunkNodeIds.length === 0) continue
      try {
        await (this.graph as any).linkNodesToDocument({
          documentId: chunk.documentId,
          nodeIds: chunkNodeIds,
          chunkIndex: chunk.chunkIndex,
          pageIndex: chunk.pageIndex,
          pipelineRunId: chunk.pipelineRunId,
        })
      } catch (err: any) {
        console.warn(`[合并管线] 文档-节点关联写入失败: ${err.message}`)
      }
    }

    // === Phase 6: 构建关系写入 ===
    if (allRelations.size === 0) {
      return { nodeIds, edgeCount: 0, mergedEntities: entityNames.length, mergedRelations: 0, violations }
    }

    const edgeInputs: CreateEdgeInput[] = []
    for (const [, entry] of allRelations) {
      const srcKey = entry.source.toLowerCase()
      const tgtKey = entry.target.toLowerCase()
      const sourceId = nameToId.get(srcKey)
      const targetId = nameToId.get(tgtKey)
      if (!sourceId || !targetId) {
        console.warn(`[合并管线] 跳过关系: 找不到实体 "${entry.source}" 或 "${entry.target}"`)
        continue
      }

      // 权重契约：weight = max(平均置信度, distinct chunk 数)
      const avgConfidence = entry.confidences.reduce((s, v) => s + v, 0) / entry.confidences.length
      const evidenceCount = entry.chunkIds.size
      const weight = Math.max(avgConfidence, evidenceCount)

      const props: Record<string, unknown> = {
        mergedChunkCount: evidenceCount,
        mergedFromChunks: [...entry.chunkIds],
        extractedAt: new Date().toISOString(),
      }
      const ontologyEdge = ontologyEdges.get(entry.relation)
      if (ontologyEdge?.uri) props.ontologyPropertyUri = ontologyEdge.uri
      if (ontologyEdge?.kind) props.ontologyPropertyKind = ontologyEdge.kind
      if (options.ontologyVersion) props.ontologyVersion = options.ontologyVersion
      if (entry.documentIds.size > 0) {
        props.sourceDocumentIds = [...entry.documentIds]
      }
      if (entry.pipelineRunIds.size > 0) {
        props.pipelineRunIds = [...entry.pipelineRunIds]
      }
      if (entry.effectiveDates.size === 1) {
        props.effectiveDate = entry.effectiveDates.values().next().value
      } else if (entry.effectiveDates.size > 1) {
        props.effectiveDates = [...entry.effectiveDates]
      }

      edgeInputs.push({
        sourceId,
        targetId,
        relationshipName: entry.relation,
        knowledgeBaseId,
        weight,
        properties: props,
      })
    }

    if (edgeInputs.length > 0) {
      await this.graph.addEdges(edgeInputs)
    }

    return {
      nodeIds,
      edgeCount: edgeInputs.length,
      mergedEntities: entityNames.length,
      mergedRelations: allRelations.size,
      violations,
    }
  }

  private async ensureEntityTypeNodes(
    entities: Array<{ name: string; types: Map<string, number> }>,
    knowledgeBaseId: string,
    nameToId: Map<string, string>
  ): Promise<void> {
    const typeNames = new Set<string>()
    for (const entry of entities) {
      for (const type of entry.types.keys()) {
        if (type) typeNames.add(type)
      }
    }
    if (typeNames.size === 0) return

    const typeInputs: CreateNodeInput[] = [...typeNames].map((typeName) => ({
      id: entityTypeNodeId(typeName),
      knowledgeBaseId: ENTITY_TYPE_KB,
      name: typeName,
      type: 'entity_type',
      properties: { kind: 'EntityType' },
    }))
    await this.graph.addNodes(typeInputs)

    const isaEdges: CreateEdgeInput[] = []
    for (const entry of entities) {
      const entityId = nameToId.get(entry.name.toLowerCase())
      if (!entityId) continue
      const bestType = [...entry.types.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      if (!bestType) continue
      isaEdges.push({
        sourceId: entityId,
        targetId: entityTypeNodeId(bestType),
        relationshipName: 'is_a',
        knowledgeBaseId: ENTITY_TYPE_KB,
        weight: 1,
        properties: {},
      })
    }
    if (isaEdges.length > 0) {
      await this.graph.addEdges(isaEdges)
    }
  }
}

function dedupeAttributes(
  attributes: Array<{ name: string; value: string | number | boolean; datatype?: string }>
): Array<{ name: string; value: string | number | boolean; datatype?: string }> {
  const seen = new Set<string>()
  return attributes.filter((attribute) => {
    const key = `${attribute.name}|${String(attribute.value)}|${attribute.datatype || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 实体嵌入文本最大长度（超出截断，避免单条嵌入文本过长稀释语义） */
const MAX_ENTITY_EMBEDDING_TEXT = 512

/**
 * 构建实体嵌入文本：实体名 + 描述 + 上下文片段
 * （对标 TrustGraph EntityContexts：实体名 + 定义文本作为嵌入上下文）
 */
function buildEntityEmbeddingText(entry: {
  name: string
  descriptions: string[]
  contextSnippets: string[]
}): string {
  const desc = entry.descriptions.filter(Boolean).sort((a, b) => b.length - a.length)[0] || ''
  const snippets = dedupe(entry.contextSnippets).slice(0, 2)
  let text = entry.name
  if (desc) text += `：${desc}`
  if (snippets.length > 0) text += `；上下文：${snippets.join('；')}`
  return text.length > MAX_ENTITY_EMBEDDING_TEXT ? text.slice(0, MAX_ENTITY_EMBEDDING_TEXT) : text
}

/**
 * 从 chunk 原文中提取实体名周围的上下文窗口片段（大小写不敏感，最多 2 个）
 */
export function extractContextSnippets(
  text: string,
  entityName: string,
  windowSize = 60,
  maxSnippets = 2
): string[] {
  if (!text || !entityName) return []
  const lowerText = text.toLowerCase()
  const needle = entityName.toLowerCase().trim()
  if (!needle) return []

  const snippets: string[] = []
  let from = 0
  while (snippets.length < maxSnippets) {
    const idx = lowerText.indexOf(needle, from)
    if (idx === -1) break
    const start = Math.max(0, idx - windowSize)
    const end = Math.min(text.length, idx + needle.length + windowSize)
    const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim()
    if (snippet) snippets.push(snippet)
    from = idx + needle.length
  }
  return snippets
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}
