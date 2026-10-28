import { embedMany } from 'ai'
import { EntityExtractor } from './entity-extractor.js'
import { GraphBuilder, type EmbedEntityFn } from './graph-builder.js'
import { GraphMergePipeline, type ChunkExtraction } from './merge-pipeline.js'
import type { EntityChunkTracker } from './entity-chunk-tracker.js'
import type { GraphDB } from '../interface.js'
import type { CombinedExtraction } from '../types.js'

export interface KnowledgeGraphSyncOptions {
  model?: string
  useCascade?: boolean
  batchSize?: number
  knowledgeBaseId: string
  documentId?: string
  pipelineRunId?: string
  embeddingModel?: string
}

/**
 * 默认实体嵌入函数：使用 openai/text-embedding-3-small
 */
export async function defaultEmbedFn(modelName?: string): Promise<EmbedEntityFn> {
  const { openaiEmbedding } = await import('../../providers/llm.js')
  const modelNameResolved = modelName || 'text-embedding-3-small'
  const model = openaiEmbedding(modelNameResolved)
  return async (texts: string[]) => {
    const { embeddings } = await embedMany({ model, values: texts })
    return embeddings
  }
}

export class KnowledgeGraphSyncer {
  private extractor: EntityExtractor
  private builder: GraphBuilder
  private mergePipeline: GraphMergePipeline | null = null

  constructor(
    graph: GraphDB,
    options?: { model?: string; enableEmbedding?: boolean; tracker?: EntityChunkTracker }
  ) {
    this.extractor = new EntityExtractor({ model: options?.model })
    this.builder = new GraphBuilder(graph)
    if (options?.tracker) {
      this.mergePipeline = new GraphMergePipeline(graph, options.tracker)
    }
    if (options?.enableEmbedding !== false) {
      defaultEmbedFn()
        .then((fn) => {
          this.builder.setEmbedFn(fn)
          this.mergePipeline?.setEmbedFn(fn)
        })
        .catch((err) => console.warn(`[图谱同步] 嵌入函数初始化失败: ${err.message}`))
    }
  }

  async syncChunks(
    chunks: Array<{ text: string; index: number }>,
    options: KnowledgeGraphSyncOptions
  ): Promise<{ totalNodes: number; totalEdges: number }> {
    const batchSize = options.batchSize || 5
    let totalNodes = 0
    let totalEdges = 0

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize)
      const results = await Promise.allSettled(
        batch.map(async (chunk) => {
          const extraction = await this.extractor.extract(chunk.text, {
            model: options.model,
            useCascade: options.useCascade,
          })
          return { extraction, chunkIndex: chunk.index }
        })
      )

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.extraction.entities.length > 0) {
          const { nodeIds, edgeCount } = await this.builder.buildFromExtraction(
            result.value.extraction,
            {
              knowledgeBaseId: options.knowledgeBaseId,
              documentId: options.documentId,
              chunkIndex: result.value.chunkIndex,
              pipelineRunId: options.pipelineRunId,
            }
          )
          totalNodes += nodeIds.length
          totalEdges += edgeCount
        }
      }
    }

    return { totalNodes, totalEdges }
  }

  /**
   * 使用跨 chunk 合并管线的同步方式（推荐）
   *
   * 相比 syncChunks 的优势：
   * - 跨 chunk 实体合并：同名实体聚合，类型 Counter 统计，描述取最长
   * - 写前日志：先持久化 chunk tracking，再写入图
   * - 权重契约：关系 weight = max(平均置信度, distinct chunk 数)
   * - 幂等增量更新：通过 chunk tracking 去重
   */
  async syncChunksWithMerge(
    chunks: Array<{ text: string; index: number }>,
    options: KnowledgeGraphSyncOptions & { documentId: string }
  ): Promise<{ totalNodes: number; totalEdges: number; mergedEntities: number; mergedRelations: number }> {
    if (!this.mergePipeline) {
      throw new Error('GraphMergePipeline 未初始化：需要传入 tracker 选项')
    }

    const batchSize = options.batchSize || 5
    const allExtractions: ChunkExtraction[] = []

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize)
      const results = await Promise.allSettled(
        batch.map(async (chunk) => {
          const extraction = await this.extractor.extract(chunk.text, {
            model: options.model,
            useCascade: options.useCascade,
          })
          return { extraction, chunkIndex: chunk.index } as ChunkExtraction
        })
      )

      for (const result of results) {
        if (result.status === 'fulfilled') {
          allExtractions.push({
            ...result.value,
            chunkId: `${options.documentId}_${result.value.chunkIndex}`,
            documentId: options.documentId,
            pipelineRunId: options.pipelineRunId,
          })
        }
      }
    }

    if (allExtractions.length === 0) {
      return { totalNodes: 0, totalEdges: 0, mergedEntities: 0, mergedRelations: 0 }
    }

    const result = await this.mergePipeline.merge(allExtractions, {
      knowledgeBaseId: options.knowledgeBaseId,
    })

    return {
      totalNodes: result.nodeIds.length,
      totalEdges: result.edgeCount,
      mergedEntities: result.mergedEntities,
      mergedRelations: result.mergedRelations,
    }
  }

  async syncText(text: string, options: KnowledgeGraphSyncOptions): Promise<{ totalNodes: number; totalEdges: number }> {
    const extraction = await this.extractor.extract(text, {
      model: options.model,
      useCascade: options.useCascade,
    })

    if (extraction.entities.length === 0) {
      return { totalNodes: 0, totalEdges: 0 }
    }

    const { nodeIds, edgeCount } = await this.builder.buildFromExtraction(extraction, {
      knowledgeBaseId: options.knowledgeBaseId,
      documentId: options.documentId,
      pipelineRunId: options.pipelineRunId,
    })

    return { totalNodes: nodeIds.length, totalEdges: edgeCount }
  }
}

export { GlobalContextIndexer, GlobalContextRetriever } from './global-context-indexer.js'
export { SessionDistiller } from './session-distiller.js'
export type { ChatMessage, DistillResult } from './session-distiller.js'
export { GraphMergePipeline } from './merge-pipeline.js'
export type { ChunkExtraction, MergeOptions, MergeResult } from './merge-pipeline.js'
export { PgEntityChunkTracker } from './entity-chunk-tracker.js'
export type { EntityChunkTracker } from './entity-chunk-tracker.js'