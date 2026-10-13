/**
 * @opencode/knowledge 对外入口。
 *
 * 典型用法（独立服务）：`bun run src/server.ts`
 * 嵌入到其它 hono 服务：`import { createKnowledgeApp } from '@opencode/knowledge/app'`
 */
export { createKnowledgeApp } from "./app.js"
export { initDatabase, db, pool, schemaName, knowledgeBases, documents, syncTasks } from "./db/index.js"
export * from "./config/env.js"
export * from "./rag/knowledge-base/index.js"
export { knowledgeTools, queryKnowledgeBaseVectors, graphQuery } from "./tools/index.js"
