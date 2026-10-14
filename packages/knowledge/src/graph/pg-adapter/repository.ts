import { Pool } from 'pg'
import { ensurePgSchema } from '../../db/ensure-schema.js'
import type { GraphNode, GraphEdge, CreateNodeInput, CreateEdgeInput, UpdateNodeInput } from '../types.js'
import { prepareNodeRows, prepareEdgeRows, stripNulBytesDeep, componentSizes } from './row-utils.js'

const WRITE_CHUNK_SIZE = 2000

function mergeNodePropertiesSql(schemaName: string): string {
  const old = `${schemaName}.graph_nodes.properties`
  const merged = (key: string) =>
    `COALESCE((SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(COALESCE(${old}->'${key}', '[]'::jsonb) || COALESCE(EXCLUDED.properties->'${key}', '[]'::jsonb))), '[]'::jsonb)`
  return `jsonb_set(jsonb_set(jsonb_set(${old} || EXCLUDED.properties,
    '{mergedFromChunks}', ${merged('mergedFromChunks')}, true),
    '{sourceDocumentIds}', ${merged('sourceDocumentIds')}, true),
    '{pipelineRunIds}', ${merged('pipelineRunIds')}, true)`
}

/**
 * 边属性 upsert 合并：对齐 mergeNodePropertiesSql 的数组并集语义——
 * 跨篇写入同一条边时 sourceDocumentIds/mergedFromChunks/pipelineRunIds 取并集而非覆盖，
 * 其余键保持"最后值获胜"（与节点一致）。
 */
function mergeEdgePropertiesSql(schemaName: string): string {
  const old = `${schemaName}.graph_edges.properties`
  const merged = (key: string) =>
    `COALESCE((SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(COALESCE(${old}->'${key}', '[]'::jsonb) || COALESCE(EXCLUDED.properties->'${key}', '[]'::jsonb))), '[]'::jsonb)`
  return `jsonb_set(jsonb_set(jsonb_set(${old} || EXCLUDED.properties,
    '{mergedFromChunks}', ${merged('mergedFromChunks')}, true),
    '{sourceDocumentIds}', ${merged('sourceDocumentIds')}, true),
    '{pipelineRunIds}', ${merged('pipelineRunIds')}, true)`
}

/**
 * 解析 pgvector 返回的向量字符串（如 "[0.1,0.2,0.3]"）为 number[]
 */
export function parsePgVector(value: unknown): number[] | undefined {
  if (!value) return undefined
  if (Array.isArray(value)) return value as number[]
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

export class GraphRepository {
  private embeddingDimension: number

  constructor(
    private pool: Pool,
    private schemaName: string,
    embeddingDimension?: number
  ) {
    this.embeddingDimension = embeddingDimension || 1536
  }

  private async withClient<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query(`SET search_path TO ${this.schemaName}, public`)
      return await fn(client)
    } finally {
      client.release()
    }
  }

  async initTables(): Promise<void> {
    await this.withClient(async (client) => {
      await ensurePgSchema(client, this.schemaName)

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schemaName}.graph_nodes (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          knowledge_base_id VARCHAR(255) NOT NULL,
          name TEXT NOT NULL,
          type VARCHAR(255) NOT NULL DEFAULT 'entity',
          properties JSONB DEFAULT '{}',
          frequency INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_gn_kb_id ON ${this.schemaName}.graph_nodes(knowledge_base_id)`)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_gn_type ON ${this.schemaName}.graph_nodes(type)`)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_gn_name ON ${this.schemaName}.graph_nodes(name)`)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_gn_props ON ${this.schemaName}.graph_nodes USING GIN(properties)`)
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_gn_kb_name_unique ON ${this.schemaName}.graph_nodes(knowledge_base_id, name)`)

      // 尝试添加 embedding 向量列（依赖 pgvector 扩展，失败则降级为无向量列模式）
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS vector SCHEMA public`)
        // 若列不存在则按固定维度创建（ivfflat 索引要求固定维度）
        await client.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = '${this.schemaName}'
                AND table_name = 'graph_nodes'
                AND column_name = 'embedding'
            ) THEN
              EXECUTE 'ALTER TABLE ${this.schemaName}.graph_nodes ADD COLUMN embedding vector(${this.embeddingDimension})';
            END IF;
          END $$;
        `)
        // 若列已存在但无维度（旧 schema），转换为固定维度
        try {
          await client.query(
            `ALTER TABLE ${this.schemaName}.graph_nodes
             ALTER COLUMN embedding TYPE vector(${this.embeddingDimension})
             USING embedding::text::vector(${this.embeddingDimension})`
          )
        } catch {
          // 列不存在时忽略
        }
        await client.query(
          `CREATE INDEX IF NOT EXISTS idx_gn_embedding ON ${this.schemaName}.graph_nodes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`
        )
      } catch (vecError: any) {
        console.warn(`[图存储] embedding 列创建失败（pgvector 不可用）: ${vecError.message}`)
      }

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schemaName}.graph_edges (
          source_id UUID NOT NULL REFERENCES ${this.schemaName}.graph_nodes(id) ON DELETE CASCADE,
          target_id UUID NOT NULL REFERENCES ${this.schemaName}.graph_nodes(id) ON DELETE CASCADE,
          relationship_name VARCHAR(255) NOT NULL,
          properties JSONB DEFAULT '{}',
          weight REAL NOT NULL DEFAULT 1.0,
          knowledge_base_id VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (source_id, target_id, relationship_name)
        )
      `)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_ge_source ON ${this.schemaName}.graph_edges(source_id)`)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_ge_target ON ${this.schemaName}.graph_edges(target_id)`)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_ge_rel ON ${this.schemaName}.graph_edges(relationship_name)`)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_ge_kb_id ON ${this.schemaName}.graph_edges(knowledge_base_id)`)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_ge_props ON ${this.schemaName}.graph_edges USING GIN(properties)`)

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schemaName}.graph_metadata (
          key VARCHAR(255) PRIMARY KEY,
          value TEXT NOT NULL
        )
      `)

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schemaName}.graph_document_nodes (
          document_id VARCHAR(255) NOT NULL,
          node_id UUID NOT NULL REFERENCES ${this.schemaName}.graph_nodes(id) ON DELETE CASCADE,
          chunk_index INTEGER,
          page_index INTEGER,
           pipeline_run_id VARCHAR(255)
           -- chunk_index is nullable for generic callers; uniqueness is added below
        )
      `)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_gdn_doc_id ON ${this.schemaName}.graph_document_nodes(document_id)`)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_gdn_node_id ON ${this.schemaName}.graph_document_nodes(node_id)`)

      // 既有表迁移：补 page_index 列（对标 TrustGraph Document→Page→Chunk 四级溯源链的字段级实现）
      const pageCol = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'graph_document_nodes' AND column_name = 'page_index'`,
        [this.schemaName]
      )
      if (pageCol.rowCount === 0) {
        await client.query(
          `ALTER TABLE ${this.schemaName}.graph_document_nodes ADD COLUMN page_index INTEGER`
        )
      }

      // 旧版本主键没有 chunk_index，会丢失同一节点在多个 chunk 中的溯源。
      // 表达式索引同时兼容历史 NULL chunk_index 记录。
      await client.query(`
        ALTER TABLE ${this.schemaName}.graph_document_nodes
        DROP CONSTRAINT IF EXISTS graph_document_nodes_pkey
      `)
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_gdn_doc_node_chunk_unique
        ON ${this.schemaName}.graph_document_nodes
          (document_id, node_id, COALESCE(chunk_index, -1))
      `)

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schemaName}.document_chunks (
          document_id VARCHAR(255) NOT NULL,
          chunk_index INTEGER NOT NULL,
          content TEXT NOT NULL,
          pipeline_run_id VARCHAR(255),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (document_id, chunk_index)
        )
      `)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_dc_document ON ${this.schemaName}.document_chunks(document_id)`)

      // chunk 级检查点：持久化每 chunk 的抽取结果，resume 时跳过已完成 chunk 的 LLM。
      // 对标 TrustGraph 队列 ack/nack 的消息级断点语义。
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schemaName}.document_chunk_extractions (
          document_id VARCHAR(255) NOT NULL,
          chunk_index INTEGER NOT NULL,
          extraction JSONB NOT NULL,
          chunk_hash VARCHAR(64),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (document_id, chunk_index)
        )
      `)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_dce_document ON ${this.schemaName}.document_chunk_extractions(document_id)`)
      // 存量表迁移：checkpoint 缓存需要 chunk 内容 hash 判定失效
      await client.query(`ALTER TABLE ${this.schemaName}.document_chunk_extractions ADD COLUMN IF NOT EXISTS chunk_hash VARCHAR(64)`)

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schemaName}.graph_retrieval_traces (
          id UUID PRIMARY KEY,
          knowledge_base_id VARCHAR(255),
          source VARCHAR(32) NOT NULL,
          query_text TEXT NOT NULL,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          answer TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_grt_kb_created ON ${this.schemaName}.graph_retrieval_traces(knowledge_base_id, created_at DESC)`)
    })
  }

  async addNode(input: CreateNodeInput): Promise<string> {
    return this.withClient(async (client) => {
      const id = input.id || crypto.randomUUID()
      const result = await client.query(
        `INSERT INTO ${this.schemaName}.graph_nodes (id, knowledge_base_id, name, type, properties, frequency, embedding, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, NOW(), NOW())
         ON CONFLICT (knowledge_base_id, name) DO UPDATE SET
           type = EXCLUDED.type,
            properties = ${mergeNodePropertiesSql(this.schemaName)},
           frequency = ${this.schemaName}.graph_nodes.frequency + 1,
           embedding = COALESCE(EXCLUDED.embedding, ${this.schemaName}.graph_nodes.embedding),
           updated_at = NOW()
         RETURNING id`,
        [
          id, input.knowledgeBaseId, input.name, input.type,
          JSON.stringify(input.properties || {}), input.frequency || 1,
          input.embedding ? JSON.stringify(input.embedding) : null,
        ]
      )
      // upsert 冲突时实际落库行的 id 可能与传入 id 不同（保留原 id），以 RETURNING 为准
      return result.rows[0]?.id || id
    })
  }

  async addNodes(inputs: CreateNodeInput[]): Promise<string[]> {
    // 净化 + 批内显式 id 去重（最后值获胜）：
    // - NUL 字节剥离（PG 文本不接受 \0）
    // - 同显式 id 的多条输入只写最后一条，但返回 ids 与输入等长（重复位置返回同一 id）
    const sanitized = inputs.map((input) => ({
      ...input,
      id: input.id?.includes('\0') ? input.id.replace(/\0/g, '') : input.id,
      knowledgeBaseId: input.knowledgeBaseId.replace(/\0/g, ''),
      name: input.name.replace(/\0/g, ''),
      type: input.type.replace(/\0/g, ''),
      properties: stripNulBytesDeep(input.properties || {}),
    }))

    const idByInputIndex: Array<string | undefined> = new Array(sanitized.length).fill(undefined)
    const deduped: Array<{ input: CreateNodeInput; inputIndex: number }> = []
    const lastWriteIndexById = new Map<string, number>()
    for (let i = 0; i < sanitized.length; i++) {
      const input = sanitized[i]
      if (input.id) {
        lastWriteIndexById.set(input.id, i) // 后者覆盖前者
      }
    }
    for (let i = 0; i < sanitized.length; i++) {
      const input = sanitized[i]
      if (input.id) {
        if (lastWriteIndexById.get(input.id) === i) {
          deduped.push({ input, inputIndex: i })
        }
        idByInputIndex[i] = input.id
      } else {
        deduped.push({ input, inputIndex: i })
      }
    }

    const generated = new Map<number, string>()
    for (let i = 0; i < sanitized.length; i++) {
      if (!idByInputIndex[i]) {
        generated.set(i, crypto.randomUUID())
        idByInputIndex[i] = generated.get(i)
      }
    }

    for (let i = 0; i < deduped.length; i += WRITE_CHUNK_SIZE) {
      const chunk = deduped.slice(i, i + WRITE_CHUNK_SIZE)
      await this.withClient(async (client) => {
        for (const { input, inputIndex } of chunk) {
          const requestedId = idByInputIndex[inputIndex]!
          const result = await client.query(
            `INSERT INTO ${this.schemaName}.graph_nodes (id, knowledge_base_id, name, type, properties, frequency, embedding, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector, NOW(), NOW())
             ON CONFLICT (knowledge_base_id, name) DO UPDATE SET
               type = EXCLUDED.type,
                properties = ${mergeNodePropertiesSql(this.schemaName)},
               frequency = ${this.schemaName}.graph_nodes.frequency + 1,
               embedding = COALESCE(EXCLUDED.embedding, ${this.schemaName}.graph_nodes.embedding),
               updated_at = NOW()
             RETURNING id`,
            [
              requestedId, input.knowledgeBaseId, input.name, input.type,
              JSON.stringify(input.properties), input.frequency || 1,
              input.embedding ? JSON.stringify(input.embedding) : null,
            ]
          )
          // upsert 冲突时以 RETURNING 的实际行 id 为准；同显式 id 的重复输入共享该 id
          const actualId = result.rows[0]?.id || requestedId
          for (let j = 0; j < idByInputIndex.length; j++) {
            if (idByInputIndex[j] === requestedId) {
              idByInputIndex[j] = actualId
            }
          }
        }
      })
    }

    return idByInputIndex as string[]
  }

  async getNode(id: string): Promise<GraphNode | null> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM ${this.schemaName}.graph_nodes WHERE id = $1`,
        [id]
      )
      return result.rows.length > 0 ? this.mapNode(result.rows[0]) : null
    })
  }

  async getNodes(ids: string[]): Promise<GraphNode[]> {
    if (ids.length === 0) return []
    return this.withClient(async (client) => {
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')
      const result = await client.query(
        `SELECT * FROM ${this.schemaName}.graph_nodes WHERE id IN (${placeholders})`,
        ids
      )
      return result.rows.map(this.mapNode)
    })
  }

  async deleteNode(id: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(`DELETE FROM ${this.schemaName}.graph_nodes WHERE id = $1`, [id])
    })
  }

  async deleteNodes(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.withClient(async (client) => {
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')
      await client.query(
        `DELETE FROM ${this.schemaName}.graph_nodes WHERE id IN (${placeholders})`,
        ids
      )
    })
  }

  /**
   * 批量回减节点频次（detach 语义）：删除某个来源文档时，仍被其它文档引用的
   * 共享节点 frequency - 1，保底下限 1（不归零、不为负）。
   */
  async decrementNodeFrequencies(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return
    await this.withClient(async (client) => {
      await client.query(
        `UPDATE ${this.schemaName}.graph_nodes
         SET frequency = GREATEST(1, frequency - 1), updated_at = NOW()
         WHERE id = ANY($1)`,
        [nodeIds]
      )
    })
  }

  async updateNode(id: string, data: UpdateNodeInput): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []
    let idx = 1

    if (data.name !== undefined) { sets.push(`name = $${idx++}`); params.push(data.name) }
    if (data.type !== undefined) { sets.push(`type = $${idx++}`); params.push(data.type) }
    if (data.properties !== undefined) {
      // jsonb 合并语义（与 addNode/addEdge 的 upsert 一致）：
      // 只更新传入的键，保留节点既有属性
      sets.push(`properties = ${this.schemaName}.graph_nodes.properties || $${idx++}::jsonb`)
      params.push(JSON.stringify(data.properties))
    }
    if (data.frequency !== undefined) { sets.push(`frequency = $${idx++}`); params.push(data.frequency) }
    if (data.embedding !== undefined) {
      sets.push(`embedding = $${idx++}::vector`)
      params.push(data.embedding ? JSON.stringify(data.embedding) : null)
    }

    if (sets.length === 0) return

    sets.push(`updated_at = NOW()`)
    params.push(id)

    await this.withClient(async (client) => {
      await client.query(
        `UPDATE ${this.schemaName}.graph_nodes SET ${sets.join(', ')} WHERE id = $${idx}`,
        params
      )
    })
  }

  async findNodeByName(name: string, knowledgeBaseId?: string): Promise<GraphNode | null> {
    return this.withClient(async (client) => {
      let query: string
      let params: unknown[]
      if (knowledgeBaseId) {
        query = `SELECT * FROM ${this.schemaName}.graph_nodes WHERE name = $1 AND knowledge_base_id = $2`
        params = [name, knowledgeBaseId]
      } else {
        query = `SELECT * FROM ${this.schemaName}.graph_nodes WHERE name = $1`
        params = [name]
      }
      const result = await client.query(query, params)
      return result.rows.length > 0 ? this.mapNode(result.rows[0]) : null
    })
  }

  async findNodesByType(type: string, knowledgeBaseId?: string): Promise<GraphNode[]> {
    return this.withClient(async (client) => {
      let query: string
      let params: unknown[]
      if (knowledgeBaseId) {
        query = `SELECT * FROM ${this.schemaName}.graph_nodes WHERE type = $1 AND knowledge_base_id = $2`
        params = [type, knowledgeBaseId]
      } else {
        query = `SELECT * FROM ${this.schemaName}.graph_nodes WHERE type = $1`
        params = [type]
      }
      const result = await client.query(query, params)
      return result.rows.map(this.mapNode)
    })
  }

  async addEdge(input: CreateEdgeInput): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `INSERT INTO ${this.schemaName}.graph_edges (source_id, target_id, relationship_name, properties, weight, knowledge_base_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT (source_id, target_id, relationship_name) DO UPDATE SET
           properties = ${mergeEdgePropertiesSql(this.schemaName)},
           weight = EXCLUDED.weight,
           updated_at = NOW()`,
        [input.sourceId, input.targetId, input.relationshipName, JSON.stringify(input.properties || {}), input.weight || 1.0, input.knowledgeBaseId]
      )
    })
  }

  async addEdges(inputs: CreateEdgeInput[]): Promise<void> {
    // 净化：身份列与属性 NUL 剥离（同三元组重复由 upsert 语义保证"最后值获胜"）
    const sanitized = inputs.map((input) => ({
      ...input,
      relationshipName: input.relationshipName.replace(/\0/g, ''),
      properties: stripNulBytesDeep(input.properties || {}),
    }))
    for (let i = 0; i < sanitized.length; i += WRITE_CHUNK_SIZE) {
      const chunk = sanitized.slice(i, i + WRITE_CHUNK_SIZE)
      await this.withClient(async (client) => {
        for (const input of chunk) {
          await client.query(
            `INSERT INTO ${this.schemaName}.graph_edges (source_id, target_id, relationship_name, properties, weight, knowledge_base_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
             ON CONFLICT (source_id, target_id, relationship_name) DO UPDATE SET
               properties = ${mergeEdgePropertiesSql(this.schemaName)},
               weight = EXCLUDED.weight,
               updated_at = NOW()`,
            [input.sourceId, input.targetId, input.relationshipName, JSON.stringify(input.properties), input.weight || 1.0, input.knowledgeBaseId]
          )
        }
      })
    }
  }

  async getEdges(nodeId: string): Promise<GraphEdge[]> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM ${this.schemaName}.graph_edges
         WHERE source_id = $1 OR target_id = $1
         ORDER BY created_at DESC`,
        [nodeId]
      )
      return result.rows.map(this.mapEdge)
    })
  }

  async hasEdge(sourceId: string, targetId: string, relationshipName: string): Promise<boolean> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT 1 FROM ${this.schemaName}.graph_edges
         WHERE source_id = $1 AND target_id = $2 AND relationship_name = $3`,
        [sourceId, targetId, relationshipName]
      )
      return result.rows.length > 0
    })
  }

  async hasEdges(
    edges: Array<Pick<CreateEdgeInput, 'sourceId' | 'targetId' | 'relationshipName'>>
  ): Promise<CreateEdgeInput[]> {
    if (edges.length === 0) return []
    return this.withClient(async (client) => {
      const missing: CreateEdgeInput[] = []
      for (const edge of edges) {
        const result = await client.query(
          `SELECT 1 FROM ${this.schemaName}.graph_edges
           WHERE source_id = $1 AND target_id = $2 AND relationship_name = $3`,
          [edge.sourceId, edge.targetId, edge.relationshipName]
        )
        if (result.rows.length === 0) {
          missing.push(edge as CreateEdgeInput)
        }
      }
      return missing
    })
  }

  async deleteEdge(sourceId: string, targetId: string, relationshipName: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `DELETE FROM ${this.schemaName}.graph_edges
         WHERE source_id = $1 AND target_id = $2 AND relationship_name = $3`,
        [sourceId, targetId, relationshipName]
      )
    })
  }

  async getGraphData(knowledgeBaseId?: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    return this.withClient(async (client) => {
      let nodeQuery: string, edgeQuery: string
      let nodeParams: unknown[], edgeParams: unknown[]

      if (knowledgeBaseId) {
        nodeQuery = `SELECT * FROM ${this.schemaName}.graph_nodes WHERE knowledge_base_id = $1`
        edgeQuery = `SELECT * FROM ${this.schemaName}.graph_edges WHERE knowledge_base_id = $1`
        nodeParams = [knowledgeBaseId]
        edgeParams = [knowledgeBaseId]
      } else {
        nodeQuery = `SELECT * FROM ${this.schemaName}.graph_nodes`
        edgeQuery = `SELECT * FROM ${this.schemaName}.graph_edges`
        nodeParams = []
        edgeParams = []
      }

      // 顺序执行（pg PoolClient 不支持并发 query，避免 DeprecationWarning 与偶发竞态）
      const nodeResult = await client.query(nodeQuery, nodeParams)
      const edgeResult = await client.query(edgeQuery, edgeParams)

      return {
        nodes: nodeResult.rows.map(this.mapNode),
        edges: edgeResult.rows.map(this.mapEdge),
      }
    })
  }

  async getFilteredGraphData(
    attributeFilters: Record<string, unknown>,
    knowledgeBaseId?: string
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    return this.withClient(async (client) => {
      const conditions: string[] = []
      const params: unknown[] = []
      let idx = 1

      for (const [key, value] of Object.entries(attributeFilters)) {
        conditions.push(`properties @> $${idx++}::jsonb`)
        params.push(JSON.stringify({ [key]: value }))
      }

      if (knowledgeBaseId) {
        conditions.push(`knowledge_base_id = $${idx++}`)
        params.push(knowledgeBaseId)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      const nodeResult = await client.query(
        `SELECT * FROM ${this.schemaName}.graph_nodes ${whereClause}`,
        params
      )
      const nodeIds = nodeResult.rows.map((r: any) => r.id)
      if (nodeIds.length === 0) return { nodes: [], edges: [] }

      const placeholders = nodeIds.map((_: any, i: number) => `$${i + 1}`).join(',')
      const edgeResult = await client.query(
        `SELECT * FROM ${this.schemaName}.graph_edges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
        nodeIds
      )

      return {
        nodes: nodeResult.rows.map(this.mapNode),
        edges: edgeResult.rows.map(this.mapEdge),
      }
    })
  }

  async getNodeCount(knowledgeBaseId?: string): Promise<number> {
    return this.withClient(async (client) => {
      const query = knowledgeBaseId
        ? `SELECT COUNT(*) FROM ${this.schemaName}.graph_nodes WHERE knowledge_base_id = $1`
        : `SELECT COUNT(*) FROM ${this.schemaName}.graph_nodes`
      const params = knowledgeBaseId ? [knowledgeBaseId] : []
      const result = await client.query(query, params)
      return parseInt(result.rows[0].count, 10)
    })
  }

  async getEdgeCount(knowledgeBaseId?: string): Promise<number> {
    return this.withClient(async (client) => {
      const query = knowledgeBaseId
        ? `SELECT COUNT(*) FROM ${this.schemaName}.graph_edges WHERE knowledge_base_id = $1`
        : `SELECT COUNT(*) FROM ${this.schemaName}.graph_edges`
      const params = knowledgeBaseId ? [knowledgeBaseId] : []
      const result = await client.query(query, params)
      return parseInt(result.rows[0].count, 10)
    })
  }

  async deleteGraph(knowledgeBaseId?: string): Promise<void> {
    await this.withClient(async (client) => {
      if (knowledgeBaseId) {
        await client.query(`DELETE FROM ${this.schemaName}.graph_edges WHERE knowledge_base_id = $1`, [knowledgeBaseId])
        await client.query(`DELETE FROM ${this.schemaName}.graph_nodes WHERE knowledge_base_id = $1`, [knowledgeBaseId])
      } else {
        await client.query(`DELETE FROM ${this.schemaName}.graph_edges`)
        await client.query(`DELETE FROM ${this.schemaName}.graph_nodes`)
        await client.query(`DELETE FROM ${this.schemaName}.graph_metadata`)
        await client.query(`DELETE FROM ${this.schemaName}.graph_document_nodes`)
        await client.query(`DELETE FROM ${this.schemaName}.document_chunks`)
        await client.query(`DELETE FROM ${this.schemaName}.document_chunk_extractions`)
      }
    })
  }

  async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    return this.withClient(async (client) => {
      const result = await client.query(sql, params)
      return result.rows
    })
  }

  // ========== 反馈权重与真值状态（存储于 JSONB properties） ==========

  async getNodeFeedbackWeights(nodeId: string): Promise<{ positive: number; negative: number } | null> {
    return this.withClient(async (client) => {
      const r = await client.query(
        `SELECT properties->'feedbackWeights' AS fw FROM ${this.schemaName}.graph_nodes WHERE id = $1`,
        [nodeId]
      )
      if (r.rows.length === 0 || !r.rows[0].fw) return null
      const fw = r.rows[0].fw
      return { positive: Number(fw.positive || 0), negative: Number(fw.negative || 0) }
    })
  }

  async setNodeFeedbackWeights(nodeId: string, weights: { positive: number; negative: number }): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `UPDATE ${this.schemaName}.graph_nodes
         SET properties = jsonb_set(properties, '{feedbackWeights}', $2::jsonb, true),
             updated_at = NOW()
         WHERE id = $1`,
        [nodeId, JSON.stringify(weights)]
      )
    })
  }

  async getEdgeFeedbackWeights(
    sourceId: string, targetId: string, relationshipName: string
  ): Promise<{ positive: number; negative: number } | null> {
    return this.withClient(async (client) => {
      const r = await client.query(
        `SELECT properties->'feedbackWeights' AS fw FROM ${this.schemaName}.graph_edges
         WHERE source_id = $1 AND target_id = $2 AND relationship_name = $3`,
        [sourceId, targetId, relationshipName]
      )
      if (r.rows.length === 0 || !r.rows[0].fw) return null
      const fw = r.rows[0].fw
      return { positive: Number(fw.positive || 0), negative: Number(fw.negative || 0) }
    })
  }

  async setEdgeFeedbackWeights(
    sourceId: string, targetId: string, relationshipName: string,
    weights: { positive: number; negative: number }
  ): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `UPDATE ${this.schemaName}.graph_edges
         SET properties = jsonb_set(properties, '{feedbackWeights}', $4::jsonb, true),
             updated_at = NOW()
         WHERE source_id = $1 AND target_id = $2 AND relationship_name = $3`,
        [sourceId, targetId, relationshipName, JSON.stringify(weights)]
      )
    })
  }

  async getNodeTruthState(nodeId: string): Promise<{ truthValue: number; lastEvaluatedAt: string | null } | null> {
    return this.withClient(async (client) => {
      const r = await client.query(
        `SELECT properties->'truthState' AS ts FROM ${this.schemaName}.graph_nodes WHERE id = $1`,
        [nodeId]
      )
      if (r.rows.length === 0 || !r.rows[0].ts) return null
      const ts = r.rows[0].ts
      return { truthValue: Number(ts.truthValue || 0), lastEvaluatedAt: ts.lastEvaluatedAt || null }
    })
  }

  async setNodeTruthState(nodeId: string, state: { truthValue: number }): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `UPDATE ${this.schemaName}.graph_nodes
         SET properties = jsonb_set(properties, '{truthState}', $2::jsonb, true),
             updated_at = NOW()
         WHERE id = $1`,
        [nodeId, JSON.stringify({ ...state, lastEvaluatedAt: new Date().toISOString() })]
      )
    })
  }

  // ========== 文档-节点关联（溯源表写入路径） ==========

  /**
   * 记录节点与文档的关联（幂等，ON CONFLICT 跳过）
   * pageIndex：节点来源的页码（对标 TrustGraph Document→Page→Chunk 链的 Page 层）
   */
  async linkNodesToDocument(input: {
    documentId: string
    nodeIds: string[]
    chunkIndex?: number
    pageIndex?: number
    pipelineRunId?: string
  }): Promise<void> {
    if (input.nodeIds.length === 0) return
    await this.withClient(async (client) => {
      for (const nodeId of input.nodeIds) {
        await client.query(
          `INSERT INTO ${this.schemaName}.graph_document_nodes (document_id, node_id, chunk_index, page_index, pipeline_run_id)
           VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING`,
          [input.documentId, nodeId, input.chunkIndex ?? null, input.pageIndex ?? null, input.pipelineRunId ?? null]
        )
      }
    })
  }

  /**
   * 节点级溯源明细：节点 → 文档 × chunk × page（审计链贯通查询的数据源）
   */
  async getProvenanceLinks(nodeIds: string[]): Promise<Array<{
    nodeId: string
    documentId: string
    chunkIndex: number | null
    pageIndex: number | null
    pipelineRunId: string | null
  }>> {
    if (nodeIds.length === 0) return []
    return this.withClient(async (client) => {
      const placeholders = nodeIds.map((_, i) => `$${i + 1}`).join(',')
      const r = await client.query(
        `SELECT node_id, document_id, chunk_index, page_index, pipeline_run_id
         FROM ${this.schemaName}.graph_document_nodes
         WHERE node_id IN (${placeholders})`,
        nodeIds
      )
      return r.rows.map((row: any) => ({
        nodeId: String(row.node_id),
        documentId: String(row.document_id),
        chunkIndex: row.chunk_index ?? null,
        pageIndex: row.page_index ?? null,
        pipelineRunId: row.pipeline_run_id ?? null,
      }))
    })
  }

  /**
   * 按文档 ID 查节点（graph_document_nodes 主路径）
   */
  async getNodeIdsByDocument(documentId: string): Promise<string[]> {
    return this.withClient(async (client) => {
      const r = await client.query(
        `SELECT node_id FROM ${this.schemaName}.graph_document_nodes WHERE document_id = $1`,
        [documentId]
      )
      return r.rows.map((row: any) => row.node_id)
    })
  }

  /**
   * 反向查询：节点被哪些文档关联（支持 detach 语义——判断节点是否还被其他文档引用）
   */
  async getDocumentsByNodeIds(nodeIds: string[]): Promise<Map<string, string[]>> {
    if (nodeIds.length === 0) return new Map()
    return this.withClient(async (client) => {
      const placeholders = nodeIds.map((_, i) => `$${i + 1}`).join(',')
      const r = await client.query(
        `SELECT node_id, document_id FROM ${this.schemaName}.graph_document_nodes
         WHERE node_id IN (${placeholders})`,
        nodeIds
      )
      const result = new Map<string, string[]>()
      for (const row of r.rows) {
        if (!result.has(row.node_id)) result.set(row.node_id, [])
        result.get(row.node_id)!.push(row.document_id)
      }
      return result
    })
  }

  /**
   * 按 pipeline run ID 查节点（回滚用）
   */
  async getNodeIdsByPipelineRun(pipelineRunId: string): Promise<string[]> {
    return this.withClient(async (client) => {
      const r = await client.query(
        `SELECT DISTINCT node_id FROM ${this.schemaName}.graph_document_nodes WHERE pipeline_run_id = $1`,
        [pipelineRunId]
      )
      return r.rows.map((row: any) => row.node_id)
    })
  }

  /**
   * 按节点属性反查节点 ID（兜底路径：properties.sourceDocumentId / pipelineRunId）
   */
  async getNodeIdsByProperty(propName: string, propValue: string, knowledgeBaseId?: string): Promise<string[]> {
    return this.withClient(async (client) => {
      const conditions = ['properties @> $1::jsonb']
      const params: unknown[] = [JSON.stringify({ [propName]: propValue })]
      if (knowledgeBaseId) {
        params.push(knowledgeBaseId)
        conditions.push('knowledge_base_id = $2')
      }
      const r = await client.query(
        `SELECT id FROM ${this.schemaName}.graph_nodes WHERE ${conditions.join(' AND ')}`,
        params
      )
      return r.rows.map((row: any) => row.id)
    })
  }

  /**
   * 删除文档关联记录
   */
  async deleteDocumentLinks(documentId: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `DELETE FROM ${this.schemaName}.graph_document_nodes WHERE document_id = $1`,
        [documentId]
      )
    })
  }

  async storeDocumentChunks(chunks: Array<{
    documentId: string
    chunkIndex: number
    content: string
    pipelineRunId?: string
  }>): Promise<void> {
    if (chunks.length === 0) return
    await this.withClient(async (client) => {
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO ${this.schemaName}.document_chunks
             (document_id, chunk_index, content, pipeline_run_id, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (document_id, chunk_index) DO UPDATE SET
             content = EXCLUDED.content,
             pipeline_run_id = EXCLUDED.pipeline_run_id,
             updated_at = NOW()`,
          [chunk.documentId, chunk.chunkIndex, chunk.content, chunk.pipelineRunId ?? null]
        )
      }
    })
  }

  async deleteDocumentChunks(documentId: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(`DELETE FROM ${this.schemaName}.document_chunks WHERE document_id = $1`, [documentId])
    })
  }

  async loadDocumentChunkExtractions(documentId: string): Promise<Array<{ chunkIndex: number; extraction: unknown; chunkHash?: string }>> {
    return this.withClient(async (client) => {
      const r = await client.query(
        `SELECT chunk_index, extraction, chunk_hash FROM ${this.schemaName}.document_chunk_extractions WHERE document_id = $1`,
        [documentId]
      )
      return r.rows.map((row: any) => ({ chunkIndex: row.chunk_index, extraction: row.extraction, chunkHash: row.chunk_hash ?? undefined }))
    })
  }

  async saveDocumentChunkExtraction(documentId: string, chunkIndex: number, extraction: unknown, chunkHash?: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `INSERT INTO ${this.schemaName}.document_chunk_extractions (document_id, chunk_index, extraction, chunk_hash, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (document_id, chunk_index) DO UPDATE SET extraction = EXCLUDED.extraction, chunk_hash = EXCLUDED.chunk_hash, updated_at = NOW()`,
        [documentId, chunkIndex, JSON.stringify(extraction), chunkHash ?? null]
      )
    })
  }

  async deleteDocumentChunkExtractions(documentId: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(`DELETE FROM ${this.schemaName}.document_chunk_extractions WHERE document_id = $1`, [documentId])
    })
  }

  async getDocumentChunks(chunkIds: string[]): Promise<Array<{
    chunkId: string
    documentId: string
    chunkIndex: number
    content: string
  }>> {
    const parsed = chunkIds.flatMap((chunkId) => {
      const split = chunkId.lastIndexOf('#')
      if (split <= 0) return []
      const chunkIndex = Number(chunkId.slice(split + 1))
      return Number.isInteger(chunkIndex)
        ? [{ chunkId, documentId: chunkId.slice(0, split), chunkIndex }]
        : []
    })
    if (parsed.length === 0) return []
    return this.withClient(async (client) => {
      const values = parsed.map((_, i) => `($${i * 2 + 1}::varchar, $${i * 2 + 2}::integer)`).join(',')
      const params = parsed.flatMap((item) => [item.documentId, item.chunkIndex])
      const r = await client.query(
        `SELECT document_id, chunk_index, content
         FROM ${this.schemaName}.document_chunks AS c
         JOIN (VALUES ${values}) AS wanted(document_id, chunk_index)
           USING (document_id, chunk_index)`,
        params
      )
      const byId = new Map(r.rows.map((row: any) => [
        `${row.document_id}#${row.chunk_index}`,
        {
          chunkId: `${row.document_id}#${row.chunk_index}`,
          documentId: row.document_id,
          chunkIndex: Number(row.chunk_index),
          content: row.content,
        },
      ]))
      return parsed.flatMap((item) => {
        const value = byId.get(item.chunkId)
        return value ? [value] : []
      })
    })
  }

  async storeRetrievalTrace(input: {
    id: string
    knowledgeBaseId?: string
    source: string
    queryText: string
    payload: unknown
    evidence?: unknown[]
  }): Promise<string> {
    await this.withClient(async (client) => {
      await client.query(
        `INSERT INTO ${this.schemaName}.graph_retrieval_traces
           (id, knowledge_base_id, source, query_text, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [input.id, input.knowledgeBaseId ?? null, input.source, input.queryText, JSON.stringify({ ...(input.payload as Record<string, unknown>), evidence: input.evidence ?? [] })],
      )
    })
    return input.id
  }

  async getRetrievalTrace(traceId: string) {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT id, knowledge_base_id, source, query_text, payload, answer
         FROM ${this.schemaName}.graph_retrieval_traces WHERE id = $1`,
        [traceId],
      )
      const row = result.rows[0]
      return row ? {
        id: String(row.id),
        knowledgeBaseId: row.knowledge_base_id ?? null,
        source: String(row.source),
        queryText: String(row.query_text),
        payload: row.payload || {},
        answer: row.answer ?? null,
      } : null
    })
  }

  async updateRetrievalTraceAnswer(traceId: string, answer: string, claims?: unknown[], metrics?: unknown): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `UPDATE ${this.schemaName}.graph_retrieval_traces
         SET answer = $2,
             payload = CASE WHEN $3::jsonb IS NULL THEN payload
               ELSE jsonb_set(jsonb_set(payload, '{claims}', $3::jsonb, true), '{evidenceMetrics}', COALESCE($4::jsonb, '{}'::jsonb), true) END,
             updated_at = NOW() WHERE id = $1`,
        [traceId, answer, claims ? JSON.stringify(claims) : null, metrics ? JSON.stringify(metrics) : null],
      )
    })
  }

  async listRetrievalTraces(knowledgeBaseId?: string, limit = 50) {
    return this.withClient(async (client) => {
      const params: unknown[] = []
      const where = knowledgeBaseId ? 'WHERE knowledge_base_id = $1' : ''
      if (knowledgeBaseId) params.push(knowledgeBaseId)
      params.push(limit)
      const result = await client.query(
        `SELECT id, knowledge_base_id, source, query_text, payload, answer, created_at
         FROM ${this.schemaName}.graph_retrieval_traces
         ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      )
      return result.rows.map((row: any) => ({
        id: String(row.id),
        knowledgeBaseId: row.knowledge_base_id ?? null,
        source: String(row.source),
        queryText: String(row.query_text),
        payload: row.payload || {},
        answer: row.answer ?? null,
        createdAt: new Date(row.created_at),
      }))
    })
  }

  /**
   * 向量 ANN 种子节点检索（SQL 侧 top-K，避免全表扫描）
   * 仅返回有 embedding 的节点，可排除结构化节点类型（chunk/document 等）
   */
  async findSimilarNodesByEmbedding(input: {
    embedding: number[]
    topK: number
    knowledgeBaseId?: string
    excludeTypes?: string[]
  }): Promise<GraphNode[]> {
    return this.withClient(async (client) => {
      const conditions: string[] = ['embedding IS NOT NULL']
      const params: unknown[] = [JSON.stringify(input.embedding)]
      let idx = 2

      if (input.knowledgeBaseId) {
        conditions.push(`knowledge_base_id = $${idx++}`)
        params.push(input.knowledgeBaseId)
      }
      if (input.excludeTypes && input.excludeTypes.length > 0) {
        conditions.push(`type <> ALL($${idx++})`)
        params.push(input.excludeTypes)
      }

      const result = await client.query(
        `SELECT *
         FROM ${this.schemaName}.graph_nodes
         WHERE ${conditions.join(' AND ')}
         ORDER BY embedding <=> $1::vector
         LIMIT ${Math.max(1, input.topK)}`,
        params
      )
      return result.rows.map((row: any) => this.mapNode(row))
    })
  }

  async getNeighbors(nodeId: string): Promise<Array<{ node: GraphNode; edge: GraphEdge; depth: number }>> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT
           n.id, n.knowledge_base_id, n.name, n.type, n.properties, n.frequency, n.embedding, n.created_at, n.updated_at,
           e.source_id, e.target_id, e.relationship_name, e.weight, e.properties as edge_properties, e.knowledge_base_id as edge_kb_id, e.created_at as edge_created_at, e.updated_at as edge_updated_at,
           CASE WHEN e.source_id = $1 THEN 'outgoing' ELSE 'incoming' END as direction
         FROM ${this.schemaName}.graph_edges e
         JOIN ${this.schemaName}.graph_nodes n ON
           (CASE WHEN e.source_id = $1 THEN e.target_id ELSE e.source_id END) = n.id
         WHERE e.source_id = $1 OR e.target_id = $1`,
        [nodeId]
      )
      return result.rows.map((row: any) => ({
        node: this.mapNode(row),
        edge: this.mapEdgeFromRow(row),
        depth: 1,
      }))
    })
  }

  async getConnections(nodeId: string): Promise<Array<{
    sourceId: string; targetId: string; relationshipName: string; edgeProperties: Record<string, unknown>; weight: number
  }>> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM ${this.schemaName}.graph_edges
         WHERE source_id = $1 OR target_id = $1
         ORDER BY weight DESC`,
        [nodeId]
      )
      return result.rows.map((row: any) => ({
        sourceId: row.source_id,
        targetId: row.target_id,
        relationshipName: row.relationship_name,
        edgeProperties: row.properties || {},
        weight: row.weight,
      }))
    })
  }

  async getGraphMetrics(knowledgeBaseId?: string): Promise<{
    nodeCount: number
    edgeCount: number
    nodeTypeDistribution: Record<string, number>
    relationshipDistribution: Record<string, number>
    connectedComponents: number
    avgDegree: number
    density: number
  }> {
    return this.withClient(async (client) => {
      const nodeWhere = knowledgeBaseId ? 'WHERE knowledge_base_id = $1' : ''
      const edgeWhere = knowledgeBaseId ? 'WHERE knowledge_base_id = $1' : ''
      const params = knowledgeBaseId ? [knowledgeBaseId] : []

      // 顺序执行（pg PoolClient 不支持并发 query，避免 DeprecationWarning 与偶发竞态）
      const nodeCount = await client.query(`SELECT COUNT(*) FROM ${this.schemaName}.graph_nodes ${nodeWhere}`, params)
      const edgeCount = await client.query(`SELECT COUNT(*) FROM ${this.schemaName}.graph_edges ${edgeWhere}`, params)
      const typeDist = await client.query(`SELECT type, COUNT(*) as cnt FROM ${this.schemaName}.graph_nodes ${nodeWhere} GROUP BY type`, params)
      const relDist = await client.query(`SELECT relationship_name, COUNT(*) as cnt FROM ${this.schemaName}.graph_edges ${edgeWhere} GROUP BY relationship_name`, params)

      const n = parseInt(nodeCount.rows[0].count, 10)
      const e = parseInt(edgeCount.rows[0].count, 10)

      const nodeTypeDistribution: Record<string, number> = {}
      for (const row of typeDist.rows) {
        nodeTypeDistribution[row.type] = parseInt(row.cnt, 10)
      }

      const relationshipDistribution: Record<string, number> = {}
      for (const row of relDist.rows) {
        relationshipDistribution[row.relationship_name] = parseInt(row.cnt, 10)
      }

      const density = n > 1 ? (2 * e) / (n * (n - 1)) : 0
      const avgDegree = n > 0 ? (2 * e) / n : 0

      // 连通分量：SQL 拉节点 id + 边端点，内存并查集计算（对标 cognee num_connected_components）
      let connectedComponents = 0
      if (n > 0) {
        const idResult = await client.query(
          `SELECT id FROM ${this.schemaName}.graph_nodes ${nodeWhere}`,
          params
        )
        const edgeEnds = await client.query(
          `SELECT source_id, target_id FROM ${this.schemaName}.graph_edges ${edgeWhere}`,
          params
        )
        connectedComponents = componentSizes(
          idResult.rows.map((r: any) => r.id),
          edgeEnds.rows.map((r: any) => ({ sourceId: r.source_id, targetId: r.target_id }))
        ).length
      }

      return {
        nodeCount: n,
        edgeCount: e,
        nodeTypeDistribution,
        relationshipDistribution,
        connectedComponents,
        avgDegree,
        density,
      }
    })
  }

  /**
   * 三元组分页批读（ORDER BY 在 OFFSET/LIMIT 之前——分页稳定性不变量，
   * 对标 cognee test_triplets_batch_pagination）
   */
  async getTripletsBatch(input: {
    limit: number
    offset?: number
    knowledgeBaseId?: string
  }): Promise<
    Array<{
      startNode: { id: string; name: string; type: string }
      relationshipName: string
      relationshipProperties: Record<string, unknown>
      endNode: { id: string; name: string; type: string }
    }>
  > {
    return this.withClient(async (client) => {
      const conditions: string[] = []
      const params: unknown[] = []
      if (input.knowledgeBaseId) {
        params.push(input.knowledgeBaseId)
        conditions.push(`e.knowledge_base_id = $${params.length}`)
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

      // 分页稳定性不变量：ORDER BY 必须先于 LIMIT/OFFLOC（SQL 语义上强制）
      params.push(Math.max(1, input.limit))
      const limitIdx = params.length
      params.push(Math.max(0, input.offset || 0))
      const offsetIdx = params.length

      const result = await client.query(
        `SELECT
           sn.id AS s_id, sn.name AS s_name, sn.type AS s_type,
           e.relationship_name, e.properties AS edge_props,
           tn.id AS t_id, tn.name AS t_name, tn.type AS t_type
         FROM ${this.schemaName}.graph_edges e
         JOIN ${this.schemaName}.graph_nodes sn ON sn.id = e.source_id
         JOIN ${this.schemaName}.graph_nodes tn ON tn.id = e.target_id
         ${where}
         ORDER BY e.source_id, e.target_id, e.relationship_name
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
      )

      return result.rows.map((row: any) => ({
        startNode: { id: row.s_id, name: row.s_name, type: row.s_type },
        relationshipName: row.relationship_name,
        relationshipProperties: row.edge_props || {},
        endNode: { id: row.t_id, name: row.t_name, type: row.t_type },
      }))
    })
  }

  private mapNode(row: any): GraphNode {
    return {
      id: row.id,
      knowledgeBaseId: row.knowledge_base_id,
      name: row.name,
      type: row.type,
      properties: row.properties || {},
      embedding: parsePgVector(row.embedding),
      frequency: row.frequency,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private mapEdge(row: any): GraphEdge {
    return {
      sourceId: row.source_id,
      targetId: row.target_id,
      relationshipName: row.relationship_name,
      properties: row.properties || {},
      weight: row.weight,
      knowledgeBaseId: row.knowledge_base_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private mapEdgeFromRow(row: any): GraphEdge {
    return {
      sourceId: row.source_id,
      targetId: row.target_id,
      relationshipName: row.relationship_name,
      properties: row.edge_properties || row.properties || {},
      weight: row.weight,
      knowledgeBaseId: row.edge_kb_id || row.knowledge_base_id,
      createdAt: row.edge_created_at || row.created_at,
      updatedAt: row.edge_updated_at || row.updated_at,
    }
  }
}
