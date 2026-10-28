import { getDatabaseSchema } from '../config/env.js'
import { initGraphEngine } from './pg-adapter/index.js'
import type { GraphBrowseRepository } from './pg-adapter/browse.js'

let initializing: Promise<GraphBrowseRepository> | undefined

/** 只读浏览无需初始化 LLM/embedding，也不依赖搜索 pipeline 单例。 */
export async function getGraphBrowseService() {
  if (!initializing) {
    initializing = initGraphEngine(getDatabaseSchema()).then(adapter => adapter.browse).catch(error => {
      initializing = undefined
      throw error
    })
  }
  return initializing
}
