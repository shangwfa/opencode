import { Hono } from 'hono'
import { z, ZodError } from 'zod'
import { toBaseKnowledgeError } from './errors.js'
import { baseKnowledgeApiSpecService, baseKnowledgeSearchService, baseKnowledgeService } from './services.js'
import {
  CreateBaseKnowledgeDocumentSchema,
  SearchBaseKnowledgeSchema,
  UpdateBaseKnowledgeDocumentSchema
} from './types.js'

const pathIdSchema = z.string().trim().min(1).max(255)
const ApiSpecSchema = z.object({
  documentId: z.string().trim().min(1).max(255),
  content: z.record(z.string(), z.any()),
  prefix: z.string().trim().optional(),
  limit: z.number().int().positive().optional(),
})

function pathId(c: any, name: 'knowledgeBaseId' | 'documentId'): string {
  return pathIdSchema.parse(c.req.param(name))
}

function documentResponse(document: {
  knowledgeBaseId: string
  documentId: string
  type: string
  chunkCount: number
  version: number
  createdAt: Date
  updatedAt: Date
}) {
  return {
    knowledgeBaseId: document.knowledgeBaseId,
    documentId: document.documentId,
    type: document.type,
    chunkCount: document.chunkCount,
    version: document.version,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  }
}

function errorResponse(c: any, error: unknown) {
  if (error instanceof ZodError) {
    return c.json(
      {
        code: 400,
        success: false,
        message: error.issues.map((issue) => issue.message).join('; '),
        data: null
      },
      400
    )
  }
  if (error instanceof SyntaxError) {
    return c.json(
      {
        code: 400,
        success: false,
        message: 'Invalid JSON request body',
        data: null
      },
      400
    )
  }

  const mapped = toBaseKnowledgeError(error)
  return c.json(
    {
      code: mapped.status,
      success: false,
      message: mapped.message,
      errorCode: mapped.code,
      data: null
    },
    mapped.status
  )
}

async function handleCreateDocument(c: any, knowledgeBaseId: string) {
  try {
    const request = CreateBaseKnowledgeDocumentSchema.parse(await c.req.json())
    const document = await baseKnowledgeService.createDocument(knowledgeBaseId, request)
    return c.json({
      code: 200,
      success: true,
      message: 'Base knowledge document created',
      data: documentResponse(document)
    })
  } catch (error) {
    return errorResponse(c, error)
  }
}

async function handleUpdateDocument(c: any, knowledgeBaseId: string, documentId: string) {
  try {
    const request = UpdateBaseKnowledgeDocumentSchema.parse(await c.req.json())
    const document = await baseKnowledgeService.updateDocument(knowledgeBaseId, documentId, request)
    return c.json({
      code: 200,
      success: true,
      message: 'Base knowledge document updated',
      data: documentResponse(document)
    })
  } catch (error) {
    return errorResponse(c, error)
  }
}

async function handleDeleteDocument(c: any, knowledgeBaseId: string, documentId: string) {
  try {
    await baseKnowledgeService.deleteDocument(knowledgeBaseId, documentId)
    return c.json({
      code: 200,
      success: true,
      message: 'Base knowledge document deleted',
      data: null
    })
  } catch (error) {
    return errorResponse(c, error)
  }
}

async function handleDeleteKnowledgeBase(c: any, knowledgeBaseId: string) {
  try {
    await baseKnowledgeService.deleteKnowledgeBase(knowledgeBaseId)
    return c.json({
      code: 200,
      success: true,
      message: 'Base knowledge deleted',
      data: null
    })
  } catch (error) {
    return errorResponse(c, error)
  }
}

async function handleSearch(c: any, knowledgeBaseId: string) {
  try {
    const request = SearchBaseKnowledgeSchema.parse(await c.req.json())
    const result = await baseKnowledgeSearchService.search(knowledgeBaseId, request)
    return c.json({
      code: 200,
      success: true,
      message: result.degraded ? 'Search completed with degradation' : 'Search completed',
      data: result
    })
  } catch (error) {
    return errorResponse(c, error)
  }
}

async function handleApiSpecIngest(c: any, knowledgeBaseId: string) {
  try {
    const request = ApiSpecSchema.parse(await c.req.json())
    const result = await baseKnowledgeApiSpecService.ingest(knowledgeBaseId, request.documentId, request.content, {
      prefix: request.prefix,
      limit: request.limit,
    })
    return c.json({
      code: 200,
      success: true,
      message: 'API specification ingested',
      data: { documentId: request.documentId, ...result },
    })
  } catch (error) {
    return errorResponse(c, error)
  }
}

export const createBaseKnowledgeDocument = new Hono().post('/:knowledgeBaseId/documents', (c) => handleCreateDocument(c, pathId(c, 'knowledgeBaseId')))

export const updateBaseKnowledgeDocument = new Hono().put('/:knowledgeBaseId/documents/:documentId', (c) => handleUpdateDocument(c, pathId(c, 'knowledgeBaseId'), pathId(c, 'documentId')))

export const deleteBaseKnowledgeDocument = new Hono().delete('/:knowledgeBaseId/documents/:documentId', (c) => handleDeleteDocument(c, pathId(c, 'knowledgeBaseId'), pathId(c, 'documentId')))

export const deleteBaseKnowledge = new Hono().delete('/:knowledgeBaseId', (c) => handleDeleteKnowledgeBase(c, pathId(c, 'knowledgeBaseId')))

export const searchBaseKnowledge = new Hono().post('/:knowledgeBaseId/search', (c) => handleSearch(c, pathId(c, 'knowledgeBaseId')))

export const ingestBaseKnowledgeApiSpec = new Hono().post('/:knowledgeBaseId/api-spec', (c) => handleApiSpecIngest(c, pathId(c, 'knowledgeBaseId')))

/**
 * base-knowledge 子应用（Hono sub-app）：本域路由均为相对路径，
 * 由 app.ts 以 '/base-knowledge' 前缀 app.route() 挂载。
 */
export const baseKnowledgeApp = new Hono()
  .route('/', createBaseKnowledgeDocument)
  .route('/', updateBaseKnowledgeDocument)
  .route('/', deleteBaseKnowledgeDocument)
  .route('/', deleteBaseKnowledge)
  .route('/', searchBaseKnowledge)
  .route('/', ingestBaseKnowledgeApiSpec)

export type BaseKnowledgeAppType = typeof baseKnowledgeApp
