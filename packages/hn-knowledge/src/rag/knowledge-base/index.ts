/**
 * Knowledge-base module public API.
 * Other modules should depend on this facade instead of reaching into its
 * routes, service implementation files, or internal type directory.
 */
export { knowledgeBaseApp, type KnowledgeBaseAppType } from "./routes/index.js"
export * from "./types/knowledge-base.types.js"
export { PgVectorStore } from "./vector/vector-store.js"

export * from "./services/index.js"
export { DocumentService } from "./services/document.service.js"
export { VectorService } from "./services/vector.service.js"
export { getHyDEService } from "./services/hyde.service.js"
export { getMultiQueryService } from "./services/multi-query.service.js"
export type { HybridSearchDebugEvent, HybridSearchOptions } from "./services/hybrid-search.service.js"
