import { BaseKnowledgeService } from './base-knowledge.service.js'
import { BaseKnowledgeRepository } from './repository.js'
import { BaseKnowledgeSearchService } from './search.service.js'
import { BaseKnowledgeVectorizationService } from './vectorization.service.js'
import { baseKnowledgeApiSpecService } from './api-spec.service.js'

export const baseKnowledgeRepository = new BaseKnowledgeRepository()
export const baseKnowledgeVectorizationService = new BaseKnowledgeVectorizationService()
export const baseKnowledgeService = new BaseKnowledgeService(
  baseKnowledgeRepository,
  baseKnowledgeVectorizationService
)
export const baseKnowledgeSearchService = new BaseKnowledgeSearchService(baseKnowledgeRepository)
export { baseKnowledgeApiSpecService }
