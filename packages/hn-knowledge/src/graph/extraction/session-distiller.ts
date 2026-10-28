import type { GraphDB } from '../interface.js'
import type { GraphNode } from '../types.js'
import { EntityExtractor } from './entity-extractor.js'
import { GraphBuilder } from './graph-builder.js'

/**
 * 会话蒸馏器
 *
 * 对标 cognee 的「会话蒸馏」概念：将用户与 AI 的历史对话提取为图结构，
 * 并随时间"蒸馏"——合并重复提及的实体、降低过期信息权重。
 *
 * 用法：
 *   const distiller = new SessionDistiller(adapter)
 *   await distiller.distill(sessionId, messages, kb)
 *   await distiller.consolidate(kb)
 */

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
}

export interface DistillResult {
  totalNodes: number
  totalEdges: number
  mergedCount: number
  decayedCount: number
}

export class SessionDistiller {
  private graph: GraphDB
  private extractor: EntityExtractor
  private builder: GraphBuilder

  constructor(graph: GraphDB, options?: { model?: string }) {
    this.graph = graph
    this.extractor = new EntityExtractor({ model: options?.model })
    this.builder = new GraphBuilder(graph)
  }

  /**
   * 蒸馏一次对话：提取实体/关系，写入图，用 sessionId 盖溯源
   */
  async distill(
    sessionId: string,
    messages: ChatMessage[],
    kb: string
  ): Promise<{ nodes: number; edges: number }> {
    let totalNodes = 0
    let totalEdges = 0

    for (const msg of messages) {
      let extraction
      try {
        extraction = await this.extractor.extract(msg.content)
      } catch {
        extraction = { entities: [], triplets: [] }
      }

      if (extraction.entities.length === 0) {
        // 无实体消息：提取失败时跳过
        continue
      }

      const { nodeIds, edgeCount } = await this.builder.buildFromExtraction(extraction, {
        knowledgeBaseId: kb,
        documentId: `session_${sessionId}`,
        chunkIndex: messages.indexOf(msg),
        pipelineRunId: `session_${sessionId}`,
      })

      totalNodes += nodeIds.length
      totalEdges += edgeCount
    }

    // 在会话节点上记录时间戳
    const sessionNode = await this.graph.findNodeByName(`__session_${sessionId}__`, kb)
    if (!sessionNode) {
      await this.graph.addNode({
        knowledgeBaseId: kb,
        name: `__session_${sessionId}__`,
        type: 'session_marker',
        properties: {
          sessionId,
          messageCount: messages.length,
          lastActivity: new Date().toISOString(),
        },
      })
    } else {
      await this.graph.updateNode(sessionNode.id, {
        properties: {
          ...sessionNode.properties,
          messageCount: ((sessionNode.properties.messageCount as number) || 0) + messages.length,
          lastActivity: new Date().toISOString(),
        },
      })
    }

    return { nodes: totalNodes, edges: totalEdges }
  }

  /**
   * 蒸馏合并：合并重复实体（同名归一），衰减低频过时实体
   *
   * @param kb            知识库 ID
   * @param decayThresholdDays  超过此天数未更新的实体被衰减（默认 7）
   * @param minFrequency        频率低于此值的实体被衰减（默认 2）
   */
  async consolidate(
    kb: string,
    decayThresholdDays: number = 7,
    minFrequency: number = 2
  ): Promise<DistillResult> {
    const graphData = await this.graph.getGraphData(kb)
    const sessionNodes = graphData.nodes.filter((n) => n.type === 'session_marker')
    const entityNodes = graphData.nodes.filter((n) => n.type !== 'session_marker' && n.type !== 'global_context')

    // 1. 同名归一（同 knowledge_base 内基于 name 去重）
    const nameMap = new Map<string, GraphNode>()
    const toMerge: Array<{ keep: GraphNode; remove: GraphNode }> = []
    for (const n of entityNodes) {
      const key = n.name.trim().toLowerCase()
      const existing = nameMap.get(key)
      if (existing) {
        toMerge.push({ keep: existing, remove: n })
      } else {
        nameMap.set(key, n)
      }
    }

    // 2. 频率衰减：低频 / 陈旧节点标记降权
    const now = Date.now()
    const decayThresholdMs = decayThresholdDays * 24 * 60 * 60 * 1000
    let decayedCount = 0
    for (const n of entityNodes) {
      if (n.frequency < minFrequency && n.frequency > 0) {
        const age = now - new Date(n.updatedAt).getTime()
        if (age > decayThresholdMs) {
          await this.graph.updateNode(n.id, { frequency: Math.max(1, n.frequency - 1) })
          decayedCount++
        }
      }
    }

    // 3. 执行合并：迁移边后删除重复节点
    let mergedCount = 0
    for (const { keep, remove } of toMerge) {
      const edges = await this.graph.getEdges(remove.id)
      for (const edge of edges) {
        const exists = await this.graph.hasEdge(keep.id, edge.targetId, edge.relationshipName)
        if (!exists) {
          await this.graph.addEdge({
            sourceId: keep.id,
            targetId: edge.targetId,
            relationshipName: edge.relationshipName,
            weight: edge.weight,
            knowledgeBaseId: kb,
            properties: { ...edge.properties, mergedFrom: remove.id },
          })
        }
      }
      await this.graph.deleteNode(remove.id)
      mergedCount++
    }

    return {
      totalNodes: graphData.nodes.length,
      totalEdges: graphData.edges.length,
      mergedCount,
      decayedCount,
    }
  }
}