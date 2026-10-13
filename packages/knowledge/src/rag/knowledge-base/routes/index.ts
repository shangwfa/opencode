import { Hono } from 'hono'
import { createKnowledgeBase } from './create'
import { listKnowledgeBases } from './list'
import { getKnowledgeBase } from './get'
import { deleteKnowledgeBase } from './delete'
import { addDocument } from './documents'
import { listDocuments } from './document-list'
import { getDocument } from './document-get'
import { updateDocument } from './document-update'
import { deleteDocument } from './document-delete'
import { listChunks } from './chunk-list'
import { listAllChunks } from './chunk-list-all'
import { getChunk } from './chunk-get'
import { search } from './search'
import { syncFromYydoc, syncDocumentFromYydoc, syncFromDocPlatform } from './sync-from-yydoc'
import { getSyncTaskStatus, retryFailedDocuments, retryDocument } from './sync-task-status'

// 知识库管理路由
export { createKnowledgeBase } from './create'
export { listKnowledgeBases } from './list'
export { getKnowledgeBase } from './get'
export { deleteKnowledgeBase } from './delete'

// 文档管理路由
export { addDocument } from './documents'
export { listDocuments } from './document-list'
export { getDocument } from './document-get'
export { updateDocument } from './document-update'
export { deleteDocument } from './document-delete'

// 块管理路由
export { listChunks } from './chunk-list'
export { listAllChunks } from './chunk-list-all'
export { getChunk } from './chunk-get'

// 搜索路由
export { search } from './search'

// 文档同步路由
export { syncFromYydoc, syncDocumentFromYydoc, syncFromDocPlatform } from './sync-from-yydoc'
export { getSyncTaskStatus, retryFailedDocuments, retryDocument } from './sync-task-status'

/**
 * 知识库子应用（Hono sub-app）：本域路由均为相对路径，
 * 由 app.ts 以 '/knowledge-base' 前缀 app.route() 挂载。
 */
export const knowledgeBaseApp = new Hono()
  .route('/', createKnowledgeBase)
  .route('/', listKnowledgeBases)
  .route('/', getKnowledgeBase)
  .route('/', deleteKnowledgeBase)
  .route('/', addDocument)
  .route('/', listDocuments)
  .route('/', getDocument)
  .route('/', updateDocument)
  .route('/', deleteDocument)
  .route('/', listChunks)
  .route('/', listAllChunks)
  .route('/', getChunk)
  .route('/', search)
  .route('/', syncFromYydoc)
  .route('/', syncDocumentFromYydoc)
  .route('/', syncFromDocPlatform)
  .route('/', getSyncTaskStatus)
  .route('/', retryFailedDocuments)
  .route('/', retryDocument)

export type KnowledgeBaseAppType = typeof knowledgeBaseApp
