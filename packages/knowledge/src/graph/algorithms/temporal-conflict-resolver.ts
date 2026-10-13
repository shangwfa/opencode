import type { GraphDB } from '../interface.js'
import type { GraphEdge, GraphNode } from '../types.js'

export interface SupersedeResult {
  supersededEdgeCount: number
  functionalRelationsProcessed: string[]
  details: Array<{
    sourceName: string
    targetName: string
    relation: string
    supersededAt: string | null
    keptAt: string | null
  }>
}

/**
 * 单值（functional）关系列表：同一 (source, relation) 只应有一个有效值，
 * 出现多个不同 target 时按 recency 保留最新，其余标记为 superseded（非破坏性失效）。
 */
export const FUNCTIONAL_RELATIONS = [
  '版本为', '当前为', '状态为', '位于', '负责人是', '值为', '配置为', '默认为', '最新',
]

/** 语义互斥但关系名称不同的事实对。 */
export const CONFLICTING_RELATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['支持平台', '不支持'],
  ['支持', '不支持'],
  ['包含', '不包含'],
  ['启用', '禁用'],
]

export interface TaggedSupersededEdge {
  edge: GraphEdge
  reason: string
}

/**
 * 纯函数：标记被取代的 functional 关系边（对标 cognee tag_superseded_edges）
 *
 * 语义（与 cognee 对齐）：
 * 1. functionalRelations 为空 → 返回 []
 * 2. 按 (source, relation) 分组；同组 distinct target 数 > 1 才算矛盾
 *    （同 target 重申不算矛盾）
 * 3. winner 取 recency 最大者；recency 平局时后出现的赢（位置序）
 * 4. 被取代边返回副本（浅合并原属性 + superseded 标记），输入不被修改
 * 5. 多值关系（非 functional）永不折叠
 */
export function tagSupersededEdges(
  edges: GraphEdge[],
  functionalRelations: ReadonlySet<string> | string[]
): TaggedSupersededEdge[] {
  const functional =
    functionalRelations instanceof Set ? functionalRelations : new Set(functionalRelations)
  if (functional.size === 0 || edges.length === 0) return []

  // 按 (source, relation) 分组，只收 functional 关系
  const groups = new Map<string, Array<{ edge: GraphEdge; position: number }>>()
  for (let position = 0; position < edges.length; position++) {
    const edge = edges[position]
    if (!functional.has(edge.relationshipName)) continue
    const key = `${edge.sourceId}|${edge.relationshipName}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push({ edge, position })
  }

  const tagged: TaggedSupersededEdge[] = []

  for (const [, members] of groups) {
    // distinct target 数 > 1 才算矛盾（同 target 重申不算）
    const distinctTargets = new Set(members.map((m) => m.edge.targetId))
    if (distinctTargets.size <= 1) continue

    // winner：recency 最大；平局取位置靠后者
    let winner = members[0]
    for (const m of members) {
      const wKey = recencyTuple(winner)
      const mKey = recencyTuple(m)
      if (
        mKey > wKey ||
        (mKey === wKey && m.edge.weight > winner.edge.weight) ||
        (mKey === wKey && m.edge.weight === winner.edge.weight && m.position > winner.position)
      ) {
        winner = m
      }
    }

    for (const m of members) {
      if (m === winner) continue
      if (m.edge.targetId === winner.edge.targetId) continue // 与 winner 同 target 的重申保留
      tagged.push({
        edge: {
          ...m.edge,
          properties: {
            ...m.edge.properties,
            superseded: true,
            superseded_by: `${winner.edge.sourceId}|${winner.edge.relationshipName}|${winner.edge.targetId}`,
            supersession_reason: `superseded by a more recent '${m.edge.relationshipName}' assertion`,
          },
        },
        reason: 'functional_relation_conflict',
      })
    }
  }

  return tagged
}

/** 标记同一实体对上的互斥关系，保留时间更新或置信度更高的断言。 */
export function tagConflictingEdges(
  edges: GraphEdge[],
  relationPairs: ReadonlyArray<readonly [string, string]> = CONFLICTING_RELATION_PAIRS
): TaggedSupersededEdge[] {
  const groups = new Map<string, GraphEdge[]>()
  for (const edge of edges) {
    for (let pairIndex = 0; pairIndex < relationPairs.length; pairIndex++) {
      const [left, right] = relationPairs[pairIndex]
      if (edge.relationshipName !== left && edge.relationshipName !== right) continue
      const key = `${pairIndex}|${edge.sourceId}|${edge.targetId}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(edge)
    }
  }

  const tagged: TaggedSupersededEdge[] = []
  for (const members of groups.values()) {
    if (new Set(members.map((edge) => edge.relationshipName)).size < 2) continue
    const ordered = [...members].sort(compareEdgePriority)
    const winner = ordered[ordered.length - 1]
    for (const edge of members) {
      if (edge === winner) continue
      tagged.push({
        edge: {
          ...edge,
          properties: {
            ...edge.properties,
            superseded: true,
            superseded_by: `${winner.sourceId}|${winner.relationshipName}|${winner.targetId}`,
            supersession_reason: `conflicting assertion superseded by '${winner.relationshipName}'`,
          },
        },
        reason: 'conflicting_relation',
      })
    }
  }
  return tagged
}

function compareEdgePriority(a: GraphEdge, b: GraphEdge): number {
  const aDate = edgeRecency(a)
  const bDate = edgeRecency(b)
  if (aDate !== bDate) return aDate - bDate
  return a.weight - b.weight
}

function edgeRecency(edge: GraphEdge): number {
  const effectiveDate = edge.properties?.effectiveDate
  if (typeof effectiveDate === 'string') {
    const parsed = Date.parse(effectiveDate)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Math.max(
    edge.updatedAt ? new Date(edge.updatedAt).getTime() : 0,
    edge.createdAt ? new Date(edge.createdAt).getTime() : 0
  )
}

/**
 * recency 元组：(数值时间, 位置占位由调用方比较)。数值时间优先取
 * properties.effectiveDate，否则 updated_at/created_at 最大值。
 */
function recencyTuple(m: { edge: GraphEdge }): number {
  const edge = m.edge
  const effectiveDate = edge.properties?.effectiveDate
  if (typeof effectiveDate === 'string') {
    const t = Date.parse(effectiveDate)
    if (!Number.isNaN(t)) return t
  } else if (typeof effectiveDate === 'number') {
    return effectiveDate
  }
  const updated = edge.updatedAt ? new Date(edge.updatedAt).getTime() : 0
  const created = edge.createdAt ? new Date(edge.createdAt).getTime() : 0
  return Math.max(updated, created)
}

/**
 * 时间矛盾解决器（DB 版）：读取图 → 纯函数标记 → 回写
 *
 * 作用域（对标 cognee resolve_temporal_contradictions.py）：
 * - 提供 touchedNodeIds 时：只扫描触及节点的 1-hop 邻域，
 *   且仅处理"源在触及集合内"的 functional 边——避免全图扫描、不误伤无关历史
 * - 不提供时：全图扫描（向后兼容）
 */
export class TemporalConflictResolver {
  private graph: GraphDB
  private functionalRelations: string[]

  constructor(graph: GraphDB, options?: { functionalRelations?: string[] }) {
    this.graph = graph
    this.functionalRelations = options?.functionalRelations || FUNCTIONAL_RELATIONS
  }

  async resolve(
    knowledgeBaseId?: string,
    options?: { touchedNodeIds?: string[] }
  ): Promise<SupersedeResult> {
    const touchedNodeIds = options?.touchedNodeIds

    // 作用域：触及邻域（1-hop）或全图
    let graphData: { nodes: GraphNode[]; edges: GraphEdge[] }
    if (touchedNodeIds && touchedNodeIds.length > 0) {
      const subgraph = await this.graph.getNeighborhood({
        seedIds: touchedNodeIds,
        maxDepth: 1,
        knowledgeBaseId,
      })
      graphData = subgraph
    } else {
      graphData = await this.graph.getGraphData(knowledgeBaseId)
    }

    // cognee 语义：只处理"源在触及集合内"的边（本次摄入断言的历史 + 新断言）
    const candidateEdges =
      touchedNodeIds && touchedNodeIds.length > 0
        ? graphData.edges.filter((e) => touchedNodeIds.includes(e.sourceId))
        : graphData.edges

    const tagged = [
      ...tagSupersededEdges(candidateEdges, this.functionalRelations),
      ...tagConflictingEdges(candidateEdges),
    ]

    const nodesById = new Map<string, GraphNode>(
      graphData.nodes.map((n) => [n.id, n])
    )

    const result: SupersedeResult = {
      supersededEdgeCount: 0,
      functionalRelationsProcessed: [...this.functionalRelations],
      details: [],
    }

    for (const { edge } of tagged) {
      // 通过删除+重写实现属性更新（PG 适配器 addEdge 是 upsert 语义）
      await this.graph.deleteEdge(edge.sourceId, edge.targetId, edge.relationshipName)
      await this.graph.addEdge({
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        relationshipName: edge.relationshipName,
        knowledgeBaseId: edge.knowledgeBaseId,
        weight: edge.weight,
        properties: edge.properties,
      })
      result.supersededEdgeCount++
      const winner = edge.properties?.superseded_by as string | undefined
      const winnerParts = winner ? winner.split('|') : []
      const winnerKept = winnerParts.length === 3
        ? graphData.edges.find(
            (e) =>
              e.sourceId === winnerParts[0] &&
              e.relationshipName === winnerParts[1] &&
              e.targetId === winnerParts[2]
          )
        : undefined
      result.details.push({
        sourceName: nodesById.get(edge.sourceId)?.name || edge.sourceId,
        targetName: nodesById.get(edge.targetId)?.name || edge.targetId,
        relation: edge.relationshipName,
        supersededAt: edge.updatedAt?.toISOString() || null,
        keptAt: winnerKept?.updatedAt?.toISOString() || null,
      })
    }

    return result
  }
}

/**
 * 过滤掉已失效（superseded）的边，用于检索侧
 */
export function filterActiveEdges(edges: GraphEdge[]): GraphEdge[] {
  return edges.filter((e) => e.properties?.superseded !== true)
}
