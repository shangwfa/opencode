// 只导出路由，避免 Mastra 的 Object.values(apiRoutes) 把 service 或普通常量误当成 API route 注册。
export {
  createBaseKnowledgeDocument,
  updateBaseKnowledgeDocument,
  deleteBaseKnowledgeDocument,
  deleteBaseKnowledge,
  searchBaseKnowledge,
  ingestBaseKnowledgeApiSpec
} from './routes.js'
