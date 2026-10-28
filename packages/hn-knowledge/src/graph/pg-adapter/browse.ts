import type { Pool, PoolClient } from 'pg'
import type { GraphEdge, GraphNode, Path, Subgraph } from '../types.js'

export class GraphBrowseNotFoundError extends Error {}
export type BrowseDirection = 'incoming' | 'outgoing' | 'both'
type Scope = { knowledgeBaseId: string }
type Page = { limit: number; offset: number }
export type RelationsInput = Scope & Page & { nodeId: string; direction: BrowseDirection; relationTypes?: string[] }
export type SubgraphInput = Scope & {
  nodeIds?: string[]; nodeTypes?: string[]; attributes?: Record<string, string | number | boolean | null>
  nodeSetLabel?: string; documentId?: string; relationTypes?: string[]
  maxNodes: number; maxEdges: number; offset: number
}
export type NeighborhoodInput = Scope & {
  seedIds: string[]; direction: BrowseDirection; relationTypes?: string[]
  maxDepth: number; maxNodes: number; maxEdges: number
}
export type PathsInput = Omit<NeighborhoodInput, 'seedIds'> & { sourceId: string; targetId: string; maxPaths: number }
export type ProvenanceInput = Scope & Page & { sourceId: string; targetId: string; relationshipName: string }

const nodeJson = (n: string) => `jsonb_build_object('id',${n}.id,'knowledgeBaseId',${n}.knowledge_base_id,
  'name',${n}.name,'type',${n}.type,'properties',COALESCE(${n}.properties,'{}'::jsonb),
  'frequency',${n}.frequency,'createdAt',${n}.created_at,'updatedAt',${n}.updated_at)`
const edgeJson = (e: string) => `jsonb_build_object('sourceId',${e}.source_id,'targetId',${e}.target_id,
  'relationshipName',${e}.relationship_name,'properties',COALESCE(${e}.properties,'{}'::jsonb),
  'weight',${e}.weight,'knowledgeBaseId',${e}.knowledge_base_id,'createdAt',${e}.created_at,'updatedAt',${e}.updated_at)`
const edgeKey = (e: GraphEdge) => JSON.stringify([e.sourceId, e.targetId, e.relationshipName])

/** 有界只读浏览：不复用未限定 KB 或会返回悬空边的旧遍历方法。 */
export class GraphBrowseRepository {
  private schema: string
  constructor(private pool: Pool, schema: string) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid graph browse schema')
    this.schema = `"${schema}"`
  }

  private async read<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query("SET LOCAL statement_timeout = '3s'")
      const result = await action(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally { client.release() }
  }

  private async nodes(client: PoolClient, ids: string[], kb: string): Promise<GraphNode[]> {
    const result = await client.query(`SELECT ${nodeJson('n')} AS node FROM ${this.schema}.graph_nodes n
      WHERE n.knowledge_base_id=$1 AND n.id=ANY($2::uuid[]) ORDER BY n.id`, [kb, ids])
    return result.rows.map(r => r.node)
  }

  private async requireNodes(client: PoolClient, ids: string[], kb: string) {
    const unique = [...new Set(ids)]
    const nodes = await this.nodes(client, unique, kb)
    if (nodes.length !== unique.length) throw new GraphBrowseNotFoundError('节点或关系不存在于指定知识库')
    return nodes
  }

  private edgeFrom() {
    return `FROM ${this.schema}.graph_edges e
      JOIN ${this.schema}.graph_nodes s ON s.id=e.source_id AND s.knowledge_base_id=$1
      JOIN ${this.schema}.graph_nodes t ON t.id=e.target_id AND t.knowledge_base_id=$1
      WHERE e.knowledge_base_id=$1`
  }

  async relations(input: RelationsInput) {
    return this.read(async client => {
      const anchor = await this.requireNodes(client, [input.nodeId], input.knowledgeBaseId)
      const direction = input.direction === 'outgoing' ? 'e.source_id=$2' : input.direction === 'incoming'
        ? 'e.target_id=$2' : '(e.source_id=$2 OR e.target_id=$2)'
      const result = await client.query(`SELECT ${edgeJson('e')} AS edge ${this.edgeFrom()}
        AND ${direction} AND ($3::text[] IS NULL OR e.relationship_name=ANY($3))
        ORDER BY e.source_id,e.target_id,e.relationship_name LIMIT $4 OFFSET $5`,
      [input.knowledgeBaseId, input.nodeId, input.relationTypes ?? null, input.limit + 1, input.offset])
      const edges: GraphEdge[] = result.rows.slice(0, input.limit).map(r => r.edge)
      const ids = [...new Set([input.nodeId, ...edges.flatMap(e => [e.sourceId, e.targetId])])]
      return { knowledgeBaseId: input.knowledgeBaseId, nodeId: anchor[0]!.id,
        nodes: await this.nodes(client, ids, input.knowledgeBaseId), edges,
        limit: input.limit, offset: input.offset, hasMore: result.rows.length > input.limit }
    })
  }

  async subgraph(input: SubgraphInput) {
    return this.read(async client => {
      const result = await client.query(`SELECT ${nodeJson('n')} AS node FROM ${this.schema}.graph_nodes n
        WHERE n.knowledge_base_id=$1
          AND ($2::uuid[] IS NULL OR n.id=ANY($2)) AND ($3::text[] IS NULL OR n.type=ANY($3))
          AND ($4::jsonb IS NULL OR n.properties @> $4)
          AND ($5::text IS NULL OR n.properties->'belongsToSet' ? $5)
          AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM ${this.schema}.graph_document_nodes d
            WHERE d.node_id=n.id AND d.document_id=$6))
        ORDER BY n.id LIMIT $7 OFFSET $8`,
      [input.knowledgeBaseId, input.nodeIds ?? null, input.nodeTypes ?? null,
        input.attributes === undefined ? null : JSON.stringify(input.attributes), input.nodeSetLabel ?? null,
        input.documentId ?? null, input.maxNodes + 1, input.offset])
      const nodes: GraphNode[] = result.rows.slice(0, input.maxNodes).map(r => r.node)
      const edges = await client.query(`SELECT ${edgeJson('e')} AS edge ${this.edgeFrom()}
        AND e.source_id=ANY($2::uuid[]) AND e.target_id=ANY($2::uuid[])
        AND ($3::text[] IS NULL OR e.relationship_name=ANY($3))
        ORDER BY e.source_id,e.target_id,e.relationship_name LIMIT $4`,
      [input.knowledgeBaseId, nodes.map(n => n.id), input.relationTypes ?? null, input.maxEdges + 1])
      return { knowledgeBaseId: input.knowledgeBaseId, nodes, edges: edges.rows.slice(0, input.maxEdges).map(r => r.edge),
        offset: input.offset, nodeHasMore: result.rows.length > input.maxNodes, edgeHasMore: edges.rows.length > input.maxEdges }
    })
  }

  private async expand(client: PoolClient, input: NeighborhoodInput): Promise<Subgraph & { truncated: boolean }> {
    const seeds = await this.requireNodes(client, input.seedIds, input.knowledgeBaseId)
    if (seeds.length > input.maxNodes) throw new Error('maxNodes must include all seeds')
    const ids = new Set(seeds.map(n => n.id))
    const edges = new Map<string, GraphEdge>()
    let frontier = [...ids]
    let truncated = false
    for (let depth = 0; depth < input.maxDepth && frontier.length; depth++) {
      const direction = input.direction === 'outgoing' ? 'e.source_id=ANY($2::uuid[])' : input.direction === 'incoming'
        ? 'e.target_id=ANY($2::uuid[])' : '(e.source_id=ANY($2::uuid[]) OR e.target_id=ANY($2::uuid[]))'
      const result = await client.query(`SELECT ${edgeJson('e')} AS edge ${this.edgeFrom()}
        AND ${direction} AND ($3::text[] IS NULL OR e.relationship_name=ANY($3))
        ORDER BY e.source_id,e.target_id,e.relationship_name LIMIT $4`,
      [input.knowledgeBaseId, frontier, input.relationTypes ?? null, input.maxEdges + 1])
      if (result.rows.length > input.maxEdges) truncated = true
      const next: string[] = []
      for (const { edge } of result.rows.slice(0, input.maxEdges) as Array<{ edge: GraphEdge }>) {
        if (edges.has(edgeKey(edge))) continue
        const added = [...new Set([edge.sourceId, edge.targetId])].filter(id => !ids.has(id))
        if (ids.size + added.length > input.maxNodes || edges.size >= input.maxEdges) { truncated = true; continue }
        edges.set(edgeKey(edge), edge)
        for (const id of added) { ids.add(id); next.push(id) }
      }
      frontier = next
    }
    return { nodes: await this.nodes(client, [...ids], input.knowledgeBaseId), edges: [...edges.values()], truncated }
  }

  async neighborhood(input: NeighborhoodInput) {
    return this.read(async client => ({ knowledgeBaseId: input.knowledgeBaseId, ...(await this.expand(client, input)) }))
  }

  async paths(input: PathsInput) {
    return this.read(async client => {
      const endpoints = await this.requireNodes(client, [input.sourceId, input.targetId], input.knowledgeBaseId)
      if (input.sourceId === input.targetId) return { knowledgeBaseId: input.knowledgeBaseId,
        paths: [{ nodes: [endpoints[0]!], edges: [], totalWeight: 0 }], truncated: false }
      const graph = await this.expand(client, { ...input, seedIds: [input.sourceId] })
      const nodes = new Map(graph.nodes.map(n => [n.id, n]))
      const neighbors = new Map<string, Array<{ next: string; edge: GraphEdge }>>()
      const add = (id: string, next: string, edge: GraphEdge) => {
        const values = neighbors.get(id) ?? []
        values.push({ next, edge }); neighbors.set(id, values)
      }
      for (const edge of graph.edges) {
        if (input.direction !== 'incoming') add(edge.sourceId, edge.targetId, edge)
        if (input.direction !== 'outgoing') add(edge.targetId, edge.sourceId, edge)
      }
      const queue: Array<{ ids: string[]; edges: GraphEdge[]; weight: number }> = [{ ids: [input.sourceId], edges: [], weight: 0 }]
      const paths: Path[] = []
      let index = 0
      let work = 0
      let truncated = graph.truncated
      while (index < queue.length && paths.length <= input.maxPaths) {
        const current = queue[index++]!
        if (current.edges.length >= input.maxDepth) continue
        for (const item of neighbors.get(current.ids.at(-1)!) ?? []) {
          if (++work > 10_000) { truncated = true; break }
          if (current.ids.includes(item.next)) continue
          const step = { ids: [...current.ids, item.next], edges: [...current.edges, item.edge], weight: current.weight + item.edge.weight }
          if (item.next === input.targetId) {
            paths.push({ nodes: step.ids.map(id => nodes.get(id)!), edges: step.edges, totalWeight: step.weight })
            if (paths.length > input.maxPaths) break
          } else if (step.edges.length < input.maxDepth) queue.push(step)
        }
        if (work > 10_000) break
      }
      if (paths.length > input.maxPaths) truncated = true
      return { knowledgeBaseId: input.knowledgeBaseId, paths: paths.slice(0, input.maxPaths), truncated }
    })
  }

  async relationTypes(input: Scope & Page) {
    return this.read(async client => {
      const result = await client.query(`SELECT e.relationship_name AS name,count(*)::int AS count ${this.edgeFrom()}
        GROUP BY e.relationship_name ORDER BY count DESC,e.relationship_name LIMIT $2 OFFSET $3`,
      [input.knowledgeBaseId, input.limit + 1, input.offset])
      return { knowledgeBaseId: input.knowledgeBaseId, items: result.rows.slice(0, input.limit),
        limit: input.limit, offset: input.offset, hasMore: result.rows.length > input.limit }
    })
  }

  async provenance(input: ProvenanceInput) {
    return this.read(async client => {
      const params = [input.knowledgeBaseId, input.sourceId, input.targetId, input.relationshipName]
      const result = await client.query(`SELECT ${edgeJson('e')} AS edge ${this.edgeFrom()}
        AND e.source_id=$2 AND e.target_id=$3 AND e.relationship_name=$4`, params)
      const edge: GraphEdge | undefined = result.rows[0]?.edge
      if (!edge) throw new GraphBrowseNotFoundError('节点或关系不存在于指定知识库')
      // document_chunks 没有 KB 字段；共享 chunk/documentId 的内容不能安全归属，宁可不返回正文。
      const chunks = await client.query(`SELECT rc.chunk_id AS "chunkId",dc.document_id AS "documentId",
        dc.chunk_index AS "chunkIndex",
        CASE WHEN EXISTS (SELECT 1 FROM ${this.schema}.relation_chunks r2
          WHERE r2.chunk_id=rc.chunk_id AND r2.knowledge_base_id<>$1)
          OR EXISTS (SELECT 1 FROM ${this.schema}.entity_chunks ec
            WHERE ec.chunk_id=rc.chunk_id AND ec.knowledge_base_id<>$1)
          OR EXISTS (SELECT 1 FROM ${this.schema}.graph_document_nodes d
            JOIN ${this.schema}.graph_nodes n ON n.id=d.node_id
            WHERE d.document_id=dc.document_id AND n.knowledge_base_id<>$1)
          THEN NULL ELSE dc.content END AS content
        FROM ${this.schema}.relation_chunks rc
        JOIN ${this.schema}.document_chunks dc ON rc.chunk_id=dc.document_id||'#'||dc.chunk_index::text
        WHERE rc.knowledge_base_id=$1 AND rc.source_id=$2 AND rc.target_id=$3 AND rc.relationship_name=$4
        ORDER BY rc.chunk_id LIMIT $5 OFFSET $6`, [...params, input.limit + 1, input.offset])
      const rows = chunks.rows.slice(0, input.limit)
      const documents = Array.isArray(edge.properties.sourceDocumentIds)
        ? edge.properties.sourceDocumentIds.filter((id): id is string => typeof id === 'string') : []
      return { knowledgeBaseId: input.knowledgeBaseId, edge,
        documents: [...new Set([...documents, ...rows.map(r => r.documentId)])],
        chunks: rows.map(r => ({ ...r, contentAvailable: r.content !== null })),
        limit: input.limit, offset: input.offset, hasMore: chunks.rows.length > input.limit }
    })
  }
}
