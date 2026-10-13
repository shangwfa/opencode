#!/usr/bin/env bun
/**
 * kb-document-search MCP Server —— stdio 入口。
 *
 * 供 MCP 客户端以命令行方式直接接入（StdioServerTransport）：
 *   bun run /path/to/packages/knowledge/src/mcp/server.ts
 *
 * 注意：
 * - stdout 仅承载 JSON-RPC 消息；进程内所有 console 输出统一重定向到 stderr。
 * - 服务依赖 PG（KNOWLEDGE_DATABASE_URL 等），环境变量见 src/config/env.ts；
 *   可在 MCP 客户端配置的 env 字段中注入。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createKbDocumentSearchMcpServer, KB_DOCUMENT_SEARCH_SERVER_INFO } from './kb-document-search-server.js'

/** stdio 模式下 console 输出走 stderr，避免污染 JSON-RPC 通道 */
function redirectConsoleToStderr(): void {
  const write = (level: string) => (...args: unknown[]) => {
    const line = args
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg)))
      .join(' ')
    process.stderr.write(`[${level}] ${line}\n`)
  }
  console.log = write('log')
  console.info = write('info')
  console.warn = write('warn')
  console.error = write('error')
  console.debug = write('debug')
}

async function main(): Promise<void> {
  redirectConsoleToStderr()

  const server = createKbDocumentSearchMcpServer()
  const transport = new StdioServerTransport()

  await server.connect(transport)
  process.stderr.write(
    `[kb-document-search-mcp] stdio server started (name=${KB_DOCUMENT_SEARCH_SERVER_INFO.name}, version=${KB_DOCUMENT_SEARCH_SERVER_INFO.version})\n`
  )

  const shutdown = async () => {
    try {
      await server.close()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  process.stderr.write(`[kb-document-search-mcp] fatal: ${error?.stack || error}\n`)
  process.exit(1)
})
