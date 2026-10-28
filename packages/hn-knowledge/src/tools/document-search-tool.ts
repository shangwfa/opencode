import { createTool } from '../utils/create-tool.js'
import type { RuntimeContext } from '../utils/runtime-context.js'
import { z } from 'zod'
import { hybridSearchService, knowledgeBaseService } from '../rag/knowledge-base/index.js'
import type { HybridSearchDebugEvent } from '../rag/knowledge-base/index.js'
import type { SearchResultItem } from '../rag/knowledge-base/index.js'
import { getOrCreateTraceId, logRagTrace } from '../utils/rag-trace-logger.js'
import { persistDocumentRetrievalTrace } from '../utils/retrieval-trace-persistence.js'
import { extractAllMedia } from '../utils/media-extractor.js'
import { contentHash } from '../graph/retrieval/evidence.js'

// const DOCUMENT_KB_NAME = '影刀文档知识库'
const DOCUMENT_KB_NAME = '测试知识库 - rpa_zh-CN'

// 知识库 ID 缓存（避免多轮对话中重复查询）
// 使用 Map 结构支持多个知识库的独立缓存
const kbIdCache = new Map<string, { id: string; timestamp: number }>()
const KB_ID_CACHE_TTL = 5 * 60 * 1000 // 5 分钟缓存

/**
 * 根据名称查找知识库 ID（带缓存）
 * @param kbName 知识库名称，如果不传则使用默认名称
 */
async function getKnowledgeBaseId(kbName?: string): Promise<string> {
  const targetKbName = kbName || DOCUMENT_KB_NAME

  // 如果缓存有效，直接返回
  const now = Date.now()
  const cached = kbIdCache.get(targetKbName)
  if (cached && now - cached.timestamp < KB_ID_CACHE_TTL) {
    return cached.id
  }

  // 查询知识库
  const result = await knowledgeBaseService.listKnowledgeBases({ pageSize: 100 })
  const kb = result.items.find((kb) => kb.name === targetKbName)

  if (!kb) {
    throw new Error(`知识库 "${targetKbName}" 不存在，请先运行初始化脚本创建知识库`)
  }

  // 更新缓存
  kbIdCache.set(targetKbName, { id: kb.id, timestamp: now })

  return kb.id
}

/**
 * P1 优化：查询类型分析与智能配置
 *
 * 根据查询特征自动调整检索策略：
 * 1. 精确查询：提高关键词权重（70%），降低语义权重（30%）
 * 2. 概念查询：提高语义权重（70%），降低关键词权重（30%），启用 HyDE
 * 3. 默认查询：平衡权重（70% 语义 + 30% 关键词）
 */
interface QueryAnalysis {
  isExactQuery: boolean // 精确查询（如错误代码、专有名词）
  isConceptualQuery: boolean // 概念查询（如"如何"、"最佳实践"）
  isComplexQuery: boolean // 复杂查询（词数 > 5）
  queryType: 'exact' | 'conceptual' | 'complex' | 'default'
}

type RetrievalDebugStage = {
  stage: string
  query: string
  topK: number
  resultCount: number
  results: Array<{
    rank: number
    score: number
    documentId: string
    chunkIndex?: number
    docName?: string
    docPath?: string
    docUrl?: string
    textPreview?: string
  }>
}

function summarizeSearchResults(results: SearchResultItem[]): RetrievalDebugStage['results'] {
  return results.slice(0, 50).map((result, index) => ({
    rank: index + 1,
    score: result.score,
    documentId: result.documentId,
    chunkIndex: result.chunkIndex,
    docName: result.metadata?.docName as string | undefined,
    docPath: result.metadata?.docPath as string | undefined,
    docUrl: result.metadata?.docUrl as string | undefined,
    textPreview: result.text ? result.text.slice(0, 300) : undefined
  }))
}

function pushRetrievalDebugStage(stages: RetrievalDebugStage[], event: HybridSearchDebugEvent): void {
  stages.push({
    stage: event.stage,
    query: event.query,
    topK: event.topK,
    resultCount: event.results.length,
    results: summarizeSearchResults(event.results)
  })
}

function analyzeQuery(query: string): QueryAnalysis {
  const lowerQuery = query.toLowerCase()

  // 精确查询特征：错误代码、专有名词、引号包围的内容
  const exactPatterns = [
    /错误代码|error code|err:/i,
    /"[^"]+"/, // 双引号包围
    /'[^']+'/, // 单引号包围
    /\b[A-Z]{2,}\b/, // 大写缩写（如 API、HTTP）
    /\b\d{4,}\b/ // 4位以上数字（可能是ID）
  ]

  const isExactQuery = exactPatterns.some((pattern) => pattern.test(lowerQuery))

  // 概念查询特征：如何、方法、最佳实践、优化、原理
  const conceptualPatterns = [
    /如何|怎么|怎样|方法/i,
    /最佳实践|优化|原理|机制/i,
    /是什么|为什么|怎么样/i,
    /如何做|怎么做|怎样做/i
  ]

  const isConceptualQuery = !isExactQuery && conceptualPatterns.some((pattern) => pattern.test(lowerQuery))

  // 复杂查询：包含多个关键词（5个以上中文字词或英文单词）
  const wordCount = lowerQuery.split(/[\s,，。]+/).filter((w) => w.length > 0).length
  const isComplexQuery = wordCount > 5 && !isExactQuery

  // 确定查询类型
  let queryType: QueryAnalysis['queryType'] = 'default'
  if (isExactQuery) {
    queryType = 'exact'
  } else if (isConceptualQuery) {
    queryType = 'conceptual'
  } else if (isComplexQuery) {
    queryType = 'complex'
  }

  return {
    isExactQuery,
    isConceptualQuery,
    isComplexQuery,
    queryType
  }
}

/**
 * P1 优化：根据查询类型生成优化的搜索配置
 */
function optimizeSearchConfig(query: string, topK: number) {
  const analysis = analyzeQuery(query)

  // 默认配置（语义 70% + 关键词 30%）
  let semanticWeight = 0.7
  let keywordWeight = 0.3
  // 性能优化：暂时禁用 HyDE 和重排序以提升查询速度
  let enableHyDE = false
  let enableRerank = false

  switch (analysis.queryType) {
    case 'exact':
      // 精确查询：提高关键词权重到 70%，降低语义权重到 30%
      semanticWeight = 0.3
      keywordWeight = 0.7
      enableHyDE = false
      enableRerank = false
      break

    case 'conceptual':
      // 概念查询：暂时禁用 HyDE 和重排序以提升性能
      semanticWeight = 0.7
      keywordWeight = 0.3
      enableHyDE = false
      enableRerank = false
      break

    case 'complex':
      // 复杂查询：平衡权重，暂时禁用重排序以提升性能
      semanticWeight = 0.7
      keywordWeight = 0.3
      enableHyDE = false
      enableRerank = false
      break

    case 'default':
    default:
      // 默认：语义主导，暂时禁用重排序以提升性能
      semanticWeight = 0.7
      keywordWeight = 0.3
      enableHyDE = false
      enableRerank = false
      break
  }

  return {
    semanticWeight,
    keywordWeight,
    topK,
    fusionMethod: 'rrf' as const,
    rrfK: 60,
    rerankConfig: enableRerank
      ? {
          enableRerank: true,
          rerankTopK: Math.max(20, topK * 2),
          rerankModel: 'simple' as const
        }
      : undefined,
    hydeConfig: enableHyDE
      ? {
          enableHyDE: true,
          llmModel: 'gpt-4o-mini'
        }
      : undefined
  }
}

/**
 * 创建文档搜索工具
 * @param kbId 知识库 ID，如果不传则使用默认知识库名称查找
 * @returns 文档搜索工具实例
 */
export function createDocumentSearchTool(kbId?: string) {
  return createTool({
    id: 'document-search',
    description:
      '在影刀文档知识库中搜索相关信息。搜索结果包含证据 ID；回答中的每个可验证事实必须使用 [evidenceId] 引用对应证据。',
    inputSchema: z.object({
      query: z.string().describe('搜索查询字符串，应该是用户问题的关键词或完整问题'),
      topK: z.number().int().positive().optional().default(10).describe('返回的结果数量，默认 10')
    }),
    outputSchema: z.object({
      results: z
        .array(
          z.object({
            text: z.string().describe('搜索结果文本内容'),
            evidenceId: z.string().describe('证据 ID，回答事实时使用 [evidenceId] 引用'),
            score: z.number().describe('相关性分数 (0-1)'),
            documentId: z.string().describe('文档 ID'),
            chunkIndex: z.number().optional().describe('块索引'),
            metadata: z
              .object({
                docName: z.string().optional().describe('文档名称；展示来源链接时可作为链接文本'),
                docPath: z.string().optional().describe('文档完整路径；当 docUrl 不存在时，可作为文档来源展示'),
                parentPath: z.string().optional().describe('父级路径'),
                docUrl: z.string().optional().describe('文档完整 URL；展示来源链接时优先使用该字段'),
                brandCode: z.string().optional().describe('品牌代码'),
                languageCode: z.string().optional().describe('语言代码'),
                syncedAt: z.string().optional().describe('同步时间')
              })
              .optional()
              .describe('文档元数据'),
            media: z
              .object({
                images: z.array(z.string()).describe('图片 URL 列表，从文档文本和元数据中提取的图片链接'),
                videos: z.array(z.string()).describe('视频 URL 列表，从文档文本和元数据中提取的视频链接')
              })
              .optional()
              .describe(
                '媒体资源（图片和视频）。如果存在，必须在回答中展示这些媒体资源，使用 Markdown 格式：![描述](图片URL) 或 <video src="视频URL" controls></video>'
              )
          })
        )
        .describe('搜索结果列表'),
      total: z.number().describe('结果总数'),
      retrievalDebug: z
        .object({
          stages: z
            .array(
              z.object({
                stage: z.string().describe('检索阶段'),
                query: z.string().describe('检索查询'),
                topK: z.number().describe('该阶段请求返回数量'),
                resultCount: z.number().describe('该阶段实际结果数'),
                results: z
                  .array(
                    z.object({
                      rank: z.number().describe('阶段内排序'),
                      score: z.number().describe('相关性分数'),
                      documentId: z.string().describe('文档 ID'),
                      chunkIndex: z.number().optional().describe('块索引'),
                      docName: z.string().optional().describe('文档名称'),
                      docPath: z.string().optional().describe('文档路径'),
                      docUrl: z.string().optional().describe('文档 URL'),
                      textPreview: z.string().optional().describe('召回片段预览，仅用于排查')
                    })
                  )
                  .describe('该阶段结果列表，最多保留前 50 条')
              })
            )
            .describe('检索排查链路；用于 Langfuse 工具调用输出中定位召回、融合和截断问题')
        })
        .optional()
        .describe('检索排查信息，不应直接面向用户展示'),
      error: z
        .string()
        .optional()
        .describe('错误信息；存在该字段表示检索失败或结果可能不完整，回答时应提示用户文档检索暂不可用或结果可能不完整')
    }),
    execute: async (toolCall: any) => {
      // mastra 1.63 兼容：agent 链路传 validated data 本体，旧形态传 { context } 包装
      const context = toolCall?.context ?? toolCall ?? {}
      const runtimeContext = toolCall?.runtimeContext as RuntimeContext | undefined
      const traceId = getOrCreateTraceId(runtimeContext)
      const startTime = Date.now()
      const retrievalDebugStages: RetrievalDebugStage[] = []

      try {
        // 获取知识库 ID
        let finalKbId: string
        try {
          // 如果传入了 kbId，直接使用；否则通过名称查找
          if (kbId) {
            finalKbId = kbId
          } else {
            finalKbId = await getKnowledgeBaseId()
          }
        } catch (error: any) {
          console.error('[DocumentSearchTool] 获取知识库 ID 失败:', error.message)
          logRagTrace({
            traceId,
            step: 'retrieval_failed',
            input: {
              query: context.query,
              topK: context.topK ?? 10,
              knowledgeBaseId: kbId
            },
            output: {
              error: `无法找到知识库: ${error.message}`
            },
            runtimeContext,
            metadata: {
              tool: 'document-search',
              durationMs: Date.now() - startTime
            }
          })
          return {
            results: [],
            total: 0,
            retrievalDebug: {
              stages: retrievalDebugStages
            },
            error: `无法找到知识库: ${error.message}`
          }
        }

        // 性能优化：仅在开发环境或启用详细日志时输出
        const isDebugMode = process.env.DOCUMENT_SEARCH_DEBUG === 'true'

        // P0+P1 优化：根据查询类型智能优化搜索配置
        // - 精确查询：提高关键词权重（70%）
        // - 概念查询：启用 HyDE（+15-20% 召回率）
        // - 所有查询：启用重排序（+5-10% 排名质量）
        const searchConfig = optimizeSearchConfig(context.query, context.topK || 10)
        const topK = context.topK || 10

        logRagTrace({
          traceId,
          step: 'retrieval_start',
          input: {
            query: context.query,
            topK,
            knowledgeBaseId: finalKbId
          },
          runtimeContext,
          metadata: {
            tool: 'document-search'
          }
        })

        // 执行智能优化的混合检索（添加超时保护）
        // 使用 Promise.race 确保在 20 秒内完成，留出更多缓冲时间
        // 多轮对话后，缩短超时时间可以避免工具调用 ID 过期
        let results
        let timeoutId: NodeJS.Timeout | null = null
        let isTimeout = false

        try {
          const searchPromise = hybridSearchService.search(finalKbId, context.query, {
            ...searchConfig,
            debugCollector: (event) => pushRetrievalDebugStage(retrievalDebugStages, event)
          })

          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              isTimeout = true
              reject(new Error('搜索超时（20秒）'))
            }, 20000) // 20秒超时，留出更多缓冲时间
          })

          results = await Promise.race([searchPromise, timeoutPromise])

          // 如果成功完成，清除超时定时器
          if (timeoutId) {
            clearTimeout(timeoutId)
            timeoutId = null
          }
        } catch (searchError: any) {
          // 清除超时定时器
          if (timeoutId) {
            clearTimeout(timeoutId)
            timeoutId = null
          }

          console.error('[DocumentSearchTool] 搜索失败:', searchError.message)
          // 如果是超时，直接返回错误，不要继续执行
          if (isTimeout || searchError.message?.includes('超时')) {
            logRagTrace({
              traceId,
              step: 'retrieval_failed',
              input: {
                query: context.query,
                topK,
                knowledgeBaseId: finalKbId
              },
              output: {
                error: '搜索超时（20秒）'
              },
              runtimeContext,
              metadata: {
                tool: 'document-search',
                durationMs: Date.now() - startTime
              }
            })
            return {
              results: [],
              total: 0,
              retrievalDebug: {
                stages: retrievalDebugStages
              },
              error: `搜索超时（20秒）。请基于你的知识直接回答用户的问题。`
            }
          }
          logRagTrace({
            traceId,
            step: 'retrieval_failed',
            input: {
              query: context.query,
              topK,
              knowledgeBaseId: finalKbId
            },
            output: {
              error: searchError.message
            },
            runtimeContext,
            metadata: {
              tool: 'document-search',
              durationMs: Date.now() - startTime
            }
          })
          return {
            results: [],
            total: 0,
            retrievalDebug: {
              stages: retrievalDebugStages
            },
            error: `搜索失败: ${searchError.message}`
          }
        }

        // 性能监控：记录搜索耗时
        const searchTime = Date.now() - startTime
        if (isDebugMode) {
          console.log(`[DocumentSearchTool] 搜索返回 ${results.length} 个结果，耗时 ${searchTime}ms`)
        }

        // 性能优化：限制批量查询 metadata 的数量，最多查询前 5 个缺少 metadata 的结果
        // 如果 metadata 为空，尝试从文档记录中获取 metadata
        // 收集所有需要查询的 documentId（限制数量）
        const documentIdsToQuery = new Set<string>()
        let queryCount = 0
        const MAX_METADATA_QUERIES = 5 // 最多查询 5 个文档的 metadata

        for (const result of results) {
          // 如果 metadata 为空或缺少关键字段，需要查询文档记录
          if (!result.metadata || !result.metadata.docUrl || !result.metadata.docName) {
            if (result.documentId && !documentIdsToQuery.has(result.documentId)) {
              documentIdsToQuery.add(result.documentId)
              queryCount++
              // 达到限制后停止收集
              if (queryCount >= MAX_METADATA_QUERIES) {
                break
              }
            }
          }
        }

        // 批量查询文档记录以获取 metadata（带超时保护）
        const documentMetadataMap = new Map<string, Record<string, any>>()
        if (documentIdsToQuery.size > 0) {
          try {
            const metadataQueryTimeout = 2000 // 2 秒超时
            const timeoutPromise = new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('metadata 查询超时')), metadataQueryTimeout)
            })

            const documentPromises = Array.from(documentIdsToQuery).map(async (docId) => {
              try {
                const doc = await knowledgeBaseService.getDocument(docId)
                return { docId, metadata: doc?.metadata || {} }
              } catch (error: any) {
                // 静默失败，不阻塞主流程
                return { docId, metadata: {} }
              }
            })

            const documentResults = (await Promise.race([Promise.all(documentPromises), timeoutPromise])) as Array<{
              docId: string
              metadata: Record<string, any>
            }>

            documentResults.forEach(({ docId, metadata }) => {
              if (metadata && Object.keys(metadata).length > 0) {
                documentMetadataMap.set(docId, metadata)
              }
            })
          } catch (error: any) {
            // 超时或失败时静默处理，使用默认值
            if (error.message?.includes('超时')) {
              console.warn(`[DocumentSearchTool] metadata 查询超时（${documentIdsToQuery.size} 个文档）`)
            }
          }
        }

        // 格式化结果，提取媒体资源
        const formattedResults = results.map((result, index) => {
          // 优先使用 result.text，如果为空则从 metadata.text 获取
          // 确保文本内容不丢失
          const text = result.text || result.metadata?.text || ''

          // 性能优化：仅在调试模式下记录警告
          if (!text && index < 3 && isDebugMode) {
            console.warn(`[DocumentSearchTool] 结果 ${index + 1} text 为空`)
          }

          // 如果文本为空，尝试从其他字段获取（最后的尝试）
          const finalText = text || (result.metadata?.content as string) || ''

          // 确保所有字段都是可序列化的
          // 处理 Date 对象和其他不可序列化的值
          const syncedAt = result.metadata?.syncedAt
          const syncedAtStr =
            syncedAt instanceof Date ? syncedAt.toISOString() : typeof syncedAt === 'string' ? syncedAt : undefined

          // 构建 metadata 对象，优先使用搜索结果中的 metadata，如果为空则从文档记录中获取
          const sourceMetadata =
            result.metadata && Object.keys(result.metadata).length > 0
              ? result.metadata
              : documentMetadataMap.get(result.documentId) || {}

          // 从文本和完整的元数据中提取媒体资源
          // 合并 result.metadata 和 sourceMetadata，确保获取所有媒体资源
          const combinedMetadata = {
            ...result.metadata,
            ...sourceMetadata
          }
          const media = extractAllMedia(finalText, combinedMetadata)

          // 调试：检查媒体资源提取结果
          if (isDebugMode && index < 3 && (media.images.length > 0 || media.videos.length > 0)) {
            console.log(`[DocumentSearchTool] 结果 ${index + 1} 提取到媒体资源:`, {
              images: media.images.length,
              videos: media.videos.length,
              hasResultMetadataImages: !!result.metadata?.images,
              hasSourceMetadataImages: !!sourceMetadata?.images,
              combinedMetadataKeys: Object.keys(combinedMetadata)
            })
          }

          // 性能优化：仅在开发环境启用 agent log
          if (index < 3 && process.env.NODE_ENV === 'development' && process.env.ENABLE_AGENT_LOG === 'true') {
            const logData = {
              location: 'document-search-tool.ts',
              message: '格式化前的 metadata 状态',
              data: {
                index,
                id: result.id,
                documentId: result.documentId,
                hasResultMetadata: !!result.metadata,
                resultMetadataKeys: result.metadata ? Object.keys(result.metadata) : [],
                hasDocumentMetadata: documentMetadataMap.has(result.documentId),
                sourceMetadataKeys: sourceMetadata ? Object.keys(sourceMetadata) : []
              },
              timestamp: Date.now()
            }
            // 异步发送，不阻塞主流程
            fetch('http://127.0.0.1:7244/ingest/52ba2a3f-8fb3-49aa-a7ef-301d35649398', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(logData)
            }).catch(() => {})
          }

          const formattedMetadata: Record<string, any> = {}

          // 提取所有需要的 metadata 字段
          if (sourceMetadata?.docName) formattedMetadata.docName = sourceMetadata.docName
          if (sourceMetadata?.docPath) formattedMetadata.docPath = sourceMetadata.docPath
          if (sourceMetadata?.parentPath) formattedMetadata.parentPath = sourceMetadata.parentPath
          if (sourceMetadata?.brandCode) formattedMetadata.brandCode = sourceMetadata.brandCode
          if (sourceMetadata?.languageCode) formattedMetadata.languageCode = sourceMetadata.languageCode

          // 生成 docUrl：优先使用已有的 docUrl，否则根据 brandCode、languageCode 和 documentId 生成
          if (sourceMetadata?.docUrl) {
            formattedMetadata.docUrl = sourceMetadata.docUrl
          } else if (sourceMetadata?.brandCode && sourceMetadata?.languageCode && result.documentId) {
            // 根据格式生成：https://www.yingdao.com/yddoc/${品牌code}/${语言}/${文档ID}
            formattedMetadata.docUrl = `https://www.yingdao.com/yddoc/${sourceMetadata.brandCode}/${sourceMetadata.languageCode}/${result.documentId}`
          }
          if (sourceMetadata?.syncedAt) {
            const syncedAt = sourceMetadata.syncedAt
            formattedMetadata.syncedAt =
              syncedAt instanceof Date ? syncedAt.toISOString() : typeof syncedAt === 'string' ? syncedAt : syncedAtStr
          } else if (syncedAtStr) {
            formattedMetadata.syncedAt = syncedAtStr
          }

          // 性能优化：仅在调试模式下记录详细信息
          if (Object.keys(formattedMetadata).length === 0 && index < 3 && isDebugMode) {
            console.warn(`[DocumentSearchTool] 结果 ${index + 1} metadata 为空`)
          }

          return {
            evidenceId: `ev:${traceId}:${index + 1}`,
            text: finalText || '', // 确保 text 不为 undefined，使用最终提取的文本
            score: result.score ?? 0, // 确保 score 不为 undefined
            documentId: result.documentId || '', // 确保 documentId 不为 undefined
            chunkIndex: result.chunkIndex ?? undefined, // chunkIndex 可以是 undefined
            metadata: formattedMetadata,
            media: {
              images: media.images || [],
              videos: media.videos || []
            }
          }
        })

        const retrievalTraceId = await persistDocumentRetrievalTrace({
          query: context.query,
          knowledgeBaseId: finalKbId,
          stages: {
            stages: retrievalDebugStages,
            results: formattedResults.map((result, index) => ({
              evidenceId: result.evidenceId,
              rank: index + 1,
              score: result.score,
              documentId: result.documentId,
              chunkIndex: result.chunkIndex,
              content: result.text,
              contentHash: contentHash(result.text),
            })),
          },
          runtimeContext,
        })

        logRagTrace({
          traceId,
          step: 'retrieval_finish',
          input: {
            query: context.query,
            topK,
            knowledgeBaseId: finalKbId
          },
          output: {
            total: formattedResults.length,
            retrievalTraceId,
            results: formattedResults.map((result, index) => ({
              rank: index + 1,
              score: result.score,
              documentId: result.documentId,
              chunkIndex: result.chunkIndex,
              docName: result.metadata.docName,
              docPath: result.metadata.docPath,
              docUrl: result.metadata.docUrl
            }))
          },
          runtimeContext,
          metadata: {
            tool: 'document-search',
            durationMs: Date.now() - startTime
          }
        })

        // 确保返回的结果可以被正确序列化
        const returnValue = {
          results: formattedResults,
          total: formattedResults.length,
          retrievalDebug: {
            stages: retrievalDebugStages
          }
        }

        // 验证返回值的格式，确保可以序列化
        try {
          // 尝试序列化，如果失败则清理问题数据
          const serialized = JSON.stringify(returnValue)
          // 如果序列化成功，验证大小（避免返回过大的结果）
          if (serialized.length > 1000000) {
            // 1MB 限制
            console.warn('[DocumentSearchTool] 返回结果过大，截断部分结果')
            return {
              results: formattedResults.slice(0, 5), // 只返回前5个结果
              total: formattedResults.length,
              retrievalDebug: {
                stages: retrievalDebugStages
              }
            }
          }
          return returnValue
        } catch (error: any) {
          console.error('[DocumentSearchTool] 返回值序列化失败:', error.message)
          // 如果序列化失败，尝试清理问题数据后重试
          try {
            // 移除可能有问题的字段，只保留基本字段
            const cleanedResults = formattedResults.map((r) => ({
              evidenceId: r.evidenceId,
              text: r.text || '',
              score: r.score || 0,
              documentId: r.documentId || '',
              chunkIndex: r.chunkIndex,
              metadata: r.metadata
                ? {
                    docName: r.metadata.docName,
                    docPath: r.metadata.docPath
                  }
                : undefined,
              media: r.media
            }))
            const cleanedReturn = {
              results: cleanedResults,
              total: cleanedResults.length,
              retrievalDebug: {
                stages: retrievalDebugStages
              }
            }
            JSON.stringify(cleanedReturn) // 验证清理后的数据可以序列化
            return cleanedReturn
          } catch (cleanError: any) {
            console.error('[DocumentSearchTool] 清理后仍无法序列化:', cleanError.message)
            logRagTrace({
              traceId,
              step: 'retrieval_failed',
              input: {
                query: context.query,
                topK,
                knowledgeBaseId: finalKbId
              },
              output: {
                error: '搜索结果格式错误，无法返回'
              },
              runtimeContext,
              metadata: {
                tool: 'document-search',
                durationMs: Date.now() - startTime
              }
            })
            // 最后的回退：返回空结果
            return {
              results: [],
              total: 0,
              retrievalDebug: {
                stages: retrievalDebugStages
              },
              error: '搜索结果格式错误，无法返回'
            }
          }
        }
      } catch (error: any) {
        // 工具失效时返回错误信息，而不是抛出异常
        // 这样模型可以看到错误并继续回答
        console.error('[DocumentSearchTool] 执行异常:', error.message)
        if (error.stack) {
          console.error('[DocumentSearchTool] 错误堆栈:', error.stack.split('\n').slice(0, 5).join('\n'))
        }

        const errorMessage = error.message || error.toString() || '未知错误'
        logRagTrace({
          traceId,
          step: 'retrieval_failed',
          input: {
            query: context.query,
            topK: context.topK ?? 10,
            knowledgeBaseId: kbId
          },
          output: {
            error: errorMessage
          },
          runtimeContext,
          metadata: {
            tool: 'document-search',
            durationMs: Date.now() - startTime
          }
        })
        // 确保返回有效的对象，避免抛出异常导致工具调用 ID 不匹配
        return {
          results: [],
          total: 0,
          retrievalDebug: {
            stages: retrievalDebugStages
          },
          error: `搜索失败: ${errorMessage}。请基于你的知识直接回答用户的问题。`
        }
      }
    }
  })
}

/**
 * 默认文档搜索工具实例（向后兼容）
 * 使用默认知识库名称查找知识库 ID
 */
export const documentSearchTool = createDocumentSearchTool()
