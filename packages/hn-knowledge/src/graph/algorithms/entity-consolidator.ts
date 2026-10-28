import type { GraphDB } from '../interface.js'
import type { GraphNode, CreateEdgeInput } from '../types.js'

export interface ConsolidateOptions {
  knowledgeBaseId: string
  /** 嵌入余弦相似度阈值，默认 0.85（对齐 cognee） */
  similarityThreshold?: number
  /** 是否只分析不合并（返回候选合并对），默认 false */
  dryRun?: boolean
  /** 合并后保留的主实体描述合并策略：保留最长描述 */
  mergeDescriptions?: boolean
}

export interface MergeCandidate {
  primaryId: string
  primaryName: string
  duplicateId: string
  duplicateName: string
  similarity: number
  reason: 'same_normalized_name' | 'embedding_similarity'
}

export interface ConsolidateResult {
  mergedCount: number
  candidates: MergeCandidate[]
  dryRun: boolean
}

/** 归一化实体名：小写、去空白、去常见标点（用于同名检测） */
export function normalizeEntityName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s\-_·•・()（）【】\[\]]+/g, '')
    .replace(/[。.，,！!？?：:；;]+$/g, '')
}

/**
 * 实体合并/去重器（对标 cognee memify_pipelines/consolidate_entities.py）
 *
 * 策略（两阶段）：
 * 1. detect：
 *    a) 同名归一匹配（同 kb 内 normalize 后同名 → 直接候选）
 *    b) 嵌入相似度匹配（cosine ≥ 0.85，同类型限定，禁跨类型合并）
 * 2. merge（dryRun=false 时）：
 *    - 重复节点的边迁移到主节点（同 key 已存在则跳过）
 *    - 描述合并（保留最长）
 *    - 频率累加
 *    - 删除重复节点
 */
export class EntityConsolidator {
  private graph: GraphDB

  constructor(graph: GraphDB) {
    this.graph = graph
  }

  async consolidate(options: ConsolidateOptions): Promise<ConsolidateResult> {
    const {
      knowledgeBaseId,
      similarityThreshold = 0.85,
      dryRun = false,
      mergeDescriptions = true,
    } = options

    const graphData = await this.graph.getGraphData(knowledgeBaseId)
    const nodes = graphData.nodes.filter(
      (n) => !['code_file', 'code_module', 'code_class', 'code_function', 'code_repository'].includes(n.type)
    )

    const candidates = this.detectCandidates(nodes, similarityThreshold)

    if (dryRun || candidates.length === 0) {
      return { mergedCount: 0, candidates, dryRun }
    }

    // 并查集：把候选对收敛为合并组
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
    for (const n of nodes) parent.set(n.id, n.id)
    for (const c of candidates) union(c.primaryId, c.duplicateId)

    // 组内选主节点：frequency 最高 > 边数最多 > 名字最短
    const groups = new Map<string, GraphNode[]>()
    for (const n of nodes) {
      const root = find(n.id)
      if (!groups.has(root)) groups.set(root, [])
      groups.get(root)!.push(n)
    }

    const nodesById = new Map(nodes.map((n) => [n.id, n]))
    let mergedCount = 0
    const primaryByGroup = new Map<string, GraphNode>()
    const canonicalId = new Map<string, string>()

    // 先固定每个合并组的主节点，避免跨组边迁移时引用已删除的旧节点。
    for (const [root, members] of groups) {
      if (members.length < 2) continue
      const edgeCounts = new Map<string, number>()
      for (const e of graphData.edges) {
        edgeCounts.set(e.sourceId, (edgeCounts.get(e.sourceId) || 0) + 1)
        edgeCounts.set(e.targetId, (edgeCounts.get(e.targetId) || 0) + 1)
      }
      const primary = [...members].sort((a, b) => {
        if (b.frequency !== a.frequency) return b.frequency - a.frequency
        const ea = edgeCounts.get(a.id) || 0, eb = edgeCounts.get(b.id) || 0
        if (eb !== ea) return eb - ea
        return a.name.length - b.name.length
      })[0]
      primaryByGroup.set(root, primary)
      for (const member of members) canonicalId.set(member.id, primary.id)
    }

    for (const [, members] of groups) {
      if (members.length < 2) continue

      const primary = primaryByGroup.get(find(members[0].id))!
      const duplicates = members.filter((m) => m.id !== primary.id)

      for (const dup of duplicates) {
        // 1. 边迁移
        const dupEdges = graphData.edges.filter(
          (e) => e.sourceId === dup.id || e.targetId === dup.id
        )
        for (const edge of dupEdges) {
          const newSource = canonicalId.get(edge.sourceId) || edge.sourceId
          const newTarget = canonicalId.get(edge.targetId) || edge.targetId
          if (newSource === newTarget) continue // 自环跳过
          const exists = await this.graph.hasEdge(newSource, newTarget, edge.relationshipName)
          if (!exists) {
            const migrated: CreateEdgeInput = {
              sourceId: newSource,
              targetId: newTarget,
              relationshipName: edge.relationshipName,
              knowledgeBaseId: edge.knowledgeBaseId,
              weight: edge.weight,
              properties: { ...edge.properties, mergedFrom: dup.name },
            }
            await this.graph.addEdge(migrated)
          }
          await this.graph.deleteEdge(edge.sourceId, edge.targetId, edge.relationshipName)
        }

        // 2. 描述合并 + 频率累加
        const props = { ...primary.properties }
        if (mergeDescriptions) {
          const descA = String(props.description || '')
          const descB = String(dup.properties?.description || '')
          props.description = descA.length >= descB.length ? descA : descB
        }
        props.mergedEntities = [
          ...new Set([
            ...(Array.isArray(props.mergedEntities) ? (props.mergedEntities as string[]) : []),
            dup.name,
          ]),
        ]
        await this.graph.updateNode(primary.id, {
          properties: props,
          frequency: primary.frequency + dup.frequency,
        })

        // 3. 删除重复节点
        await this.graph.deleteNode(dup.id)
        mergedCount++
        void nodesById
      }
    }

    return { mergedCount, candidates, dryRun: false }
  }

  private detectCandidates(nodes: GraphNode[], similarityThreshold: number): MergeCandidate[] {
    const candidates: MergeCandidate[] = []
    const seen = new Set<string>()

    // a) 同名归一匹配
    const byNormalizedName = new Map<string, GraphNode[]>()
    for (const n of nodes) {
      const key = normalizeEntityName(n.name)
      if (!key) continue
      if (!byNormalizedName.has(key)) byNormalizedName.set(key, [])
      byNormalizedName.get(key)!.push(n)
    }
    for (const [, group] of byNormalizedName) {
      if (group.length < 2) continue
      const sorted = [...group].sort((a, b) => b.frequency - a.frequency)
      const primary = sorted[0]
      for (const dup of sorted.slice(1)) {
        // 禁跨类型合并（同名但类型不同视为不同实体）
        if (dup.type !== primary.type) continue
        const key = `${primary.id}|${dup.id}`
        if (seen.has(key)) continue
        seen.add(key)
        candidates.push({
          primaryId: primary.id,
          primaryName: primary.name,
          duplicateId: dup.id,
          duplicateName: dup.name,
          similarity: 1.0,
          reason: 'same_normalized_name',
        })
      }
    }

    // b) 嵌入相似度匹配（同类型限定，top-k 截断——对标 cognee top_k=10，
    //    避免 O(N²) 全量两两比对，只与每个节点的 top-k 最近邻比对）
    const embedded = nodes.filter((n) => n.embedding)
    const TOP_K = 10
    for (let i = 0; i < embedded.length; i++) {
      const a = embedded[i]
      // 计算 a 与其余同类型节点的相似度，取 top-k
      const scored: Array<{ b: GraphNode; sim: number }> = []
      for (let j = 0; j < embedded.length; j++) {
        if (i === j) continue
        const b = embedded[j]
        if (a.type !== b.type) continue // 禁跨类型
        const key = `${a.id}|${b.id}`
        const keyRev = `${b.id}|${a.id}`
        if (seen.has(key) || seen.has(keyRev)) continue
        const sim = cosine(a.embedding!, b.embedding!)
        scored.push({ b, sim })
      }
      scored.sort((x, y) => y.sim - x.sim)
      const topK = scored.slice(0, TOP_K)
      for (const { b, sim } of topK) {
        if (sim >= similarityThreshold) {
          // 高频者为主
          const [primary, dup] = a.frequency >= b.frequency ? [a, b] : [b, a]
          const pkey = `${primary.id}|${dup.id}`
          if (seen.has(pkey)) continue
          seen.add(pkey)
          candidates.push({
            primaryId: primary.id,
            primaryName: primary.name,
            duplicateId: dup.id,
            duplicateName: dup.name,
            similarity: sim,
            reason: 'embedding_similarity',
          })
        }
      }
    }

    return candidates
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}
