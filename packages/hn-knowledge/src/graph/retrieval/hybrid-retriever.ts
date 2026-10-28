import type { GraphDB } from '../interface.js'
import { GraphCompletionRetriever } from './graph-completion-retriever.js'

export interface GraphChannelResult {
  id: string
  text: string
  score: number
  type: 'graph_triplet'
  metadata: Record<string, unknown>
}

export interface HybridGraphSearchOptions {
  topK: number
  neighborDepth: number
  graphWeight: number
  knowledgeBaseId?: string
}

export class HybridGraphRetriever {
  private completionRetriever: GraphCompletionRetriever

  constructor(graph: GraphDB) {
    this.completionRetriever = new GraphCompletionRetriever(graph)
  }

  async search(
    queryEmbedding: number[],
    options: HybridGraphSearchOptions
  ): Promise<GraphChannelResult[]> {
    const { topK, neighborDepth, knowledgeBaseId } = options

    const result = await this.completionRetriever.search(queryEmbedding, {
      topK,
      neighborDepth,
      knowledgeBaseId,
    })

    return result.triplets.map((triplet, index) => ({
      id: `graph_${index}`,
      text: `[${triplet.source.name}] --[${triplet.relation}]--> [${triplet.target.name}]`,
      score: triplet.score,
      type: 'graph_triplet' as const,
      metadata: {
        sourceName: triplet.source.name,
        sourceType: triplet.source.type,
        targetName: triplet.target.name,
        targetType: triplet.target.type,
        relation: triplet.relation,
        weight: triplet.weight,
        sourceId: triplet.source.id,
        targetId: triplet.target.id,
      },
    }))
  }

  async searchByQuery(
    query: string,
    queryEmbedding: number[],
    options: HybridGraphSearchOptions
  ): Promise<GraphChannelResult[]> {
    return this.search(queryEmbedding, options)
  }
}