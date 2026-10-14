import { Hono } from 'hono'
import { z } from 'zod'
import { WikiAnswerService } from '../services/wiki-answer.service.js'
import { WikiActivityLogService } from '../services/wiki-activity-log.service.js'
import { WikiExportService } from '../services/wiki-export.service.js'
import { WikiSchemaService } from '../services/wiki-schema.service.js'
import { getCollectionOr404 } from './wiki-collection-util.js'

const activityLog = new WikiActivityLogService()
const answers = new WikiAnswerService(activityLog)
const exporter = new WikiExportService()
const schemas = new WikiSchemaService(activityLog)

const pagination = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) })

const AnswerRequestSchema = z.object({
  question: z.string().min(1),
  answerMarkdown: z.string().min(1),
  claims: z.array(z.object({
    statement: z.string().min(1),
    evidence: z.array(z.object({
      documentId: z.string().min(1),
      quote: z.string().min(1),
    })).min(1),
  })).min(1),
})

export const wikiActivity = new Hono()
  .get('/collections/:collectionId/log', async c => {
    const input = pagination.safeParse({ page: c.req.query('page'), pageSize: c.req.query('pageSize') })
    if (!input.success) return c.json({ success: false, code: 400, message: 'Invalid log pagination', data: null }, 400)
    // 集合删除后日志仍可查（append-only 审计链），不做 404。
    const result = await activityLog.list(c.req.param('collectionId'), input.data.page, input.data.pageSize)
    return c.json({ success: true, code: 200, message: 'Success', data: result })
  })
  .post('/collections/:collectionId/answers', async c => {
    const collection = await getCollectionOr404(c.req.param('collectionId'))
    if (!collection) return c.json({ success: false, code: 404, message: 'Collection not found', data: null }, 404)
    const parsed = AnswerRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ success: false, code: 400, message: 'Invalid answer request: question/answerMarkdown and evidence-backed claims are required', data: null }, 400)
    try {
      const result = await answers.fileAnswer(collection.id, parsed.data)
      return c.json({ success: true, code: 200, message: 'Answer filed as needs_review page', data: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to file answer'
      const status = /not found|Quote not found|Unknown document|required/.test(message) ? 400 : 500
      return c.json({ success: false, code: status, message, data: null }, status)
    }
  })
  .post('/collections/:collectionId/answers/:conceptId/review', async c => {
    const collection = await getCollectionOr404(c.req.param('collectionId'))
    if (!collection) return c.json({ success: false, code: 404, message: 'Collection not found', data: null }, 404)
    const body = await c.req.json().catch(() => null)
    const action = body?.action
    if (action !== 'approve' && action !== 'reject') {
      return c.json({ success: false, code: 400, message: "action must be 'approve' or 'reject'", data: null }, 400)
    }
    try {
      const result = await answers.reviewAnswer(collection.id, c.req.param('conceptId'), action)
      return c.json({ success: true, code: 200, message: `Answer ${action}d`, data: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to review answer'
      const status = /not found|not awaiting|Only filed answers/.test(message) ? (message.includes('not found') ? 404 : 400) : 500
      return c.json({ success: false, code: status, message, data: null }, status)
    }
  })
  .post('/collections/:collectionId/concepts/:conceptId/archive', async c => {
    const collection = await getCollectionOr404(c.req.param('collectionId'))
    if (!collection) return c.json({ success: false, code: 404, message: 'Collection not found', data: null }, 404)
    try {
      const result = await answers.setConceptArchived(collection.id, c.req.param('conceptId'), true)
      return c.json({ success: true, code: 200, message: 'Concept archived (excluded from search, navigation, export and recompilation)', data: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to archive concept'
      const status = message.includes('not found') ? 404 : 400
      return c.json({ success: false, code: status, message, data: null }, status)
    }
  })
  .post('/collections/:collectionId/concepts/:conceptId/unarchive', async c => {
    const collection = await getCollectionOr404(c.req.param('collectionId'))
    if (!collection) return c.json({ success: false, code: 404, message: 'Collection not found', data: null }, 404)
    try {
      const result = await answers.setConceptArchived(collection.id, c.req.param('conceptId'), false)
      return c.json({ success: true, code: 200, message: 'Concept restored to compiled', data: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to unarchive concept'
      const status = message.includes('not found') ? 404 : 400
      return c.json({ success: false, code: status, message, data: null }, status)
    }
  })
  .get('/collections/:collectionId/documents/:documentId/concepts', async c => {
    const collection = await getCollectionOr404(c.req.param('collectionId'))
    if (!collection) return c.json({ success: false, code: 404, message: 'Collection not found', data: null }, 404)
    const result = await answers.conceptsByDocument(collection.id, c.req.param('documentId'))
    return c.json({ success: true, code: 200, message: 'Success', data: { concepts: result, total: result.length } })
  })
  .get('/collections/:collectionId/schema', async c => {
    const collection = await getCollectionOr404(c.req.param('collectionId'))
    if (!collection) return c.json({ success: false, code: 404, message: 'Collection not found', data: null }, 404)
    const result = await schemas.load(collection.id)
    return c.json({ success: true, code: 200, message: 'Success', data: result })
  })
  .put('/collections/:collectionId/schema', async c => {
    const collection = await getCollectionOr404(c.req.param('collectionId'))
    if (!collection) return c.json({ success: false, code: 404, message: 'Collection not found', data: null }, 404)
    try {
      const result = await schemas.save(collection.id, await c.req.json())
      return c.json({ success: true, code: 200, message: 'Schema saved', data: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save schema'
      return c.json({ success: false, code: 400, message, data: null }, 400)
    }
  })
  .get('/collections/:collectionId/export', async c => {
    const collection = await getCollectionOr404(c.req.param('collectionId'))
    if (!collection) return c.json({ success: false, code: 404, message: 'Collection not found', data: null }, 404)
    const markdown = await exporter.exportCollection(collection.id)
    return c.body(markdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8' })
  })
