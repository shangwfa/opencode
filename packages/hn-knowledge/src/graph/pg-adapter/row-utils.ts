/**
 * 图行数据准备纯函数（移植自 cognee tests/unit/.../test_postgres_adapter.py 所测的
 * _prepare_node_rows / _prepare_edge_rows / _component_sizes / _select_nodeset_neighbor_ids）
 *
 * 这些纯函数是 cognee PG 适配器批量写入路径的核心不变量：
 * 1. NUL 字节剥离（PostgreSQL 文本类型不接受 \0）
 * 2. 同 id/同三元组重复时"最后值获胜"并按 id 排序（行锁顺序规则）
 * 3. 元组 id 权威（覆盖 properties 里的冲突 id）
 * 4. 无向连通分量大小
 * 5. Nodeset 邻居 OR/AND 选择
 */

/** 递归剥离值中的 NUL 字节（含嵌套 dict/array），返回新对象（不改写调用方数据） */
export function stripNulBytesDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return (value.includes('\0') ? value.replace(/\0/g, '') : value) as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripNulBytesDeep(v)) as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripNulBytesDeep(v)
    }
    return out as T
  }
  return value
}

export interface PreparedNodeRow {
  id: string
  knowledgeBaseId: string
  name: string
  type: string
  properties: Record<string, unknown>
  frequency: number
}

export interface NodeInputLike {
  id?: string
  knowledgeBaseId: string
  name: string
  type: string
  properties?: Record<string, unknown>
  frequency?: number
}

/**
 * 节点行准备：核心列提取 + NUL 净化 + 重复 id 保留最后一条 + 按 id 排序
 */
export function prepareNodeRows(nodes: NodeInputLike[]): PreparedNodeRow[] {
  const lastById = new Map<string, NodeInputLike>()
  for (const node of nodes) {
    lastById.set(node.id || '', node)
  }
  return [...lastById.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, node]) => {
      const props = { ...(node.properties || {}) }
      // 元组 id 权威：剥离 properties 里冲突的 id
      delete props.id
      return stripNulBytesDeep({
        id: id.includes('\0') ? id.replace(/\0/g, '') : id,
        knowledgeBaseId: node.knowledgeBaseId,
        name: node.name,
        type: node.type,
        properties: props,
        frequency: node.frequency ?? 1,
      })
    })
}

export interface PreparedEdgeRow {
  sourceId: string
  targetId: string
  relationshipName: string
  properties: Record<string, unknown>
  weight: number
  knowledgeBaseId: string
}

export interface EdgeInputLike {
  sourceId: string
  targetId: string
  relationshipName: string
  properties?: Record<string, unknown> | null
  weight?: number
  knowledgeBaseId: string
}

/**
 * 边行准备：身份列净化 + 重复三元组保留最后一条 + 按身份排序 + properties 归一为 {}
 */
export function prepareEdgeRows(edges: EdgeInputLike[]): PreparedEdgeRow[] {
  const lastByTriple = new Map<string, EdgeInputLike>()
  for (const edge of edges) {
    lastByTriple.set(`${edge.sourceId}|${edge.targetId}|${edge.relationshipName}`, edge)
  }
  return [...lastByTriple.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, edge]) => {
      const props = edge.properties ? { ...edge.properties } : {}
      delete props.id
      const row: PreparedEdgeRow = stripNulBytesDeep({
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        relationshipName: edge.relationshipName,
        properties: props,
        weight: edge.weight ?? 1,
        knowledgeBaseId: edge.knowledgeBaseId,
      })
      void key
      return row
    })
}

/**
 * 无向连通分量大小（降序）
 */
export function componentSizes(nodeIds: string[], edges: Array<{ sourceId: string; targetId: string }>): number[] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const id of nodeIds) parent.set(id, id)
  for (const e of edges) {
    // 自环不改变连通性
    if (e.sourceId === e.targetId) continue
    if (parent.has(e.sourceId) && parent.has(e.targetId)) {
      union(e.sourceId, e.targetId)
    }
  }
  const sizeByRoot = new Map<string, number>()
  for (const id of nodeIds) {
    const root = find(id)
    sizeByRoot.set(root, (sizeByRoot.get(root) || 0) + 1)
  }
  return [...sizeByRoot.values()].sort((a, b) => b - a)
}

/**
 * Nodeset 邻居选择：
 * - OR：出现在任一 primaries 的邻居
 * - AND：出现在全部 primaries 的邻居
 * - 空 primaries 返回空集
 * - 非法操作符抛 Error
 */
export function selectNodesetNeighborIds(
  adjacency: Map<string, string[]>,
  primaries: string[],
  operator: 'OR' | 'AND'
): Set<string> {
  if (operator !== 'OR' && operator !== 'AND') {
    throw new Error("operator must be 'OR' or 'AND'")
  }
  if (primaries.length === 0) return new Set()

  const result = new Set<string>()
  if (operator === 'OR') {
    for (const p of primaries) {
      for (const nb of adjacency.get(p) || []) result.add(nb)
    }
  } else {
    let first = true
    for (const p of primaries) {
      const neighbors = new Set(adjacency.get(p) || [])
      if (first) {
        for (const nb of neighbors) result.add(nb)
        first = false
      } else {
        for (const nb of result) {
          if (!neighbors.has(nb)) result.delete(nb)
        }
      }
    }
  }
  return result
}