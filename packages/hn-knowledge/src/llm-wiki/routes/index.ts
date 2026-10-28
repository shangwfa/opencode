import { Hono } from 'hono'
import { wikiCompile } from './wiki-compile'
import { wikiCompileStatus, wikiCompileRetry, wikiCompileCancel } from './wiki-compile-status'
import { wikiSearch } from './wiki-search'
import { wikiCollectionCreate } from './wiki-collection-create'
import { wikiCollectionList } from './wiki-collection-list'
import { wikiCollectionGet } from './wiki-collection-get'
import { wikiCollectionDelete } from './wiki-collection-delete'
import { wikiConceptGet } from './wiki-concept-get'
import { wikiNavigate, wikiNavigateConcepts, wikiNavigateGraphStats } from './wiki-navigate'
import { wikiLintRun, wikiLintGet } from './wiki-lint'
import { wikiRevisions } from './wiki-revisions'
import { wikiActivity } from './wiki-activity'

export { wikiCompile } from './wiki-compile'
export { wikiCompileStatus } from './wiki-compile-status'
export { wikiSearch } from './wiki-search'
export { wikiCollectionCreate } from './wiki-collection-create'
export { wikiCollectionList } from './wiki-collection-list'
export { wikiCollectionGet } from './wiki-collection-get'
export { wikiCollectionDelete } from './wiki-collection-delete'
export { wikiConceptGet } from './wiki-concept-get'
export { wikiNavigate, wikiNavigateConcepts, wikiNavigateGraphStats } from './wiki-navigate'
export { wikiLintRun, wikiLintGet } from './wiki-lint'

/**
 * llm-wiki 子应用（Hono sub-app）：本域路由均为相对路径，
 * 由 app.ts 以 '/llm-wiki' 前缀 app.route() 挂载。
 */
export const llmWikiApp = new Hono()
  .route('/', wikiCompile)
  .route('/', wikiCompileStatus)
  .route('/', wikiCompileRetry)
  .route('/', wikiCompileCancel)
  .route('/', wikiSearch)
  .route('/', wikiCollectionCreate)
  .route('/', wikiCollectionList)
  .route('/', wikiCollectionGet)
  .route('/', wikiCollectionDelete)
  .route('/', wikiConceptGet)
  .route('/', wikiNavigate)
  .route('/', wikiNavigateConcepts)
  .route('/', wikiNavigateGraphStats)
  .route('/', wikiLintRun)
  .route('/', wikiLintGet)
  .route('/', wikiRevisions)
  .route('/', wikiActivity)

export type LlmWikiAppType = typeof llmWikiApp
