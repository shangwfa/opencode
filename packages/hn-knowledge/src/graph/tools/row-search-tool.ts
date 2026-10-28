import { createTool } from '../../utils/create-tool.js'
import { z } from 'zod'
import { embed } from 'ai'
import { openaiEmbedding } from '../../providers/llm.js'
import { getRowStore } from '../rows/index.js'
import { RowRetriever } from '../rows/row-retriever.js'

export const rowSearchTool = createTool({
  id: 'row-search',
  description:
    '在结构化数据表（FAQ、产品清单、配置表等）中语义检索行记录。适合查找"某类条目/清单/表格数据"的问题。',
  inputSchema: z.object({
    schemaName: z.string().describe('数据表 schema 名称'),
    query: z.string().describe('搜索查询，描述要找的行记录内容'),
    topK: z.number().int().positive().optional().default(5).describe('返回条数，默认 5'),
  }),
  outputSchema: z.object({
    records: z.array(
      z.object({
        data: z.record(z.string(), z.unknown()).describe('行数据'),
        score: z.number().describe('相似度 (0-1)'),
      })
    ),
    error: z.string().optional().describe('错误信息'),
  }),
  execute: async ({ context }) => {
    try {
      const store = getRowStore()
      const schema = store.getSchema(context.schemaName)
      if (!schema) {
        return { records: [], error: `未注册的数据表 schema: ${context.schemaName}` }
      }

      const embeddingModel = openaiEmbedding('text-embedding-3-small')
      const { embedding: queryEmbedding } = await embed({
        value: context.query,
        model: embeddingModel,
      })

      const retriever = new RowRetriever(store)
      const results = await retriever.search(schema, queryEmbedding, { topK: context.topK || 5 })

      return {
        records: results.map((r) => ({
          data: r.record.data,
          score: r.score,
        })),
      }
    } catch (error: any) {
      return { records: [], error: `行检索失败: ${error.message}` }
    }
  },
})
