import { Pool } from 'pg'
import type { GraphNode, GraphEdge, Subgraph, Path, NeighborhoodInput, ConnectionResult } from '../types.js'
import { parsePgVector } from './repository.js'

export class GraphTraversal {
  constructor(
    private pool: Pool,
    private schemaName: string
  ) {}

  private async withClient<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query(`SET search_path TO ${this.schemaName}, public`)
      return await fn(client)
    } finally {
      client.release()
    }
  }

  async getNeighborhood(input: NeighborhoodInput): Promise<Subgraph> {
    return this.withClient(async (client) => {
      const { seedIds, maxDepth, edgeTypes, knowledgeBaseId } = input

      const params: unknown[] = [seedIds, maxDepth]
      let idx = 3

      let edgeFilter = ''
      if (edgeTypes && edgeTypes.length > 0) {
        edgeFilter = ` AND e.relationship_name = ANY($${idx++})`
        params.push(edgeTypes)
      }

      let kbFilter = ''
      if (knowledgeBaseId) {
        kbFilter = ` AND n.knowledge_base_id = $${idx++}`
        params.push(knowledgeBaseId)
      }

      // vector 列不可 hash，无法参与递归 UNION 的 DISTINCT 分组；
      // 先在 CTE 中按 id 去重取普通列，再单独回查 embedding 拼接
      const result = await client.query(
        `WITH RECURSIVE neighborhood AS (
          SELECT n.id, n.knowledge_base_id, n.name, n.type, n.properties, n.frequency, n.created_at, n.updated_at, 0 AS depth
          FROM ${this.schemaName}.graph_nodes n
          WHERE n.id = ANY($1)${kbFilter}

          UNION

          SELECT n.id, n.knowledge_base_id, n.name, n.type, n.properties, n.frequency, n.created_at, n.updated_at, nh.depth + 1
          FROM neighborhood nh
          JOIN ${this.schemaName}.graph_edges e ON e.source_id = nh.id OR e.target_id = nh.id
          JOIN ${this.schemaName}.graph_nodes n ON n.id = CASE WHEN e.source_id = nh.id THEN e.target_id ELSE e.source_id END
          WHERE nh.depth < $2${edgeFilter}${kbFilter}
        )
        SELECT id, knowledge_base_id, name, type, properties, frequency, created_at, updated_at, MIN(depth) AS depth
        FROM neighborhood
        GROUP BY id, knowledge_base_id, name, type, properties, frequency, created_at, updated_at
        ORDER BY depth`,
        params
      )

      const nodeRows = result.rows as any[]
      // 回查 embedding（vector 列在去重后单独取，避免不可 hash 错误）
      if (nodeRows.length > 0) {
        const idParams = nodeRows.map((r: any) => r.id)
        const embResult = await client.query(
          `SELECT id, embedding FROM ${this.schemaName}.graph_nodes WHERE id = ANY($1)`,
          [idParams]
        )
        const embById = new Map<string, unknown>()
        for (const row of embResult.rows) embById.set(row.id, row.embedding)
        for (const row of nodeRows) row.embedding = embById.get(row.id)
      }

      const nodeIds = result.rows.map((r: any) => r.id)

      if (nodeIds.length === 0) return { nodes: [], edges: [] }

      const edgeParams: unknown[] = [nodeIds, nodeIds]
      edgeFilter = ''
      let eIdx = 3
      if (edgeTypes && edgeTypes.length > 0) {
        edgeFilter = ` AND e.relationship_name = ANY($${eIdx})`
        edgeParams.push(edgeTypes)
      }

      const edgeResult = await client.query(
        `SELECT DISTINCT e.*
         FROM ${this.schemaName}.graph_edges e
         WHERE (e.source_id = ANY($1) OR e.target_id = ANY($2))${edgeFilter}`,
        edgeParams
      )

      return {
        nodes: result.rows.map(this.mapNode),
        edges: edgeResult.rows.map(this.mapEdge),
      }
    })
  }

  async findPaths(
    sourceId: string,
    targetId: string,
    maxDepth: number = 5
  ): Promise<Path[]> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `WITH RECURSIVE path_search AS (
          SELECT
            source_id, target_id, relationship_name, weight,
            ARRAY[source_id, target_id] AS node_path,
            ARRAY[ROW(source_id, target_id, relationship_name)::text] AS edge_path,
            1 AS depth,
            weight AS total_weight
          FROM ${this.schemaName}.graph_edges
          WHERE source_id = $1

          UNION ALL

          SELECT
            e.source_id, e.target_id, e.relationship_name, e.weight,
            ps.node_path || e.target_id,
            ps.edge_path || ROW(e.source_id, e.target_id, e.relationship_name)::text,
            ps.depth + 1,
            ps.total_weight + e.weight
          FROM path_search ps
          JOIN ${this.schemaName}.graph_edges e ON e.source_id = ps.target_id
          WHERE ps.depth < $3
            AND NOT (e.target_id = ANY(ps.node_path))
        )
        SELECT DISTINCT ON (node_path) node_path, edge_path, total_weight, depth
        FROM path_search
        WHERE target_id = $2
        ORDER BY node_path, total_weight
        LIMIT 10`,
        [sourceId, targetId, maxDepth]
      )

      const paths: Path[] = []

      for (const row of result.rows) {
        const nodeIds = row.node_path as string[]
        const edgeInfos = row.edge_path as string[]

        const nodes = await this.getNodesByIds(client, nodeIds)
        const edges: GraphEdge[] = edgeInfos.map((info: string) => {
          const parts = info.replace(/[()]/g, '').split(',')
          return {
            sourceId: parts[0],
            targetId: parts[1],
            relationshipName: parts[2],
            properties: {},
            weight: 1,
            knowledgeBaseId: '',
            createdAt: new Date(),
            updatedAt: new Date(),
          } as GraphEdge
        })

        paths.push({
          nodes,
          edges,
          totalWeight: parseFloat(row.total_weight),
        })
      }

      return paths
    })
  }

  async getConnectedComponents(knowledgeBaseId?: string): Promise<Array<{ componentId: number; nodeCount: number; nodeIds: string[] }>> {
    return this.withClient(async (client) => {
      const params: unknown[] = []
      let idx = 1
      let kbFilter = ''

      if (knowledgeBaseId) {
        kbFilter = `WHERE knowledge_base_id = $${idx++}`
        params.push(knowledgeBaseId)
      }

      const result = await client.query(
        `WITH RECURSIVE components AS (
          SELECT id, id AS root_id, 0 AS depth
          FROM ${this.schemaName}.graph_nodes
          ${kbFilter}

          UNION

          SELECT n.id, c.root_id, c.depth + 1
          FROM components c
          JOIN ${this.schemaName}.graph_edges e ON e.source_id = c.id OR e.target_id = c.id
          JOIN ${this.schemaName}.graph_nodes n ON n.id = CASE WHEN e.source_id = c.id THEN e.target_id ELSE e.source_id END
          WHERE c.depth < 10000
            AND n.id <> c.id
        )
        SELECT root_id, COUNT(*) AS node_count, ARRAY_AGG(DISTINCT id) AS node_ids
        FROM (
          SELECT id, MIN(root_id) AS root_id
          FROM components
          GROUP BY id
        ) sub
        GROUP BY root_id
        ORDER BY node_count DESC`,
        params
      )

      return result.rows.map((row: any, index: number) => ({
        componentId: index + 1,
        nodeCount: parseInt(row.node_count, 10),
        nodeIds: row.node_ids,
      }))
    })
  }

  async getNodeSetSubgraph(
    nodeType: string,
    nodeName: string,
    knowledgeBaseId?: string
  ): Promise<Subgraph> {
    return this.withClient(async (client) => {
      const conditions = [`n.type = $1`, `n.name = $2`]
      const params: unknown[] = [nodeType, nodeName]
      let idx = 3

      if (knowledgeBaseId) {
        conditions.push(`n.knowledge_base_id = $${idx++}`)
        params.push(knowledgeBaseId)
      }

      const nodeResult = await client.query(
        `SELECT * FROM ${this.schemaName}.graph_nodes n WHERE ${conditions.join(' AND ')}`,
        params
      )

      const nodeIds = nodeResult.rows.map((r: any) => r.id)
      if (nodeIds.length === 0) return { nodes: [], edges: [] }

      const edgeResult = await client.query(
        `SELECT * FROM ${this.schemaName}.graph_edges WHERE source_id = ANY($1) OR target_id = ANY($1)`,
        [nodeIds]
      )

      return {
        nodes: nodeResult.rows.map(this.mapNode),
        edges: edgeResult.rows.map(this.mapEdge),
      }
    })
  }

  /**
   * 按 node set 标签拉子图（对标 cognee get_nodeset_subgraph）
   * 拉取所有 properties.belongsToSet 包含指定标签的节点及其邻边
   */
  async getSubgraphByNodeSetLabel(
    nodeSetLabel: string,
    knowledgeBaseId?: string
  ): Promise<Subgraph> {
    return this.withClient(async (client) => {
      const conditions = [`properties->'belongsToSet' ? $1`]
      const params: unknown[] = [nodeSetLabel]
      if (knowledgeBaseId) {
        params.push(knowledgeBaseId)
        conditions.push(`knowledge_base_id = $2`)
      }

      const nodeResult = await client.query(
        `SELECT * FROM ${this.schemaName}.graph_nodes WHERE ${conditions.join(' AND ')}`,
        params
      )
      const nodeIds = nodeResult.rows.map((r: any) => r.id)
      if (nodeIds.length === 0) return { nodes: [], edges: [] }

      const edgeResult = await client.query(
        `SELECT * FROM ${this.schemaName}.graph_edges WHERE source_id = ANY($1) OR target_id = ANY($1)`,
        [nodeIds]
      )

      return {
        nodes: nodeResult.rows.map(this.mapNode),
        edges: edgeResult.rows.map(this.mapEdge),
      }
    })
  }

  private async getNodesByIds(client: import('pg').PoolClient, ids: string[]): Promise<GraphNode[]> {
    if (ids.length === 0) return []
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')
    const result = await client.query(
      `SELECT * FROM ${this.schemaName}.graph_nodes WHERE id IN (${placeholders})`,
      ids
    )
    return result.rows.map(this.mapNode)
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
}