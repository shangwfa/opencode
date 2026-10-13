import { z } from 'zod'

// 枚举类型
export type WikiCollectionStatus = 'active' | 'building' | 'failed'
export type WikiConceptStatus = 'pending' | 'compiled' | 'failed' | 'no_concepts' | 'outdated'
export type WikiCompileTaskStatus = 'pending' | 'running' | 'completed' | 'failed'
export type WikiRelationshipType = 'related' | 'prerequisite' | 'parent-child'

export interface WikiSection {
  heading: string
  content: string
  sourceRefs?: string[]
}

export interface WikiPageContent {
  sections: WikiSection[]
  relatedConcepts?: string[]
}

// Wiki 集合实体
export interface WikiCollection {
  id: string
  knowledgeBaseId: string
  name?: string
  status: WikiCollectionStatus
  lastCompiledAt?: Date
  conceptCount: number
  createdAt: Date
  updatedAt: Date
}

// Wiki 概念实体
export interface WikiConcept {
  id: string
  collectionId: string
  conceptName: string
  slug: string
  definition?: string
  summary?: string
  content?: WikiPageContent
  tags: string[]
  occurrenceCount: number
  status: WikiConceptStatus
  createdAt: Date
  updatedAt: Date
}

// Wiki 概念来源实体
export interface WikiConceptSource {
  id: string
  conceptId: string
  documentId: string
  contentHash: string
  compiledAt: Date
}

// Wiki 关系实体
export interface WikiRelationship {
  id: string
  collectionId: string
  sourceConceptId: string
  targetConceptId: string
  relationshipType: WikiRelationshipType
  strength: number
  createdAt: Date
}

export type WikiCompilePhase =
  | 'extracting'
  | 'extracting_relations'
  | 'generating_pages'
  | 'building_relations'
  | 'generating_index'
  | 'linting'
  | 'done'

// Wiki 编译进度
export interface WikiCompileProgress {
  total: number
  processed: number
  skipped: number
  failed: number
  extracted: number
  phase?: WikiCompilePhase
  pagesGenerated?: number
  pagesToGenerate?: number
  lintResults?: WikiLintResult[]
}

// Wiki 编译任务实体
export interface WikiCompileTask {
  id: string
  collectionId: string
  knowledgeBaseId: string
  status: WikiCompileTaskStatus
  progress: WikiCompileProgress
  error?: string
  startedAt?: Date
  completedAt?: Date
  createdAt: Date
  updatedAt: Date
}

// Zod Schema - 创建 Wiki 集合请求
export const CreateWikiCollectionRequestSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  name: z.string().optional()
})

export type CreateWikiCollectionRequest = z.infer<typeof CreateWikiCollectionRequestSchema>

// Zod Schema - Wiki 搜索请求
export const WikiSearchRequestSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  query: z.string().min(1),
  topK: z.number().int().positive().optional().default(10),
  includeRelated: z.boolean().optional().default(true),
  depth: z.number().int().min(1).max(3).optional().default(2),
  budgetTokens: z.number().int().positive().optional()
})

export type WikiSearchRequest = z.infer<typeof WikiSearchRequestSchema>

// Zod Schema - Wiki 编译请求
export const WikiCompileRequestSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  documentId: z.string().optional(),
})

export type WikiCompileRequest = z.infer<typeof WikiCompileRequestSchema>

// Wiki 搜索结果项
export interface WikiSearchResultItem {
  concept: WikiConcept
  relatedConcepts: WikiConcept[]
  sourceDocumentIds: string[]
}

// Wiki 搜索响应
export interface WikiSearchResponse {
  results: WikiSearchResultItem[]
  total: number
}

export type WikiLintType = 'orphan' | 'broken_link' | 'no_outlinks' | 'contradiction' | 'stale' | 'missing_page' | 'suggestion'
export type WikiLintSeverity = 'warning' | 'info'

export interface WikiLintResult {
  type: WikiLintType
  severity: WikiLintSeverity
  page: string
  detail: string
  affectedPages?: string[]
}

export interface WikiNavigateOverview {
  conceptCount: number
  relationshipCount: number
  tagDistribution: Array<{ tag: string; count: number }>
  recentConcepts: Array<{ id: string; conceptName: string; updatedAt: Date }>
  topConcepts: Array<{ id: string; conceptName: string; occurrenceCount: number | null }>
  relationshipTypeDistribution: Array<{ type: string; count: number }>
}

export interface WikiConceptDetail extends WikiConcept {
  outgoingRelationships: Array<{
    targetConceptId: string
    targetConceptName: string
    relationshipType: string
  }>
  incomingRelationships: Array<{
    sourceConceptId: string
    sourceConceptName: string
    relationshipType: string
  }>
  sourceDocumentIds: string[]
}

export interface WikiGraphStats {
  averageDegree: number
  maxDegree: number
  maxDegreeConcept: { id: string; conceptName: string; degree: number }
  isolatedConceptCount: number
  totalEdges: number
}

export interface WikiBudgetAllocation {
  totalBudget: number
  pagesBudget: number
  indexBudget: number
  systemBudget: number
}

export interface WikiCitedPage {
  citationIndex: number
  conceptId: string
  conceptName: string
  slug: string
  content: WikiPageContent | null
  summary: string | undefined
  relevanceScore: number
  sourceDocumentIds: string[]
  sourceDocuments: {
    docName: string
    docPath?: string
    docUrl?: string
  }[]
}

export interface WikiRetrievalContext {
  context: string
  citedPages: WikiCitedPage[]
  indexOverview: string
  totalEstimatedTokens: number
  budgetAllocation: WikiBudgetAllocation
}

export const WikiNavigateRequestSchema = z.object({
  collectionId: z.string().min(1)
})

export type WikiNavigateRequest = z.infer<typeof WikiNavigateRequestSchema>

export const WikiLintRequestSchema = z.object({
  collectionId: z.string().min(1),
  includeSemantic: z.boolean().optional().default(false)
})

export type WikiLintRequest = z.infer<typeof WikiLintRequestSchema>

export const WikiConceptDetailRequestSchema = z.object({
  collectionId: z.string().min(1),
  conceptId: z.string().optional(),
  slug: z.string().optional()
}).refine(data => data.conceptId || data.slug, {
  message: 'conceptId 或 slug 必须提供其一'
})

export type WikiConceptDetailRequest = z.infer<typeof WikiConceptDetailRequestSchema>

export const WikiRetrievalRequestSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  query: z.string().min(1),
  budgetTokens: z.number().int().positive().optional().default(4000),
  topK: z.number().int().positive().optional().default(10)
})

export type WikiRetrievalRequest = z.infer<typeof WikiRetrievalRequestSchema>
