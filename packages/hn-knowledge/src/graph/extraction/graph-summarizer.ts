import { generateObject } from 'ai'
import { getDefaultChatModel } from '../../config/env.js'
import { z } from 'zod'
import { resolveModel } from '../../utils/model-resolver.js'
import type { GraphDB } from '../interface.js'
import type { GraphNode } from '../types.js'

const GraphSummarySchema = z.object({
  summary: z.string().describe('图内容的整体摘要'),
  themes: z.array(z.string()).describe('图中的主要主题'),
  keyEntities: z.array(z.string()).describe('最关键的实体名称'),
})

export type GraphSummary = z.infer<typeof GraphSummarySchema>

export interface NodeSummary {
  nodeId: string
  nodeName: string
  summary: string
}

export interface SummarizeResult {
  overall: GraphSummary
  nodeSummaries: NodeSummary[]
}

const summarizePrompt = `你是知识图谱摘要专家。基于以下实体和关系，生成摘要。

实体：
{entities}

关系（三元组）：
{triplets}

请生成：整体摘要、主要主题列表、最关键实体列表。摘要应简洁准确，基于图中的实际内容。`

const nodeSummarizePrompt = `你是知识图谱摘要专家。基于实体 "{name}" 的以下关系，用一句话概括该实体在知识库中的作用。

关系：
{relations}

请直接给出概括性描述。`

/**
 * 图摘要器（对标 cognee extract_graph_and_summarize.py + summaries 检索）
 *
 * 功能：
 * 1. 整体图摘要（主题、关键实体）
 * 2. 逐节点摘要（基于该节点的邻边，按度数取 Top-N）
 */
export class GraphSummarizer {
  private model: any
  private maxRetries: number

  constructor(options?: { model?: string; maxRetries?: number }) {
    const modelName = options?.model || getDefaultChatModel()
    this.model = resolveModel(modelName)
    this.maxRetries = options?.maxRetries ?? 2
  }

  async summarizeGraph(
    graph: GraphDB,
    knowledgeBaseId?: string,
    maxNodes = 20
  ): Promise<SummarizeResult> {
    const graphData = await graph.getGraphData(knowledgeBaseId)
    if (graphData.nodes.length === 0) {
      return {
        overall: { summary: '', themes: [], keyEntities: [] },
        nodeSummaries: [],
      }
    }

    const nodesById = new Map(graphData.nodes.map((n) => [n.id, n]))

    // 整体摘要
    const entitiesText = graphData.nodes
      .slice(0, 50)
      .map((n) => `- ${n.name} (${n.type})`)
      .join('\n')
    const tripletsText = graphData.edges
      .slice(0, 100)
      .map((e) => {
        const s = nodesById.get(e.sourceId)?.name || e.sourceId
        const t = nodesById.get(e.targetId)?.name || e.targetId
        return `- ${s} --[${e.relationshipName}]--> ${t}`
      })
      .join('\n')

    const overall = await this.withRetry(async () => {
      const result = await generateObject({
        model: this.model,
        schema: GraphSummarySchema,
        prompt: summarizePrompt
          .replace('{entities}', entitiesText)
          .replace('{triplets}', tripletsText),
        temperature: 0.1,
      })
      return result.object
    })

    // 逐节点摘要（按度数排序取前 maxNodes 个）
    const degreeMap = new Map<string, number>()
    for (const edge of graphData.edges) {
      degreeMap.set(edge.sourceId, (degreeMap.get(edge.sourceId) || 0) + 1)
      degreeMap.set(edge.targetId, (degreeMap.get(edge.targetId) || 0) + 1)
    }
    const topNodes = [...degreeMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxNodes)
      .map(([id]) => nodesById.get(id))
      .filter((n): n is GraphNode => !!n)

    const nodeSummaries: NodeSummary[] = []
    for (const node of topNodes) {
      const relations = graphData.edges
        .filter((e) => e.sourceId === node.id || e.targetId === node.id)
        .slice(0, 10)
        .map((e) => {
          const other = e.sourceId === node.id ? e.targetId : e.sourceId
          const otherName = nodesById.get(other)?.name || other
          const arrow = e.sourceId === node.id ? `--[${e.relationshipName}]-->` : `<--[${e.relationshipName}]--`
          return `- ${node.name} ${arrow} ${otherName}`
        })
        .join('\n')

      const summary = await this.withRetry(async () => {
        const resp = await generateObject({
          model: this.model,
          schema: z.object({ summary: z.string() }),
          prompt: nodeSummarizePrompt
            .replace('{name}', node.name)
            .replace('{relations}', relations),
          temperature: 0.1,
        })
        return resp.object.summary
      }).catch(() => '')

      nodeSummaries.push({ nodeId: node.id, nodeName: node.name, summary })
    }

    return { overall, nodeSummaries }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: any
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn()
      } catch (err: any) {
        lastError = err
      }
    }
    throw lastError
  }
}

/**
 * 便捷入口：从图数据库读取并生成摘要
 */
export async function summarizeKnowledgeGraph(
  graph: GraphDB,
  knowledgeBaseId?: string,
  options?: { model?: string }
): Promise<SummarizeResult> {
  const summarizer = new GraphSummarizer(options)
  return summarizer.summarizeGraph(graph, knowledgeBaseId)
}