import type { GraphNode, GraphEdge } from '../types.js'

export interface GraphElementNode {
  id: string
  attributes: Record<string, unknown>
  skeletonNeighbours: GraphElementNode[]
  skeletonEdges: GraphElementEdge[]
  status: Float64Array
  distance: number
  /** 个性化权重：undefined = 未加权（中性），0.5 = 精确 no-op（对标 cognee 语义） */
  personalWeight: number | undefined
  feedbackWeight: number
  importanceWeight: number
  frequencyWeight: number
}

export interface GraphElementEdge {
  node1: GraphElementNode
  node2: GraphElementNode
  attributes: Record<string, unknown>
  directed: boolean
  status: Float64Array
  distance: number
  edgeTypeId: string
  /** 距离空间权重：默认 0.5（对标 cognee importance_weight，距离乘 (2 - weight)） */
  importanceWeight: number
  /** 反馈权重：默认 0.5 中性（对标 cognee feedback_weight） */
  feedbackWeight: number
  /** 个性化权重：undefined = 未加权（对标 cognee personal_weight） */
  personalWeight: number | undefined
}

export function createGraphElementNode(node: GraphNode): GraphElementNode {
  return {
    id: node.id,
    attributes: {
      ...node.properties,
      name: node.name,
      type: node.type,
      knowledgeBaseId: node.knowledgeBaseId,
      frequency: node.frequency,
    },
    skeletonNeighbours: [],
    skeletonEdges: [],
    status: new Float64Array(1).fill(1),
    distance: 0,
    personalWeight: undefined,
    feedbackWeight: 0,
    importanceWeight: 0.5, // 对标 cognee 默认 0.5：距离乘 (2 - importance_weight)
    frequencyWeight: 0,
  }
}

export function createGraphElementEdge(
  edge: GraphEdge,
  node1: GraphElementNode,
  node2: GraphElementNode,
  directed: boolean = false
): GraphElementEdge {
  const edgeTypeId = `${edge.relationshipName}`
  return {
    node1,
    node2,
    attributes: {
      ...edge.properties,
      relationshipName: edge.relationshipName,
      weight: edge.weight,
    },
    directed,
    status: new Float64Array(1).fill(1),
    distance: 0,
    edgeTypeId,
    importanceWeight: 0.5,
    feedbackWeight: 0.5,
    personalWeight: undefined,
  }
}

/**
 * 更新元素距离。若 queryDistance 为非法值（NaN 或非有限数），回退到 defaultPenalty，
 * 保证"未命中向量距离的元素"在排序中垫底而非冲顶（对标 cognee triplet_distance_penalty）。
 */
export function updateDistanceForQuery(
  element: GraphElementNode | GraphElementEdge,
  queryDistance: number,
  dimensionIndex: number = 0,
  defaultPenalty: number = 6.5
): void {
  element.distance = Number.isFinite(queryDistance) ? queryDistance : defaultPenalty
  if (element.status.length > dimensionIndex) {
    element.status[dimensionIndex] = 1
  }
}

export function isAlive(element: GraphElementNode | GraphElementEdge, dimensionIndex: number = 0): boolean {
  return element.status.length > dimensionIndex && element.status[dimensionIndex] > 0
}

export function toJson(element: GraphElementNode | GraphElementEdge): Record<string, unknown> {
  if ('skeletonNeighbours' in element) {
    const node = element as GraphElementNode
    return {
      id: node.id,
      attributes: node.attributes,
      distance: node.distance,
      personalWeight: node.personalWeight,
      feedbackWeight: node.feedbackWeight,
      importanceWeight: node.importanceWeight,
      frequencyWeight: node.frequencyWeight,
    }
  }
  const edge = element as GraphElementEdge
  return {
    sourceId: edge.node1.id,
    targetId: edge.node2.id,
    attributes: edge.attributes,
    distance: edge.distance,
    directed: edge.directed,
    importanceWeight: edge.importanceWeight,
    feedbackWeight: edge.feedbackWeight,
    personalWeight: edge.personalWeight,
  }
}