/**
 * 知识库 agent 检索工具集。
 *
 * 替代源工程 apis/knowledge-base/tools/index.ts 的默认 tool 实例：
 * 全部为普通异步函数，按需直接调用或注册到 agent 平台。
 */
export * from './vector-query-tool'
export * from './graph-query-tool'

import { queryKnowledgeBaseVectors } from './vector-query-tool'
import { graphQuery } from './graph-query-tool'

/** 知识库检索工具聚合（替代源默认工具实例） */
export const knowledgeTools = {
  queryKnowledgeBaseVectors,
  graphQuery
}
