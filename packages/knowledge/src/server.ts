/**
 * 独立知识库服务入口。
 *
 *   KNOWLEDGE_DATABASE_URL=postgresql://... bun run src/server.ts
 *   可选：KNOWLEDGE_PORT（默认 8787）、KNOWLEDGE_HOST（默认 0.0.0.0）
 */
import { serve } from "@hono/node-server"
import { createKnowledgeApp } from "./app.js"
import { ensureNoProxyForInnerHost } from "./providers/inner-proxy.js"

// inner 代理启用时，防止本机 HTTP(S)_PROXY 劫持内网主机（Bun fetch 只识别小写 no_proxy）
ensureNoProxyForInnerHost()

const port = Number(process.env["KNOWLEDGE_PORT"] || 8787)
const host = process.env["KNOWLEDGE_HOST"] || "0.0.0.0"

const app = await createKnowledgeApp()

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`[knowledge] server listening on http://${host}:${info.port}`)
})
