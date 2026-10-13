/**
 * kb-document-search MCP Server（迁移自源工程 mastra/mcp/kb-document-search-server.ts）。
 *
 * 使用 @modelcontextprotocol/sdk（官方 TS SDK）替代 @mastra/mcp 的 MCPServer：
 * - 工具集、名称、描述、入参/出参 schema 与源保持一致；
 * - 检索逻辑复用 runMultiKbDocumentSearch（src/mcp/multi-kb-document-search.ts），
 *   MCP wrapper 只负责输入透传和输出裁剪。
 *
 * 传输形态：
 * - stdio：src/mcp/server.ts（StdioServerTransport）
 * - HTTP：src/mcp/http.ts（Streamable HTTP，stateless）
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createMultiKbDocumentSearchTool } from '../tools/multi-kb-document-search-tool.js'
import { getMcpKbDocumentSearchDefaultKbs } from '../config/env.js'

export const KB_DOCUMENT_SEARCH_SERVER_INFO = {
  name: '文档知识库搜索',
  version: '1.0.0',
  description: '搜索文档知识库并返回文档片段、源元数据和媒体 URL'
} as const

/**
 * MCP 默认知识库支持通过环境变量调整，避免只为切换默认知识库重新发版。
 * 单次调用时传入 knowledgeBaseIds / knowledgeBaseNames 仍然会覆盖这里的默认值。
 */
function getDefaultKnowledgeBases(): string[] {
  const fromEnv = getMcpKbDocumentSearchDefaultKbs()
  return fromEnv.length > 0 ? fromEnv : ['kb_rpa_zh_cn', 'kb_ai_wiki_zh_cn']
}

const metadataFieldSchema = z.enum([
  'knowledgeBaseId',
  'knowledgeBaseName',
  'docName',
  'docPath',
  'parentPath',
  'docUrl',
  'brandCode',
  'languageCode',
  'syncedAt'
])

const mcpDocumentSearchInputSchema = z.object({
  query: z
    .string()
    .describe('搜索查询字符串，应该是用户问题的关键词或完整问题'),
  topK: z
    .number()
    .int()
    .positive()
    .optional()
    .default(10)
    .describe('返回的结果数量，默认 10'),
  knowledgeBaseIds: z
    .array(z.string())
    .optional()
    .describe('本次搜索的知识库 ID 列表；若提供则覆盖 MCP 默认知识库'),
  knowledgeBaseNames: z
    .array(z.string())
    .optional()
    .describe('本次搜索的知识库名称列表；若提供则覆盖 MCP 默认知识库'),
  outputOptions: z
    .object({
      includeRetrievalDebug: z
        .boolean()
        .optional()
        .default(false)
        .describe('是否返回 retrievalDebug；默认 false，避免业务方收到调试链路'),
      includeMetadata: z
        .boolean()
        .optional()
        .default(true)
        .describe('是否返回 metadata；默认 true'),
      metadataFields: z
        .array(metadataFieldSchema)
        .optional()
        .describe('需要保留的 metadata 字段；不传则保留全部 metadata'),
      includeMedia: z
        .boolean()
        .optional()
        .default(true)
        .describe('是否返回 media；默认 true'),
      includeText: z
        .boolean()
        .optional()
        .default(true)
        .describe('是否返回正文片段 text；默认 true')
    })
    .optional()
    .default({
      includeRetrievalDebug: false,
      includeMetadata: true,
      includeMedia: true,
      includeText: true
    })
    .describe('MCP 对外返回裁剪选项')
})

const mcpDocumentSearchOutputSchema = z.object({
  results: z.array(z.record(z.string(), z.unknown())).describe('搜索结果列表'),
  total: z.number().describe('结果总数'),
  retrievalDebug: z.unknown().optional().describe('可选检索调试链路'),
  error: z.string().optional().describe('错误信息或部分失败信息')
})

type McpDocumentSearchInput = z.infer<typeof mcpDocumentSearchInputSchema>

function trimResultForMcp(
  result: Record<string, unknown>,
  options: McpDocumentSearchInput['outputOptions']
): Record<string, unknown> {
  const trimmed: Record<string, unknown> = {
    score: result.score,
    documentId: result.documentId
  }

  if (result.chunkIndex !== undefined) {
    trimmed.chunkIndex = result.chunkIndex
  }

  if (options?.includeText !== false) {
    trimmed.text = result.text
  }

  if (options?.includeMetadata !== false && result.metadata) {
    trimmed.metadata = pickMetadataFields(
      result.metadata as Record<string, unknown>,
      options?.metadataFields
    )
  }

  if (options?.includeMedia !== false && result.media) {
    trimmed.media = result.media
  }

  return trimmed
}

function pickMetadataFields(
  metadata: Record<string, unknown>,
  fields: Array<z.infer<typeof metadataFieldSchema>> | undefined
): Record<string, unknown> {
  if (!fields || fields.length === 0) {
    return metadata
  }

  return fields.reduce<Record<string, unknown>>((picked, field) => {
    if (metadata[field] !== undefined) {
      picked[field] = metadata[field]
    }
    return picked
  }, {})
}

/**
 * 创建 kb-document-search MCP Server 实例（stdio / HTTP 共用）。
 */
export function createKbDocumentSearchMcpServer(): McpServer {
  const rawDocumentSearchTool = createMultiKbDocumentSearchTool(getDefaultKnowledgeBases())

  const server = new McpServer(
    { name: KB_DOCUMENT_SEARCH_SERVER_INFO.name, version: KB_DOCUMENT_SEARCH_SERVER_INFO.version },
    {
      instructions: KB_DOCUMENT_SEARCH_SERVER_INFO.description
    }
  )

  server.registerTool(
    'search_yddoc_documents',
    {
      description:
        '搜索 YYDoc 知识库并返回文档片段、来源元数据和媒体 URL；可按调用请求动态指定知识库与返回字段。',
      inputSchema: mcpDocumentSearchInputSchema.shape,
      outputSchema: mcpDocumentSearchOutputSchema.shape
    },
    async (args) => {
      const { outputOptions, ...searchContext } = args

      /**
       * 原始 Tool（src/tools/multi-kb-document-search-tool.ts）负责检索、融合和 trace 记录；
       * MCP wrapper 只负责输入透传和输出裁剪。
       * 这样不会影响现有 Agent 使用完整 retrievalDebug 的能力。
       */
      const rawOutput = await rawDocumentSearchTool.execute({ context: searchContext })

      const options = outputOptions ?? {}
      const results = (rawOutput?.results ?? []).map((result: any) =>
        trimResultForMcp(result as Record<string, unknown>, options)
      )

      const returnValue: Record<string, unknown> = {
        results,
        total: rawOutput?.total ?? results.length,
        ...(options.includeRetrievalDebug && rawOutput?.retrievalDebug
          ? { retrievalDebug: rawOutput.retrievalDebug }
          : {}),
        ...(rawOutput?.error ? { error: rawOutput.error } : {})
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(returnValue)
          }
        ],
        structuredContent: returnValue
      }
    }
  )

  return server
}
