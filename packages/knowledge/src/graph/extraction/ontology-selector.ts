import { cosineSimilarity } from '../retrieval/reranker.js'
import type { OntologyConfig } from '../ontology/index.js'

export interface OntologySelectorOptions {
  /** 文本嵌入函数：提供后启用语义选择；缺省时退化为全量注入 */
  embedTexts?: (texts: string[]) => Promise<number[][]>
  /** 最多保留的节点类型数，默认 8 */
  maxNodes?: number
  /** 最多保留的关系数，默认 10 */
  maxEdges?: number
  /** 余弦相似度入选阈值，默认 0.25 */
  threshold?: number
}

/**
 * 本体子集选择器（对标 TrustGraph Ontology RAG）
 *
 * TrustGraph 的洞见：不要把整个本体塞进 LLM 上下文窗口（"Here be dragons"——
 * 好的本体很大，全量注入会淹没上下文），而是用信息检索的方法
 * 按当前 chunk 选择最相关的本体子集来指导抽取。
 *
 * 工作方式：
 * - 提供 embedTexts 时：本体元素（节点类型/关系的描述文本）嵌入并缓存，
 *   对每个 chunk 嵌入后按余弦相似度选出 top 节点类型与关系（自动带出
 *   选中关系的端点类型依赖闭包），生成本体子集提示文本
 * - 未提供 embedTexts 时：降级为全量注入（与旧行为一致）
 */
export class OntologySelector {
  private ontology: OntologyConfig
  private options: OntologySelectorOptions
  /** 本体元素嵌入缓存（惰性构建，本体不变则复用） */
  private elementCache: Array<{ kind: 'node' | 'edge'; key: string; text: string; embedding: number[] }> | null = null
  private elementCachePromise: Promise<void> | null = null

  constructor(ontology: OntologyConfig, options?: OntologySelectorOptions) {
    this.ontology = ontology
    this.options = options || {}
  }

  /**
   * 为 chunk 选择相关本体子集，返回可注入提取提示的约束文本
   */
  async select(chunkText: string): Promise<string> {
    const fullText = this.toPromptText(
      this.ontology.nodes.map((n) => n.type),
      this.ontology.edges.map((e) => e.name)
    )

    const embedTexts = this.options.embedTexts
    if (!embedTexts) {
      console.warn('[本体选择] 未提供 embedTexts，退化为全量本体注入')
      return fullText
    }
    if (!chunkText || (this.ontology.nodes.length === 0 && this.ontology.edges.length === 0)) {
      return fullText
    }

    try {
      await this.ensureElementEmbeddings(embedTexts)
      const [queryVector] = await embedTexts([chunkText])
      if (!queryVector) return fullText

      const threshold = this.options.threshold ?? 0.25
      const scored = this.elementCache!
        .map((e) => ({ ...e, score: cosineSimilarity(queryVector, e.embedding) }))
        .filter((e) => e.score >= threshold)
        .sort((a, b) => b.score - a.score)

      // 边优先选择（抽取约束的核心是关系），节点补充
      const maxEdges = this.options.maxEdges ?? 10
      const maxNodes = this.options.maxNodes ?? 8

      const edgeNames: string[] = []
      const nodeTypes = new Set<string>()
      const edgeByname = new Map(this.ontology.edges.map((e) => [e.name, e]))

      for (const e of scored) {
        if (e.kind !== 'edge') continue
        if (edgeNames.length >= maxEdges) break
        if (edgeNames.includes(e.key)) continue
        edgeNames.push(e.key)
        // 端点类型依赖闭包：选中关系则其 source/target 类型一并保留
        const cfg = edgeByname.get(e.key)
        if (cfg) {
          cfg.sourceTypes.forEach((t) => nodeTypes.add(t))
          cfg.targetTypes.forEach((t) => nodeTypes.add(t))
        }
      }

      const nodePool = scored.filter((e) => e.kind === 'node').map((e) => e.key)
      for (const t of nodePool) {
        if (nodeTypes.size >= maxNodes) break
        nodeTypes.add(t)
      }

      if (edgeNames.length === 0 && nodeTypes.size === 0) {
        // 无相关本体元素：不注入约束，避免无关本体误导抽取
        return ''
      }

      return this.toPromptText([...nodeTypes], edgeNames)
    } catch (err: any) {
      console.warn(`[本体选择] 语义选择失败（退化为全量注入）: ${err.message}`)
      return fullText
    }
  }

  private async ensureElementEmbeddings(embedTexts: (texts: string[]) => Promise<number[][]>): Promise<void> {
    if (this.elementCache) return

    // ingest 会并发处理多个 chunk，避免首批 chunk 重复构建 ontology embedding。
    if (this.elementCachePromise) return this.elementCachePromise
    this.elementCachePromise = this.buildElementEmbeddings(embedTexts)
    try {
      await this.elementCachePromise
    } finally {
      this.elementCachePromise = null
    }
  }

  private async buildElementEmbeddings(embedTexts: (texts: string[]) => Promise<number[][]>): Promise<void> {

    const nodeTexts = this.ontology.nodes.map(
      (n) => `实体类型 ${n.type}${n.description ? `：${n.description}` : ''}`
    )
    const edgeTexts = this.ontology.edges.map(
      (e) => `关系 ${e.name}${e.description ? `：${e.description}` : ''}（${e.sourceTypes.join('/')} → ${e.targetTypes.join('/')}）`
    )
    const allTexts = [...nodeTexts, ...edgeTexts]
    if (allTexts.length === 0) {
      this.elementCache = []
      return
    }

    const vectors = await embedTexts(allTexts)
    this.elementCache = [
      ...this.ontology.nodes.map((n, i) => ({
        kind: 'node' as const,
        key: n.type,
        text: nodeTexts[i],
        embedding: vectors[i],
      })),
      ...this.ontology.edges.map((e, i) => ({
        kind: 'edge' as const,
        key: e.name,
        text: edgeTexts[i],
        embedding: vectors[nodeTexts.length + i],
      })),
    ]
  }

  /** 生成本体子集提示文本（格式与 OntologyValidator.toPromptText 一致） */
  private toPromptText(nodeTypes: string[], edgeNames: string[]): string {
    const typeSet = new Set(nodeTypes)
    const nodes = this.ontology.nodes
      .filter((n) => typeSet.has(n.type))
      .map((n) => `- ${n.type}${n.description ? `: ${n.description}` : ''}`)
      .join('\n')
    const nameSet = new Set(edgeNames)
    const edges = this.ontology.edges
      .filter((e) => nameSet.has(e.name))
      .map((e) => `- ${e.name}: ${e.sourceTypes.join('|')} → ${e.targetTypes.join('|')}${e.functional ? '（单值）' : ''}`)
      .join('\n')
    return `允许的实体类型：\n${nodes}\n\n允许的关系（source 类型 → target 类型）：\n${edges}`
  }
}
