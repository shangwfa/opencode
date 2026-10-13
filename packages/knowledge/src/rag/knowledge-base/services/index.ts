import { VectorService } from './vector.service'
import { DocumentService } from './document.service'
import { KnowledgeBaseService } from './knowledge-base.service'
import { KeywordSearchService } from './keyword-search.service'
import { HybridSearchService } from './hybrid-search.service'
import { RecallService } from './recall.service'
import { RerankService } from './rerank.service'
import { YddocApiService } from './yddoc-api.service'
import { SyncTaskService } from './sync-task.service'
import { DocumentSyncService } from './document-sync.service'
import { getDatabaseUrl, getDatabaseSchema } from '../../../config/env.js'

const connectionString = getDatabaseUrl()
const schemaName = getDatabaseSchema()

if (!connectionString) {
  console.warn('DATABASE_URL is not set, knowledge base features may not work')
}

// 初始化服务
export const vectorService = new VectorService(connectionString, schemaName)
export const keywordSearchService = new KeywordSearchService(connectionString, vectorService, schemaName)
export const documentService = new DocumentService(vectorService)
export const knowledgeBaseService = new KnowledgeBaseService(vectorService, keywordSearchService)
export const hybridSearchService = new HybridSearchService(vectorService, keywordSearchService)
export const recallService = new RecallService(vectorService, keywordSearchService)
export const rerankService = new RerankService()

// 文档同步相关服务
export const yddocApiService = new YddocApiService()
export const syncTaskService = new SyncTaskService()
export const documentSyncService = new DocumentSyncService(
  yddocApiService,
  knowledgeBaseService,
  documentService,
  vectorService,
  syncTaskService
)
