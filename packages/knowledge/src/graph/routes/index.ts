import { Hono } from 'hono'
import { ingestGraphDocument } from './ingest.js'
import { deleteGraphDocument } from './document-delete.js'
import { searchGraphRoute } from './search.js'
import { graphStats } from './stats.js'
import { graphBrowseRoutes } from './browse.js'

export { ingestGraphDocument } from './ingest.js'
export { deleteGraphDocument } from './document-delete.js'
export { searchGraphRoute } from './search.js'
export { graphStats } from './stats.js'
export { graphBrowseRoutes } from './browse.js'

/**
 * 知识图谱子应用（Hono sub-app）：路径均为相对路径，
 * 由 app.ts 以 '/graph' 前缀 app.route() 挂载。
 *
 *   POST   /graph/ingest                文档→图摄入（LLM 抽取完整链路）
 *   DELETE /graph/document/:id          按文档删除图数据（溯源语义）
 *   POST   /graph/search                图检索（graphSearch 透传）
 *   GET    /graph/stats                 图库统计
 */
export const graphApp = new Hono()
  .route('/', ingestGraphDocument)
  .route('/', deleteGraphDocument)
  .route('/', searchGraphRoute)
  .route('/', graphStats)
  .route('/', graphBrowseRoutes)

export type GraphAppType = typeof graphApp
