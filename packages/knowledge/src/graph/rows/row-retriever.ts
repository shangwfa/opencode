import type { RowSchema, RowFilter } from './schema.js'
import type { PgRowStore, RowRecord } from './pg-row-store.js'

export interface RowSearchOptions {
  topK?: number
  filters?: RowFilter[]
}

export interface RowSearchResult {
  record: RowRecord
  score: number
}

/**
 * 行语义检索器（对标 TrustGraph row-embeddings-query）
 *
 * 查询向量在行向量集合中 ANN 检索（可叠加结构化过滤），
 * 返回带相似度的行记录——结构化数据的"模糊检索"通道。
 */
export class RowRetriever {
  private store: PgRowStore

  constructor(store: PgRowStore) {
    this.store = store
  }

  async search(
    schema: RowSchema,
    queryEmbedding: number[],
    options?: RowSearchOptions
  ): Promise<RowSearchResult[]> {
    return this.store.searchSemantic(
      schema,
      queryEmbedding,
      options?.filters,
      options?.topK ?? 10
    )
  }
}
