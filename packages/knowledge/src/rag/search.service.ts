import { embed } from 'ai'
import { openaiEmbedding } from '../providers/llm.js'
import { RRF_K } from './constants.js'
import { BaseKnowledgeError, SearchTimeoutError } from './errors.js'
import type { BaseKnowledgeRepository } from './repository.js'
import { runSearchWithTimeout } from './timeout.js'
import type {
  BaseKnowledgeSearchItem,
  BaseKnowledgeSearchResponse,
  SearchBaseKnowledgeRequest,
  SearchBranchReport
} from './types.js'
import { uniqueStrings } from './utils.js'

type BranchResult = {
  items: BaseKnowledgeSearchItem[]
  report: SearchBranchReport
}

export class BaseKnowledgeSearchService {
  constructor(private readonly repository: BaseKnowledgeRepository) {}

  async search(
    knowledgeBaseId: string,
    request: SearchBaseKnowledgeRequest
  ): Promise<BaseKnowledgeSearchResponse> {
    const excludeDocumentIds = uniqueStrings(request.excludeDocumentIds)
    const recallTopK = Math.min(request.topK * 2, 200)

    if (request.mode === 'keyword') {
      const keyword = await this.mapSingleTimeout(() =>
        this.runKeyword(
          knowledgeBaseId,
          request.query,
          recallTopK,
          excludeDocumentIds,
          request.timeoutMs
        )
      )
      return this.buildResponse(request.mode, keyword.items.slice(0, request.topK), keyword.report, {
        status: 'skipped',
        durationMs: 0
      })
    }

    if (request.mode === 'vector') {
      const vector = await this.mapSingleTimeout(() =>
        this.runVector(
          knowledgeBaseId,
          request.query,
          recallTopK,
          excludeDocumentIds,
          request.timeoutMs
        )
      )
      return this.buildResponse(request.mode, vector.items.slice(0, request.topK), {
        status: 'skipped',
        durationMs: 0
      }, vector.report)
    }

    const [keywordSettled, vectorSettled] = await Promise.allSettled([
      this.runKeyword(knowledgeBaseId, request.query, recallTopK, excludeDocumentIds, request.timeoutMs),
      this.runVector(knowledgeBaseId, request.query, recallTopK, excludeDocumentIds, request.timeoutMs)
    ])

    const keyword = this.unwrapBranch(keywordSettled, 'keyword', request.timeoutMs)
    const vector = this.unwrapBranch(vectorSettled, 'vector', request.timeoutMs)
    const hasTimeout = keyword.report.status === 'timeout' || vector.report.status === 'timeout'

    if (hasTimeout && request.failOnPartialTimeout) {
      throw new BaseKnowledgeError('Hybrid search partially timed out', 504, 'PARTIAL_SEARCH_TIMEOUT')
    }

    const excluded = new Set(excludeDocumentIds)
    const availableItems = [...keyword.items, ...vector.items].filter(
      (item) => !excluded.has(item.documentId)
    )
    if (hasTimeout && availableItems.length === 0) {
      // 已确认的 3A 规则：一路超时且另一路为空时，不能把未知结果误报成正常空结果。
      throw new BaseKnowledgeError('Hybrid search timed out without usable results', 504, 'SEARCH_TIMEOUT')
    }

    const fused = this.reciprocalRankFusion([keyword.items, vector.items])
    const items = fused.filter((item) => !excluded.has(item.documentId)).slice(0, request.topK)
    return this.buildResponse(request.mode, items, keyword.report, vector.report)
  }

  private async runKeyword(
    knowledgeBaseId: string,
    query: string,
    topK: number,
    excludeDocumentIds: string[],
    timeoutMs: number
  ): Promise<BranchResult> {
    const startedAt = Date.now()
    const items = await runSearchWithTimeout('keyword', timeoutMs, () =>
      this.repository.keywordSearch(knowledgeBaseId, query, topK, excludeDocumentIds, timeoutMs)
    )
    return { items, report: { status: 'success', durationMs: Date.now() - startedAt } }
  }

  private async runVector(
    knowledgeBaseId: string,
    query: string,
    topK: number,
    excludeDocumentIds: string[],
    timeoutMs: number
  ): Promise<BranchResult> {
    const startedAt = Date.now()
    return runSearchWithTimeout('vector', timeoutMs, async (signal) => {
      const space = await this.repository.getSpace(knowledgeBaseId)
      if (!space) {
        throw new BaseKnowledgeError('Base knowledge not found', 404, 'BASE_KNOWLEDGE_NOT_FOUND')
      }
      const modelName = space.embeddingModel.startsWith('openai/')
        ? space.embeddingModel.slice('openai/'.length)
        : space.embeddingModel

      let queryEmbedding: number[]
      try {
        const result = await embed({
          value: query,
          model: openaiEmbedding(modelName),
          abortSignal: signal
        })
        queryEmbedding = result.embedding
        if (queryEmbedding.length === 0 || queryEmbedding.some((value) => !Number.isFinite(value))) {
          throw new Error('Embedding is empty or contains non-finite values')
        }
      } catch (error) {
        if (signal.aborted) throw new SearchTimeoutError('vector')
        throw new BaseKnowledgeError(
          `Failed to generate query embedding: ${error instanceof Error ? error.message : String(error)}`,
          502,
          'QUERY_EMBEDDING_FAILED'
        )
      }

      const items = await this.repository.vectorSearch(
        knowledgeBaseId,
        queryEmbedding,
        topK,
        excludeDocumentIds,
        // embedding 已消耗部分时间，数据库只能使用剩余预算，避免调用方返回后 SQL 仍长期运行。
        Math.max(1, timeoutMs - (Date.now() - startedAt))
      )
      return { items, report: { status: 'success', durationMs: Date.now() - startedAt } }
    })
  }

  private unwrapBranch(
    settled: PromiseSettledResult<BranchResult>,
    branch: 'keyword' | 'vector',
    timeoutMs: number
  ): BranchResult {
    if (settled.status === 'fulfilled') return settled.value
    if (settled.reason instanceof SearchTimeoutError) {
      return {
        items: [],
        report: {
          status: 'timeout',
          durationMs: timeoutMs
        }
      }
    }

    // 只有超时允许按策略降级；数据库错误、配置错误等必须暴露，不能被伪装成召回为空。
    throw settled.reason instanceof Error
      ? settled.reason
      : new BaseKnowledgeError(`${branch} search failed`, 500, 'SEARCH_FAILED')
  }

  private async mapSingleTimeout(operation: () => Promise<BranchResult>): Promise<BranchResult> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof SearchTimeoutError) {
        throw new BaseKnowledgeError('Search timed out', 504, 'SEARCH_TIMEOUT')
      }
      throw error
    }
  }

  private buildResponse(
    mode: SearchBaseKnowledgeRequest['mode'],
    items: BaseKnowledgeSearchItem[],
    keyword: SearchBranchReport,
    vector: SearchBranchReport
  ): BaseKnowledgeSearchResponse {
    return {
      items,
      total: items.length,
      mode,
      degraded: keyword.status === 'timeout' || vector.status === 'timeout',
      branches: { keyword, vector }
    }
  }

  private reciprocalRankFusion(resultSets: BaseKnowledgeSearchItem[][]): BaseKnowledgeSearchItem[] {
    const merged = new Map<string, { item: BaseKnowledgeSearchItem; score: number }>()

    for (const items of resultSets) {
      items.forEach((item, rank) => {
        const rrfScore = 1 / (RRF_K + rank + 1)
        const current = merged.get(item.id)
        if (current) {
          current.score += rrfScore
        } else {
          merged.set(item.id, { item, score: rrfScore })
        }
      })
    }

    return [...merged.values()]
      .sort((left, right) => right.score - left.score)
      .map(({ item, score }) => ({ ...item, score }))
  }
}
