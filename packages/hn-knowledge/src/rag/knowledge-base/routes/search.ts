import { Hono } from 'hono'
import { openaiEmbedding } from '../../../providers/llm.js'
import { vectorService, keywordSearchService, hybridSearchService, recallService, rerankService, knowledgeBaseService } from '../services'
import { SearchRequestSchema } from '../types/knowledge-base.types'
import { getHyDEService } from '../services/hyde.service'
import { getMultiQueryService } from '../services/multi-query.service'
import {
  calculateRecallTopK,
  validateRecallConfig,
  filterLowScoreResults,
  checkResultQuality
} from '../../../utils/search-helper'
import {
  DEFAULT_SEARCH_TYPE,
  DEFAULT_ENABLE_MULTI_STAGE,
  DEFAULT_ENABLE_RERANK,
  DEFAULT_RERANK_TOP_K,
  DEFAULT_RERANK_MODEL,
  SEARCH_ERROR_MESSAGES
} from '../../../config/search.constants'

export const search = new Hono().post('/:id/search', async (c) => {
  try {
    const knowledgeBaseId = c.req.param('id')
    const body = await c.req.json()
    const validated = SearchRequestSchema.parse(body)

    // 获取知识库配置
    const kb = await knowledgeBaseService.getKnowledgeBase(knowledgeBaseId)
    if (!kb) {
      return c.json(
        {
          code: 404,
          success: false,
          message: SEARCH_ERROR_MESSAGES.KNOWLEDGE_BASE_NOT_FOUND,
          data: null
        },
        404
      )
    }

    const embeddingModelName = kb.embeddingModel || 'openai/text-embedding-3-small'

    // ========== metadata 检索（纯元信息召回，能力开关由调用方决定）==========
    // 不走向量/关键词/融合，按 filter 匹配 metadata 直接召回；
    // score 恒为 1（匹配即命中，无相似度语义），排序与 topK 由 PgVectorStore.queryByMetadata 处理
    if (validated.searchType === 'metadata') {
      const rows = await vectorService.queryByMetadata(knowledgeBaseId, validated.filter!, validated.topK)
      const results = rows.map((r: any) => {
        const text = r.metadata?.text || ''
        return {
          id: r.id,
          text,
          score: r.score,
          metadata: { ...r.metadata, text },
          documentId: r.metadata?.documentId || '',
          chunkIndex: r.metadata?.chunkIndex
        }
      })
      return c.json({
        code: 200,
        success: true,
        message: 'Search completed',
        data: {
          results,
          total: results.length,
          searchType: 'metadata',
          recallStage: 'metadata-only',
          reranked: false
        }
      })
    }

    // metadata 分支已 return；其余检索类型经 superRefine 保证 query 非空
    const query = validated.query!

    // 配置参数（使用默认值）
    const searchType = validated.searchType || DEFAULT_SEARCH_TYPE
    const enableRerank = validated.rerankConfig?.enableRerank ?? DEFAULT_ENABLE_RERANK
    const rerankTopK = validated.rerankConfig?.rerankTopK ?? DEFAULT_RERANK_TOP_K
    // 多阶段召回仅支持语义检索：非语义类型自动关闭该增强（跳过而非拒绝请求）
    const enableMultiStage =
      (validated.recallConfig?.enableMultiStage ?? DEFAULT_ENABLE_MULTI_STAGE) && searchType === 'semantic'
    const enableQueryExpansion = validated.recallConfig?.enableQueryExpansion ?? false
    const recallTopK = validated.recallConfig?.recallTopK

    // 配置校验
    validateRecallConfig(validated.topK, recallTopK)

    // 计算召回数量（考虑重排序）
    const recallCount = calculateRecallTopK(validated.topK, enableRerank)

    let results: any[] = []
    let recallStage: string | undefined
    let reranked = false

    // ========== 召回阶段 ==========

    // 获取 HyDE 和多查询配置
    const enableHyDE = validated.hydeConfig?.enableHyDE ?? false
    const enableMultiQuery = validated.multiQueryConfig?.enableMultiQuery ?? false

    // 优先级判断：HyDE + 多查询 > HyDE > 多查询 > 多阶段召回 > 标准检索
    if (enableHyDE && enableMultiQuery && searchType === 'semantic') {
      // HyDE + 多查询组合（最优召回，+30-40%）
      const hydeService = getHyDEService(
        validated.hydeConfig?.llmModel || 'gpt-4o-mini',
        validated.hydeConfig?.embeddingModel || embeddingModelName,
        true
      )
      const multiQueryService = getMultiQueryService(
        validated.multiQueryConfig?.llmModel || 'gpt-4o-mini',
        embeddingModelName,
        true,
        validated.multiQueryConfig?.numVariations || 3
      )

      // 生成 HyDE 假设答案
      const hypotheticalDoc = await hydeService.generateHypotheticalDocument(query)

      // 生成多查询变体
      const variations = await multiQueryService.generateQueryVariations(
        query,
        validated.multiQueryConfig?.numVariations || 3
      )

      // 准备所有查询（原始 + 多查询变体 + HyDE 假设答案）
      const allQueries = [query, ...variations, hypotheticalDoc]

      // 并行检索所有查询
      const allResults = await Promise.all(
        allQueries.map(async (q) => {
          const { embedding } = await (await import('ai')).embed({
            value: q,
            model: openaiEmbedding(embeddingModelName.replace('openai/', ''))
          })
          const vectorResults = await vectorService.query(
            knowledgeBaseId,
            embedding,
            recallCount,
            validated.filter,
            validated.pgVectorConfig
          )
          return vectorResults.map((result) => {
            const text = result.metadata?.text || ''
            return {
              id: result.id,
              text,
              score: result.score || 0,
              metadata: {
                ...result.metadata,
                text
              },
              documentId: result.metadata?.documentId || '',
              chunkIndex: result.metadata?.chunkIndex
            }
          })
        })
      )

      // 使用 RRF 融合所有结果
      const { reciprocalRankFusion } = await import('../../../utils/rrf-fusion')
      results = reciprocalRankFusion(allResults, 60)
      recallStage = 'hyde+multi-query'
    } else if (enableHyDE && searchType === 'semantic') {
      // HyDE 检索（+15-20%）
      const hydeService = getHyDEService(
        validated.hydeConfig?.llmModel || 'gpt-4o-mini',
        validated.hydeConfig?.embeddingModel || embeddingModelName,
        true
      )
      results = await hydeService.searchWithHyDE(
        knowledgeBaseId,
        query,
        recallCount,
        vectorService,
        validated.pgVectorConfig
      )
      recallStage = 'hyde'
    } else if (enableMultiQuery && searchType === 'semantic') {
      // 多查询检索（+20-30%）
      const multiQueryService = getMultiQueryService(
        validated.multiQueryConfig?.llmModel || 'gpt-4o-mini',
        embeddingModelName,
        true,
        validated.multiQueryConfig?.numVariations || 3
      )
      results = await multiQueryService.searchWithMultiQuery(
        knowledgeBaseId,
        query,
        recallCount,
        vectorService,
        validated.pgVectorConfig,
        validated.multiQueryConfig?.numVariations || 3
      )
      recallStage = 'multi-query'
    } else if (enableMultiStage || enableQueryExpansion) {
      // 多阶段召回
      results = await recallService.recall(knowledgeBaseId, query, {
        enableMultiStage,
        enableQueryExpansion,
        coarseTopK: recallTopK ?? 50,
        fineTopK: recallCount,
        pgVectorConfig: validated.pgVectorConfig,
        embeddingModel: embeddingModelName,
        filter: validated.filter
      })
      recallStage = 'multi-stage'
    } else {
      // 单阶段检索：根据类型选择检索方法
      switch (searchType) {
        case 'semantic': {
          // 语义检索
          const { embedding } = await (await import('ai')).embed({
            value: query,
            model: openaiEmbedding(embeddingModelName.replace('openai/', ''))
          })
          const vectorResults = await vectorService.query(
            knowledgeBaseId,
            embedding,
            recallCount,
            validated.filter,
            validated.pgVectorConfig
          )
          results = vectorResults.map((result) => {
            const text = result.metadata?.text || ''
            return {
              id: result.id,
              text,
              score: result.score || 0,
              metadata: {
                ...result.metadata,
                text
              },
              documentId: result.metadata?.documentId || '',
              chunkIndex: result.metadata?.chunkIndex
            }
          })
          break
        }

        case 'keyword': {
          // 关键词检索
          results = await keywordSearchService.search(
            knowledgeBaseId,
            query,
            recallCount,
            validated.filter
          )
          break
        }

        case 'hybrid': {
          // 混合检索
          results = await hybridSearchService.search(knowledgeBaseId, query, {
            semanticWeight: validated.hybridWeight?.semantic || 0.7,
            keywordWeight: validated.hybridWeight?.keyword || 0.3,
            topK: recallCount,
            pgVectorConfig: validated.pgVectorConfig,
            embeddingModel: embeddingModelName,
            fusionMethod: validated.fusionMethod, // 融合方法：默认 'rrf'
            rrfK: validated.rrfK, // RRF 参数 k：默认 60
            filter: validated.filter // 元数据过滤（透传至语义/关键词两分支）
          })
          break
        }
      }
    }

    // ========== 重排序阶段 ==========
    if (enableRerank && results.length > 0) {
      results = await rerankService.rerank(query, results, {
        model: validated.rerankConfig?.rerankModel || DEFAULT_RERANK_MODEL,
        topK: rerankTopK
      })
      reranked = true
    }

    // ========== 分数阈值过滤 ==========
    const minScore = validated.pgVectorConfig?.minScore
    if (minScore !== undefined || results.length > 0) {
      results = filterLowScoreResults(results, minScore, searchType)
    }

    // ========== 结果质量检查 ==========
    const qualityCheck = checkResultQuality(results, validated.topK, searchType)

    // ========== 限制最终结果数量 ==========
    results = results.slice(0, validated.topK)

    // 构建响应
    const response: any = {
      code: 200,
      success: true,
      message: 'Search completed',
      data: {
        results,
        total: results.length,
        searchType,
        recallStage,
        reranked
      }
    }

    // 如果质量检查发现问题，添加警告信息
    if (!qualityCheck.isHighQuality && qualityCheck.message) {
      response.data.warning = qualityCheck.message
      response.data.filteredCount = qualityCheck.filteredCount
    }

    // 如果没有结果，返回特殊提示
    if (results.length === 0) {
      response.data.warning = SEARCH_ERROR_MESSAGES.NO_RESULTS_FOUND
    }

    return c.json(response)
  } catch (error: any) {
    return c.json(
      {
        code: 400,
        success: false,
        message: error.message || SEARCH_ERROR_MESSAGES.SEARCH_FAILED,
        data: null
      },
      400
    )
  }
})
