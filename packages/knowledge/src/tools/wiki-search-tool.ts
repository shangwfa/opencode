import { createTool } from '../utils/create-tool.js'
import { z } from 'zod'
import { wikiRetrievalService } from '../llm-wiki/services/index.js'

export function createWikiSearchTool(kbId?: string) {
  return createTool({
    id: 'wiki-search',
    description: '在 Wiki 知识库中检索概念知识上下文。返回带引用编号的概念页面，供 Agent 组装答案使用。适合查询概念定义、功能说明、操作教程等结构化知识。',
    inputSchema: z.object({
      query: z.string().min(1).describe('搜索查询，描述你想了解的概念或功能'),
      topK: z.number().int().positive().optional().default(5).describe('返回结果数量，默认 5'),
      knowledgeBaseId: z.string().optional().describe('知识库 ID，不传则使用默认知识库'),
      budgetTokens: z.number().int().positive().optional().describe('上下文 token 预算，默认 4000'),
    }),
    outputSchema: z.object({
      context: z.string().describe('组装好的带编号上下文文本'),
      citedPages: z.array(z.object({
        citationIndex: z.number(),
        conceptName: z.string(),
        slug: z.string(),
        relevanceScore: z.number(),
        sourceDocuments: z.array(z.object({
          docName: z.string().describe('文档名称；展示来源链接时可作为链接文本'),
          docPath: z.string().optional().describe('文档完整路径；当 docUrl 不存在时可作为文档来源展示'),
          docUrl: z.string().optional().describe('文档完整 URL；展示来源链接时优先使用该字段'),
        })).describe('源文档列表'),
      })).describe('引用的概念页面列表'),
      indexOverview: z.string().describe('Wiki Index 概览'),
      totalEstimatedTokens: z.number().describe('总 token 估算'),
      error: z.string().optional(),
    }),
    execute: async ({ context }) => {
      try {
        const targetKbId = context.knowledgeBaseId || kbId
        if (!targetKbId) {
          return {
            context: '',
            citedPages: [],
            indexOverview: '',
            totalEstimatedTokens: 0,
            error: '未指定知识库 ID',
          }
        }

        const retrievalContext = await wikiRetrievalService.retrieve(
          targetKbId,
          context.query,
          { budgetTokens: context.budgetTokens || 4000 }
        )

        return {
          context: retrievalContext.context,
          citedPages: retrievalContext.citedPages.map(p => ({
            citationIndex: p.citationIndex,
            conceptName: p.conceptName,
            slug: p.slug,
            relevanceScore: p.relevanceScore,
            sourceDocuments: p.sourceDocuments,
          })),
          indexOverview: retrievalContext.indexOverview,
          totalEstimatedTokens: retrievalContext.totalEstimatedTokens,
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Wiki 检索失败'
        return {
          context: '',
          citedPages: [],
          indexOverview: '',
          totalEstimatedTokens: 0,
          error: message,
        }
      }
    },
  })
}

export const wikiSearchTool = createWikiSearchTool(process.env.WIKI_KB_ID)
