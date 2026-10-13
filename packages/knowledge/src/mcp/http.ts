/**
 * kb-document-search MCP Server —— HTTP 挂载（hono）。
 *
 * 迁移自源工程 apis/mcp/kb-document-search.ts：mastra startHTTP(serverless)
 * 改为 @modelcontextprotocol/sdk 的 StreamableHTTPServerTransport stateless 模式
 * （每个 POST 请求新建 server + transport，无会话状态，适配多副本部署）。
 *
 * hono 的 Request/Response 是 Web 标准 API，而 SDK handleRequest 需要 node 的
 * IncomingMessage/ServerResponse，这里沿用源工程验证过的 buffered 适配层。
 */
import type { Hono } from 'hono'
import { Readable, Writable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createKbDocumentSearchMcpServer } from './kb-document-search-server.js'

export const MCP_KB_DOCUMENT_SEARCH_HTTP_PATH = '/mcp/kb-document-search'

async function handleKbDocumentSearchMcp(c: any): Promise<Response> {
  /**
   * Stateless Streamable HTTP only supports request/response POSTs.
   * MCP clients may optimistically open an optional GET SSE stream for server
   * notifications; 405 tells the SDK this optional stream is not available.
   */
  const method = c.req.raw.method
  if (method !== 'POST') {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: 'POST'
      }
    })
  }

  const url = new URL(c.req.url)
  const body = await readRequestBody(c.req.raw)

  let parsedBody: unknown
  try {
    parsedBody = body.length > 0 ? JSON.parse(body.toString('utf8')) : undefined
  } catch {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' }
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const req = createBufferedNodeRequest(c.req.raw, url, body)
  const res = new BufferedNodeResponse()

  // stateless：每请求新建 server 与 transport，响应后即回收
  const server = createKbDocumentSearchMcpServer()
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, parsedBody)
  } finally {
    await transport.close()
    await server.close()
  }

  return res.toResponse()
}

/** 将 MCP Streamable HTTP 端点挂载到 hono app（无前缀，路径见 MCP_KB_DOCUMENT_SEARCH_HTTP_PATH） */
export function mountMcpRoutes(app: Hono): void {
  app.all(MCP_KB_DOCUMENT_SEARCH_HTTP_PATH, handleKbDocumentSearchMcp)
}

async function readRequestBody(request: Request): Promise<Buffer> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return Buffer.alloc(0)
  }

  return Buffer.from(await request.arrayBuffer())
}

function createBufferedNodeRequest(request: Request, url: URL, body: Buffer): any {
  const headers = headersToIncomingHeaders(request.headers, url)
  const req = Readable.from(body.length > 0 ? [body] : [])

  Object.assign(req, {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers,
    rawHeaders: headersToRawHeaders(headers),
    rawBody: body,
    socket: {
      encrypted: url.protocol === 'https:',
      destroyed: false,
      destroySoon: () => {}
    }
  })

  return req
}

function headersToIncomingHeaders(headers: Headers, url: URL): Record<string, string> {
  const incomingHeaders: Record<string, string> = {}

  headers.forEach((value, key) => {
    incomingHeaders[key.toLowerCase()] = value
  })

  if (!incomingHeaders.host) {
    incomingHeaders.host = url.host
  }

  return incomingHeaders
}

function headersToRawHeaders(headers: Record<string, string>): string[] {
  return Object.entries(headers).flatMap(([key, value]) => [key, value])
}

class BufferedNodeResponse extends Writable {
  statusCode = 200
  headersSent = false
  private readonly chunks: Buffer[] = []
  private readonly headers = new Map<string, string>()

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
    callback()
  }

  writeHead(statusCode: number, headers?: Record<string, unknown>) {
    this.statusCode = statusCode
    this.headersSent = true

    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        this.setHeader(key, value)
      }
    }

    return this
  }

  setHeader(name: string, value: unknown) {
    this.headers.set(name.toLowerCase(), formatHeaderValue(value))
    return this
  }

  getHeader(name: string) {
    return this.headers.get(name.toLowerCase())
  }

  removeHeader(name: string) {
    this.headers.delete(name.toLowerCase())
  }

  toResponse(): Response {
    return new Response(Buffer.concat(this.chunks), {
      status: this.statusCode,
      headers: Object.fromEntries(this.headers)
    })
  }
}

function formatHeaderValue(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : String(value)
}
