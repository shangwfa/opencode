import { z } from 'zod'
import { getDefaultChatModel } from '../../config/env.js'
import type { GraphDB } from '../interface.js'
import type { GraphNode, GraphEdge } from '../types.js'

export interface Contradiction {
  sourceNode: GraphNode
  targetNode: GraphNode
  relation1: string
  relation2: string
  confidence: number
  description: string
}

export interface ContradictionResult {
  contradictions: Contradiction[]
  resolvedCount: number
  /** LLM 语义比对发现的矛盾（升级能力） */
  semanticContradictions: SemanticContradiction[]
  /** 已写入的 contradicts 边数量 */
  contradictsEdgesWritten: number
}

export interface SemanticContradiction {
  sourceNode: GraphNode
  targetNode: GraphNode
  reason: string
  confidence: number
}

const SemanticContradictionSchema = z.object({
  contradictions: z.array(
    z.object({
      factA: z.string().describe('第一条事实（原样引用）'),
      factB: z.string().describe('第二条事实（原样引用）'),
      reason: z.string().describe('矛盾原因'),
      confidence: z.number().min(0).max(1).describe('置信度'),
    })
  ).describe('发现的矛盾对列表，无矛盾则返回空数组'),
})

export class ContradictionDetector {
  private graph: GraphDB
  private modelName: string | null
  private maxLLMNodes: number

  constructor(graph: GraphDB, options?: { model?: string | null; maxLLMNodes?: number }) {
    this.graph = graph
    this.modelName = options?.model === undefined ? getDefaultChatModel() : options.model
    this.maxLLMNodes = options?.maxLLMNodes ?? 200
  }

  /**
   * 懒加载 LLM（避免模块导入期拉起 provider 链）
   */
  private async resolveModelLazy(): Promise<any | null> {
    if (this.modelName === null) return null
    try {
      const [{ generateObject }, { resolveModel }] = await Promise.all([
        import('ai'),
        import('../../utils/model-resolver.js'),
      ])
      const model = resolveModel(this.modelName)
      return { generateObject, model }
    } catch {
      return null
    }
  }

  async detect(knowledgeBaseId?: string): Promise<ContradictionResult> {
    const graphData = await this.graph.getGraphData(knowledgeBaseId)
    const contradictions: Contradiction[] = []

    const nodePairs = this.findDirectContradictions(graphData.nodes, graphData.edges)
    contradictions.push(...nodePairs)

    const temporalPairs = this.findTemporalContradictions(graphData.nodes, graphData.edges)
    contradictions.push(...temporalPairs)

    const structuralPairs = this.findStructuralContradictions(graphData.nodes, graphData.edges)
    contradictions.push(...structuralPairs)

    // 升级：LLM 语义比对（1-hop 邻域内事实比对）+ 写 contradicts 边
    let semanticContradictions: SemanticContradiction[] = []
    let contradictsEdgesWritten = 0
    try {
      const semanticResult = await this.detectSemantic(graphData.nodes, graphData.edges)
      semanticContradictions = semanticResult.contradictions
      contradictsEdgesWritten = semanticResult.edgesWritten
    } catch (err: any) {
      console.warn(`[矛盾检测] LLM 语义比对失败（降级为纯规则）: ${err.message}`)
    }

    return {
      contradictions,
      resolvedCount: temporalPairs.length,
      semanticContradictions,
      contradictsEdgesWritten,
    }
  }

  /**
   * LLM 语义矛盾比对（对标 cognee detect_contradictions.py）
   * 对每个节点的 1-hop 邻域内事实做结构化比对，写带置信度/reason 的 contradicts 边
   */
  private async detectSemantic(
    nodes: GraphNode[],
    edges: GraphEdge[]
  ): Promise<{ contradictions: SemanticContradiction[]; edgesWritten: number }> {
    const llm = await this.resolveModelLazy()
    if (!llm) return { contradictions: [], edgesWritten: 0 }
    const { generateObject, model } = llm

    const nodesById = new Map(nodes.map((n) => [n.id, n]))
    // 按度数取 Top-N 节点做 LLM 比对（控制成本）
    const degreeMap = new Map<string, number>()
    for (const e of edges) {
      degreeMap.set(e.sourceId, (degreeMap.get(e.sourceId) || 0) + 1)
      degreeMap.set(e.targetId, (degreeMap.get(e.targetId) || 0) + 1)
    }
    const topNodes = [...degreeMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.maxLLMNodes)
      .map(([id]) => nodesById.get(id))
      .filter((n): n is GraphNode => !!n)

    const contradictions: SemanticContradiction[] = []
    let edgesWritten = 0

    for (const node of topNodes) {
      const neighborEdges = edges.filter(
        (e) => (e.sourceId === node.id || e.targetId === node.id) &&
          e.relationshipName !== 'contradicts' &&
          e.properties?.superseded !== true
      )
      if (neighborEdges.length < 2) continue

      const facts = neighborEdges
        .slice(0, 15)
        .map((e) => {
          const other = e.sourceId === node.id ? e.targetId : e.sourceId
          const otherName = nodesById.get(other)?.name || other
          const arrow = e.sourceId === node.id ? `--[${e.relationshipName}]-->` : `<--[${e.relationshipName}]--`
          return `【${node.name}】${arrow}【${otherName}】`
        })
        .join('\n')

      try {
        const resp = await generateObject({
          model,
          schema: SemanticContradictionSchema,
          prompt: `比对以下知识图谱中实体「${node.name}」的邻域事实，找出互相矛盾的事实对。

事实列表：
${facts}

只报告语义上真正矛盾的 factA/factB（互斥、不可能同时成立），不要报告单纯不同的信息。无矛盾则返回空数组。`,
          temperature: 0.1,
        })

        for (const c of resp.object.contradictions) {
          if (c.confidence < 0.5) continue
          // 从事实文本反解目标节点名（【name】格式）
          const matchA = /【([^】]+)】/.exec(c.factA)
          const matchB = /【([^】]+)】/.exec(c.factB)
          const otherName = matchA?.[1] === node.name ? matchB?.[1] : matchA?.[1]
          if (!otherName || otherName === node.name) continue

          const other = nodes.find(
            (n) => n.name === otherName && n.id !== node.id
          )
          if (!other) continue

          contradictions.push({
            sourceNode: node,
            targetNode: other,
            reason: c.reason,
            confidence: c.confidence,
          })

          // 写 contradicts 边（幂等）
          const exists = await this.graph.hasEdge(node.id, other.id, 'contradicts')
          if (!exists) {
            await this.graph.addEdge({
              sourceId: node.id,
              targetId: other.id,
              relationshipName: 'contradicts',
              knowledgeBaseId: node.knowledgeBaseId,
              weight: c.confidence,
              properties: {
                reason: c.reason,
                factA: c.factA,
                factB: c.factB,
                confidence: c.confidence,
                detectedBy: 'llm_semantic',
              },
            })
            edgesWritten++
          }
        }
      } catch {
        // 单节点比对失败跳过
      }
    }

    return { contradictions, edgesWritten }
  }

  private findDirectContradictions(nodes: GraphNode[], edges: GraphEdge[]): Contradiction[] {
    const contradictions: Contradiction[] = []
    const edgeMap = new Map<string, GraphEdge[]>()

    for (const edge of edges) {
      const key = `${edge.sourceId}->${edge.targetId}`
      if (!edgeMap.has(key)) edgeMap.set(key, [])
      edgeMap.get(key)!.push(edge)
    }

    for (const [, edgeList] of edgeMap) {
      if (edgeList.length < 2) continue

      const contradictoryRelations = this.findContradictoryRelations(edgeList)
      for (const [rel1, rel2] of contradictoryRelations) {
        const source = nodes.find((n) => n.id === edgeList[0].sourceId)
        const target = nodes.find((n) => n.id === edgeList[0].targetId)
        if (source && target) {
          contradictions.push({
            sourceNode: source,
            targetNode: target,
            relation1: rel1,
            relation2: rel2,
            confidence: 0.8,
            description: `实体 "${source.name}" 与 "${target.name}" 之间存在矛盾关系: "${rel1}" vs "${rel2}"`,
          })
        }
      }
    }

    return contradictions
  }

  private findTemporalContradictions(nodes: GraphNode[], edges: GraphEdge[]): Contradiction[] {
    const contradictions: Contradiction[] = []
    const contradictoryPairs = [
      ['是', '不是'],
      ['属于', '不属于'],
      ['支持', '不支持'],
      ['兼容', '不兼容'],
      ['已废弃', '推荐'],
      ['替代', '被替代'],
    ]

    for (const edge of edges) {
      const source = nodes.find((n) => n.id === edge.sourceId)
      const target = nodes.find((n) => n.id === edge.targetId)
      if (!source || !target) continue

      for (const [rel1, rel2] of contradictoryPairs) {
        if (edge.relationshipName === rel2) {
          const oppositeEdge = edges.find(
            (e) =>
              e.sourceId === edge.sourceId &&
              e.targetId === edge.targetId &&
              e.relationshipName === rel1
          )
          if (oppositeEdge) {
            contradictions.push({
              sourceNode: source,
              targetNode: target,
              relation1: oppositeEdge.relationshipName,
              relation2: edge.relationshipName,
              confidence: 0.9,
              description: `时间矛盾: "${source.name}" ${rel1} "${target.name}" 但同时也 ${rel2} "${target.name}"`,
            })
          }
        }
      }
    }

    return contradictions
  }

  private findStructuralContradictions(nodes: GraphNode[], edges: GraphEdge[]): Contradiction[] {
    const contradictions: Contradiction[] = []
    const STRUCTURAL_RELATIONS = ['包含', '属于', '由...组成', 'is_part_of', 'contains']

    for (const node of nodes) {
      const nodeEdges = edges.filter(
        (e) => e.sourceId === node.id || e.targetId === node.id
      )

      const structuralEdges = nodeEdges.filter((e) =>
        STRUCTURAL_RELATIONS.includes(e.relationshipName)
      )

      if (structuralEdges.length < 2) continue

      const targets = new Set<string>()
      for (const edge of structuralEdges) {
        const otherId = edge.sourceId === node.id ? edge.targetId : edge.sourceId
        if (targets.has(otherId)) {
          const otherNode = nodes.find((n) => n.id === otherId)
          if (otherNode) {
            contradictions.push({
              sourceNode: node,
              targetNode: otherNode,
              relation1: structuralEdges[0].relationshipName,
              relation2: structuralEdges[1].relationshipName,
              confidence: 0.7,
              description: `结构矛盾: "${node.name}" 与 "${otherNode.name}" 存在多重结构关系`,
            })
          }
        }
        targets.add(otherId)
      }
    }

    return contradictions
  }

  private findContradictoryRelations(edges: GraphEdge[]): Array<[string, string]> {
    const contradictoryPairs: Array<[string, string]> = [
      ['是', '不是'],
      ['支持', '不支持'],
      ['兼容', '不兼容'],
      ['属于', '不属于'],
      ['包含', '排除'],
      ['启用', '禁用'],
      ['推荐', '不推荐'],
    ]

    const results: Array<[string, string]> = []
    const relNames = edges.map((e) => e.relationshipName)

    for (const [rel1, rel2] of contradictoryPairs) {
      if (relNames.includes(rel1) && relNames.includes(rel2)) {
        results.push([rel1, rel2])
      }
    }

    return results
  }
}