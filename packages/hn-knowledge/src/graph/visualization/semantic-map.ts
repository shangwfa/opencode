import type { GraphDB } from '../interface.js'
import type { GraphNode } from '../types.js'
import type { VisualizationData, VisualizationNode } from './index.js'

/**
 * 语义记忆地图布局器
 *
 * 对标 cognee 的「语义内存地图」概念：将节点 embedding 通过 PCA 降维到 2D，
 * 使语义相近的节点在视觉上靠近，形成语义地图。
 *
 * 用法：
 *   const layout = new SemanticMapLayout(adapter)
 *   const viz = await layout.getVisualizationData(kb)
 *   // 或
 *   const coords = await layout.computeLayout(kb)
 */
export class SemanticMapLayout {
  private graph: GraphDB

  constructor(graph: GraphDB) {
    this.graph = graph
  }

  /**
   * 获取视觉数据（PCA 降维版）
   *
   * 与 GraphVisualizer.getVisualizationData 不同的地方：
   * - 节点带 x/y 坐标（来自 embedding 降维）
   * - 语义相近的节点视觉上靠近
   * - 无 embedding 的节点使用 force 布局坐标（随机或按 degree 排列）
   */
  async getVisualizationData(kb?: string): Promise<VisualizationData> {
    const graphData = await this.graph.getGraphData(kb)
    const metrics = await this.graph.getGraphMetrics(kb)

    // 计算语义布局坐标
    const coords = await this.computeLayout(kb)

    const nodes: VisualizationNode[] = graphData.nodes.map((node) => {
      const c = coords.get(node.id)
      return {
        id: node.id,
        label: node.name,
        type: node.type,
        group: node.type,
        size: Math.min(10 + node.frequency * 2, 50),
        properties: { ...node.properties, ...(c ? { x: c.x, y: c.y } : {}) },
      }
    })

    const edges = graphData.edges.map((edge) => ({
      source: edge.sourceId,
      target: edge.targetId,
      label: edge.relationshipName,
      weight: edge.weight,
    }))

    return {
      nodes,
      edges,
      metadata: {
        nodeCount: metrics.nodeCount,
        edgeCount: metrics.edgeCount,
        typeDistribution: metrics.nodeTypeDistribution,
      },
    }
  }

  /**
   * 计算语义布局坐标（PCA 降维到 2D）
   *
   * 返回节点 id → {x, y} 映射。无 embedding 的节点使用随机布局。
   */
  async computeLayout(
    kb?: string,
    dims: number = 2
  ): Promise<Map<string, { x: number; y: number }>> {
    const graphData = await this.graph.getGraphData(kb)
    const result = new Map<string, { x: number; y: number }>()

    // 提取有 embedding 的节点
    const embeddedNodes = graphData.nodes.filter((n) => n.embedding && n.embedding.length > 0)
    if (embeddedNodes.length === 0) {
      // 无 embedding：按 degree 分配环形布局
      const degMap = new Map<string, number>()
      for (const e of graphData.edges) {
        degMap.set(e.sourceId, (degMap.get(e.sourceId) || 0) + 1)
        degMap.set(e.targetId, (degMap.get(e.targetId) || 0) + 1)
      }
      const sorted = [...graphData.nodes].sort(
        (a, b) => (degMap.get(b.id) || 0) - (degMap.get(a.id) || 0)
      )
      const radius = Math.max(100, sorted.length * 20)
      sorted.forEach((n, i) => {
        const angle = (2 * Math.PI * i) / sorted.length
        result.set(n.id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) })
      })
      return result
    }

    // PCA 降维
    const rows = embeddedNodes.map((n) => n.embedding!)
    const j = rows[0].length
    const n = rows.length

    // 1. 中心化
    const means = new Array(j).fill(0)
    for (const row of rows) {
      for (let i = 0; i < j; i++) means[i] += row[i]
    }
    for (let i = 0; i < j; i++) means[i] /= n

    const centered = rows.map((row) => row.map((v, i) => v - means[i]))

    // 2. 计算协方差矩阵（d × d）
    const cov = Array.from({ length: j }, () => new Array(j).fill(0))
    for (const row of centered) {
      for (let a = 0; a < j; a++) {
        for (let b = a; b < j; b++) {
          cov[a][b] += row[a] * row[b]
        }
      }
    }
    for (let a = 0; a < j; a++) {
      for (let b = a; b < j; b++) {
        cov[a][b] /= n - 1
        cov[b][a] = cov[a][b]
      }
    }

    // 3. 幂迭代法求前 dims 个主成分
    const components = this.powerIteration(cov, dims, 50)

    // 4. 投影到主成分
    const projected = new Map<string, { x: number; y: number }>()
    for (const node of embeddedNodes) {
      const idx = embeddedNodes.indexOf(node)
      const row = centered[idx]
      const x = components[0] ? row.reduce((s, v, i) => s + v * components[0][i], 0) : 0
      const y = components[1] ? row.reduce((s, v, i) => s + v * components[1][i], 0) : 0
      projected.set(node.id, { x, y })
    }

    // 5. 无 embedding 节点：放置在最外围
    const noEmb = graphData.nodes.filter((n) => !n.embedding || n.embedding.length === 0)
    const maxR = Math.sqrt(
      [...projected.values()].reduce((s, c) => Math.max(s, c.x * c.x + c.y * c.y), 0)
    )
    noEmb.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, noEmb.length)
      result.set(n.id, { x: (maxR + 100) * Math.cos(angle), y: (maxR + 100) * Math.sin(angle) })
    })

    // 合并有/无 embedding 结果
    for (const [id, coord] of projected) {
      result.set(id, coord)
    }

    return result
  }

  /** 幂迭代法求前 k 个特征向量 */
  private powerIteration(
    matrix: number[][],
    k: number,
    maxIter: number
  ): number[][] {
    const d = matrix.length
    const components: number[][] = []

    for (let comp = 0; comp < k; comp++) {
      let vec = new Array(d).fill(0).map(() => Math.random() * 2 - 1)

      // 正交化于已求分量
      for (const prev of components) {
        const dot = vec.reduce((s, v, i) => s + v * prev[i], 0)
        const norm = prev.reduce((s, v) => s + v * v, 0)
        for (let i = 0; i < d; i++) vec[i] -= (dot / norm) * prev[i]
      }

      // 幂迭代
      for (let iter = 0; iter < maxIter; iter++) {
        const newVec = new Array(d).fill(0)
        for (let i = 0; i < d; i++) {
          for (let j = 0; j < d; j++) {
            newVec[i] += matrix[i][j] * vec[j]
          }
        }
        // 归一化
        const norm = Math.sqrt(newVec.reduce((s, v) => s + v * v, 0))
        if (norm < 1e-10) break
        for (let i = 0; i < d; i++) vec[i] = newVec[i] / norm
      }
      components.push([...vec])
    }

    return components
  }
}