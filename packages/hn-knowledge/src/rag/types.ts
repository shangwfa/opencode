import { z } from 'zod'
import {
  DEFAULT_SEARCH_TIMEOUT_MS,
  DEFAULT_TOP_K,
  MAX_EXCLUDED_DOCUMENT_IDS,
  MAX_SEARCH_TIMEOUT_MS,
  MAX_TOP_K,
  MIN_SEARCH_TIMEOUT_MS
} from './constants.js'

export type BaseKnowledgeContentType = 'text' | 'markdown' | 'html' | 'tiptap'
export type BaseKnowledgeSearchMode = 'hybrid' | 'keyword' | 'vector'

const documentIdSchema = z.string().trim().min(1).max(255)
const tiptapContentSchema = z.record(z.string(), z.any()).refine((value) => value.type === 'doc', {
  message: 'Tiptap content must be a document object with type="doc"'
})

const stringDocumentSchema = z.object({
  documentId: documentIdSchema,
  type: z.enum(['text', 'markdown', 'html']),
  content: z.string().min(1)
})

const tiptapDocumentSchema = z.object({
  documentId: documentIdSchema,
  type: z.literal('tiptap'),
  content: tiptapContentSchema
})

export const CreateBaseKnowledgeDocumentSchema = z.discriminatedUnion('type', [
  stringDocumentSchema,
  tiptapDocumentSchema
])

export const UpdateBaseKnowledgeDocumentSchema = z.object({
  content: z.union([z.string().min(1), tiptapContentSchema]),
  type: z.enum(['text', 'markdown', 'html', 'tiptap']).optional()
})

export const SearchBaseKnowledgeSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  mode: z.enum(['hybrid', 'keyword', 'vector']).optional().default('hybrid'),
  topK: z.number().int().min(1).max(MAX_TOP_K).optional().default(DEFAULT_TOP_K),
  timeoutMs: z
    .number()
    .int()
    .min(MIN_SEARCH_TIMEOUT_MS)
    .max(MAX_SEARCH_TIMEOUT_MS)
    .optional()
    .default(DEFAULT_SEARCH_TIMEOUT_MS),
  failOnPartialTimeout: z.boolean().optional().default(false),
  excludeDocumentIds: z
    .array(documentIdSchema)
    .max(MAX_EXCLUDED_DOCUMENT_IDS)
    .optional()
    .default([])
})

export type CreateBaseKnowledgeDocumentRequest = z.infer<typeof CreateBaseKnowledgeDocumentSchema>
export type UpdateBaseKnowledgeDocumentRequest = z.infer<typeof UpdateBaseKnowledgeDocumentSchema>
export type SearchBaseKnowledgeRequest = z.infer<typeof SearchBaseKnowledgeSchema>

export interface BaseKnowledgeDocument {
  knowledgeBaseId: string
  documentId: string
  content: string
  normalizedContent: string
  contentHash: string
  type: BaseKnowledgeContentType
  chunkCount: number
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface BaseKnowledgeSpace {
  knowledgeBaseId: string
  embeddingModel: string
  embeddingDimension: number
  indexName: string
}

export interface BaseKnowledgeChunk {
  id: string
  documentId: string
  chunkIndex: number
  text: string
  embedding: number[]
  metadata: Record<string, unknown>
}

export interface BaseKnowledgeSearchItem {
  id: string
  documentId: string
  chunkIndex: number
  text: string
  score: number
  metadata: Record<string, unknown>
}

export type SearchBranchStatus = 'success' | 'timeout' | 'skipped'

export interface SearchBranchReport {
  status: SearchBranchStatus
  durationMs: number
}

export interface BaseKnowledgeSearchResponse {
  items: BaseKnowledgeSearchItem[]
  total: number
  mode: BaseKnowledgeSearchMode
  degraded: boolean
  branches: {
    keyword: SearchBranchReport
    vector: SearchBranchReport
  }
}
