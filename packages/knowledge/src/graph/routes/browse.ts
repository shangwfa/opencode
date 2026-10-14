import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { getGraphBrowseService } from '../browse-services.js'
import { GraphBrowseNotFoundError } from '../pg-adapter/browse.js'

const name = z.string().trim().min(1).max(255)
const scope = { knowledgeBaseId: name }
const direction = z.enum(['incoming', 'outgoing', 'both'])
const relationTypes = z.array(name).min(1).max(20).optional()
const budgets = { maxNodes: z.number().int().min(1).max(200).default(100), maxEdges: z.number().int().min(1).max(500).default(200) }
const page = { limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(10_000).default(0) }
const relationQuery = z.object({ ...scope, ...page, nodeId: z.string().uuid(), direction: direction.default('both'),
  relationTypes: z.preprocess(v => typeof v === 'string' ? v.split(',').map(s => s.trim()) : v, relationTypes),
}).strict()
const subgraph = z.object({ ...scope, ...budgets, offset: z.number().int().min(0).max(10_000).default(0),
  nodeIds: z.array(z.string().uuid()).min(1).max(100).optional(), nodeTypes: z.array(name).min(1).max(20).optional(),
  attributes: z.record(z.string().min(1).max(128), z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]))
    .refine(v => Object.keys(v).length <= 20, '最多 20 个属性过滤条件').optional(),
  nodeSetLabel: name.optional(), documentId: name.optional(), relationTypes,
}).strict()
const traversal = { ...scope, ...budgets, direction: direction.default('both'), relationTypes, maxDepth: z.number().int().min(1).max(4).default(2) }
const neighborhood = z.object({ ...traversal, seedIds: z.array(z.string().uuid()).min(1).max(20) }).strict()
  .refine(v => new Set(v.seedIds).size <= v.maxNodes, 'maxNodes 不能小于种子数量')
const paths = z.object({ ...traversal, direction: direction.default('outgoing'), sourceId: z.string().uuid(), targetId: z.string().uuid(),
  maxPaths: z.number().int().min(1).max(20).default(10),
}).strict()
const provenance = z.object({ ...scope, sourceId: z.string().uuid(), targetId: z.string().uuid(), relationshipName: name,
  limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).max(10_000).default(0),
}).strict()
const relationTypeQuery = z.object({ ...scope, ...page }).strict()
const invalid = (c: Context, error: unknown) => c.json({ code: 400, success: false, message: `参数校验失败: ${error}`, data: null }, 400)
const failed = (c: Context, error: unknown) => {
  if (error instanceof GraphBrowseNotFoundError) return c.json({ code: 404, success: false, message: error.message, data: null }, 404)
  console.error('[GraphBrowse] query failed:', error)
  return c.json({ code: 500, success: false, message: '图关系查询失败', data: null }, 500)
}

export const graphBrowseRoutes = new Hono()
  .get('/nodes/:nodeId/relations', async c => {
    const parsed = relationQuery.safeParse({ ...c.req.query(), nodeId: c.req.param('nodeId') })
    if (!parsed.success) return invalid(c, parsed.error.message)
    try {
      const service = await getGraphBrowseService()
      return c.json({ code: 200, success: true, message: 'ok', data: await service.relations(parsed.data) })
    } catch (error) { return failed(c, error) }
  })
  .post('/subgraph', async c => {
    let body: unknown
    try { body = await c.req.json() } catch { return invalid(c, '无效 JSON') }
    const parsed = subgraph.safeParse(body)
    if (!parsed.success) return invalid(c, parsed.error.message)
    try {
      const service = await getGraphBrowseService()
      return c.json({ code: 200, success: true, message: 'ok', data: await service.subgraph(parsed.data) })
    } catch (error) { return failed(c, error) }
  })
  .post('/neighborhood', async c => {
    let body: unknown
    try { body = await c.req.json() } catch { return invalid(c, '无效 JSON') }
    const parsed = neighborhood.safeParse(body)
    if (!parsed.success) return invalid(c, parsed.error.message)
    try {
      const service = await getGraphBrowseService()
      return c.json({ code: 200, success: true, message: 'ok', data: await service.neighborhood(parsed.data) })
    } catch (error) { return failed(c, error) }
  })
  .post('/paths', async c => {
    let body: unknown
    try { body = await c.req.json() } catch { return invalid(c, '无效 JSON') }
    const parsed = paths.safeParse(body)
    if (!parsed.success) return invalid(c, parsed.error.message)
    try {
      const service = await getGraphBrowseService()
      return c.json({ code: 200, success: true, message: 'ok', data: await service.paths(parsed.data) })
    } catch (error) { return failed(c, error) }
  })
  .post('/edges/provenance', async c => {
    let body: unknown
    try { body = await c.req.json() } catch { return invalid(c, '无效 JSON') }
    const parsed = provenance.safeParse(body)
    if (!parsed.success) return invalid(c, parsed.error.message)
    try {
      const service = await getGraphBrowseService()
      return c.json({ code: 200, success: true, message: 'ok', data: await service.provenance(parsed.data) })
    } catch (error) { return failed(c, error) }
  })
  .get('/relation-types', async c => {
    const parsed = relationTypeQuery.safeParse(c.req.query())
    if (!parsed.success) return invalid(c, parsed.error.message)
    try {
      const service = await getGraphBrowseService()
      return c.json({ code: 200, success: true, message: 'ok', data: await service.relationTypes(parsed.data) })
    } catch (error) { return failed(c, error) }
  })

export type GraphBrowseAppType = typeof graphBrowseRoutes
