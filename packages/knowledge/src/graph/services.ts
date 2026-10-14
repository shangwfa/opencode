/**
 * Graph 域 HTTP 服务适配层：组装 adapter / ingest pipeline / 统一引擎 / 检索入口。
 *
 * 组件本身在各子模块（pipeline/unified/retrieval），此处只做单例装配与参数适配，
 * 路由层保持请求校验/响应适配职责（对齐 data-table/llm-wiki 模式）。
 */
import { getDatabaseSchema } from '../config/env.js'
import { getGraphAdapter, initGraphEngine } from './pg-adapter/index.js'
import { DocumentIngestPipeline } from './pipeline/document-pipeline.js'
import { UnifiedStoreEngine } from './unified/engine.js'
import { graphSearch } from './pipeline/search.js'
import { defaultEmbedFn } from './extraction/index.js'
import type { GraphSearchInput } from './pipeline/search.js'
import type { PgGraphAdapter } from './pg-adapter/adapter.js'

let cachedPipeline: DocumentIngestPipeline | null = null
let cachedEngine: UnifiedStoreEngine | null = null
let cachedEmbedFn: NonNullable<GraphSearchInput['embedFn']> | null = null

/** 懒初始化（首次调用建表 + 组装；后续复用单例，对齐 getGraphAdapter 语义） */
export async function getGraphHttpService(): Promise<{
  adapter: PgGraphAdapter
  pipeline: DocumentIngestPipeline
  engine: UnifiedStoreEngine
  embedFn: NonNullable<GraphSearchInput['embedFn']>
}> {
  const adapter = await initGraphEngine(getDatabaseSchema())
  if (!cachedPipeline) {
    cachedEmbedFn = await defaultEmbedFn()
    cachedPipeline = new DocumentIngestPipeline(adapter, {
      tracker: adapter.chunkTracker,
      embedFn: cachedEmbedFn,
      // HTTP 同步摄入的保守默认：批量入口不重试（调用方可显式覆盖）
      extractMaxRetries: 0,
    })
    cachedEngine = new UnifiedStoreEngine(adapter, undefined, getDatabaseSchema())
  }
  return {
    adapter,
    pipeline: cachedPipeline,
    engine: cachedEngine!,
    embedFn: cachedEmbedFn!,
  }
}

/** 图检索（HTTP 参数 → graphSearch 入口透传） */
export async function searchGraph(input: Omit<GraphSearchInput, 'embedFn'>) {
  const { adapter, embedFn } = await getGraphHttpService()
  return graphSearch(adapter, { ...input, embedFn })
}

/** 图库统计（聚合查询：规模、类型/关系分布、溯源覆盖） */
export async function getGraphStats(knowledgeBaseId: string) {
  const { adapter } = await getGraphHttpService()
  const schema = getDatabaseSchema()
  type Row = Record<string, unknown>
  const [counts, topNodeTypes, topRelations, provenance] = await Promise.all([
    adapter.query(
      `SELECT
         (SELECT count(*) FROM ${schema}.graph_nodes WHERE knowledge_base_id = $1) AS nodes,
         (SELECT count(*) FROM ${schema}.graph_edges WHERE knowledge_base_id = $1) AS edges,
         (SELECT count(DISTINCT document_id) FROM ${schema}.graph_document_nodes gdn
            JOIN ${schema}.graph_nodes n ON n.id = gdn.node_id
            WHERE n.knowledge_base_id = $1) AS linked_documents`,
      [knowledgeBaseId]
    ),
    adapter.query(
      `SELECT type, count(*) AS count FROM ${schema}.graph_nodes
       WHERE knowledge_base_id = $1 GROUP BY type ORDER BY count DESC LIMIT 10`,
      [knowledgeBaseId]
    ),
    adapter.query(
      `SELECT relationship_name AS relation, count(*) AS count FROM ${schema}.graph_edges
       WHERE knowledge_base_id = $1 GROUP BY relationship_name ORDER BY count DESC LIMIT 10`,
      [knowledgeBaseId]
    ),
    adapter.query(
      `SELECT
         (SELECT count(*) FROM ${schema}.graph_edges WHERE knowledge_base_id = $1
            AND jsonb_array_length(COALESCE(properties->'sourceDocumentIds','[]'::jsonb)) > 0) AS edges_with_source,
         (SELECT count(*) FROM ${schema}.graph_nodes WHERE knowledge_base_id = $1
            AND properties->>'description' <> '') AS nodes_with_description`,
      [knowledgeBaseId]
    ),
  ]) as unknown as [Row[], Row[], Row[], Row[]]
  return {
    knowledgeBaseId,
    nodes: Number(counts[0]?.nodes ?? 0),
    edges: Number(counts[0]?.edges ?? 0),
    linkedDocuments: Number(counts[0]?.linked_documents ?? 0),
    provenance: {
      edgesWithSource: Number(provenance[0]?.edges_with_source ?? 0),
      nodesWithDescription: Number(provenance[0]?.nodes_with_description ?? 0),
    },
    topNodeTypes: topNodeTypes.map((r) => ({
      type: String(r.type), count: Number(r.count),
    })),
    topRelations: topRelations.map((r) => ({
      relation: String(r.relation), count: Number(r.count),
    })),
  }
}
