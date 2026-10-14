import { Hono } from 'hono'
import { z } from 'zod'
import { WikiRevisionService } from '../services/wiki-revision.service.js'

const service = new WikiRevisionService()
const pagination = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) })
const revisionNumber = z.coerce.number().int().min(0)

export const wikiRevisions = new Hono()
  .get('/collections/:collectionId/concepts/:conceptId/revisions', async c => {
    const input = pagination.safeParse({ page: c.req.query('page'), pageSize: c.req.query('pageSize') })
    if (!input.success) return c.json({ success: false, code: 400, message: 'Invalid revision pagination', data: null }, 400)
    const result = await service.list(c.req.param('collectionId'), c.req.param('conceptId'), input.data.page, input.data.pageSize)
    if (!result) return c.json({ success: false, code: 404, message: 'Concept not found', data: null }, 404)
    return c.json({ success: true, code: 200, message: 'Success', data: result })
  })
  .get('/collections/:collectionId/concepts/:conceptId/revisions/:revision/diff', async c => {
    const input = revisionNumber.safeParse(c.req.param('revision'))
    const against = revisionNumber.safeParse(c.req.query('against'))
    if (!input.success || !against.success) return c.json({ success: false, code: 400, message: 'Invalid revision number or against parameter', data: null }, 400)
    const result = await service.diff(c.req.param('collectionId'), c.req.param('conceptId'), input.data, against.data)
    if (!result) return c.json({ success: false, code: 404, message: 'Revision not found', data: null }, 404)
    return c.json({ success: true, code: 200, message: 'Success', data: result })
  })
  .get('/collections/:collectionId/concepts/:conceptId/revisions/:revision', async c => {
    const input = revisionNumber.safeParse(c.req.param('revision'))
    if (!input.success) return c.json({ success: false, code: 400, message: 'Invalid revision number', data: null }, 400)
    const result = await service.get(c.req.param('collectionId'), c.req.param('conceptId'), input.data)
    if (!result) return c.json({ success: false, code: 404, message: 'Revision not found', data: null }, 404)
    return c.json({ success: true, code: 200, message: 'Success', data: result })
  })
