/**
 * 文档摄取管线（Document → Knowledge Graph）
 *
 * graph-rag 模块直接提供的端到端入口，调用方只需提供原始文档内容：
 *   原始文档（markdown / text / tiptap JSON）
 *     → [tiptap] 转换器（应用层注入，如 LLM 转换降级 prosemirror）
 *     → MDocument 分块（章节感知 2000/50，对齐 TrustGraph 图抽取大块策略）
 *     → EntityExtractor 真实 LLM 抽取（失败/为空降级到调用方注入的兜底抽取器）
 *     → GraphMergePipeline（跨 chunk 合并 + 本体硬校验 + 实体上下文嵌入 + 溯源）
 *
 * 依赖方向：本模块不依赖应用层（src/apis）；tiptap 转换器由调用方注入。
 */
import { MDocument } from '@mastra/rag'
import { createHash } from 'node:crypto'
import { getDefaultChatModel } from '../../config/env.js'
import { tiptapToMarkdown } from '../utils/tiptap-to-markdown.js'
import { EntityExtractor } from '../extraction/entity-extractor.js'
import { defaultEmbedFn } from '../extraction/index.js'
import { GraphMergePipeline } from '../extraction/merge-pipeline.js'
import type { EntityChunkTracker } from '../extraction/entity-chunk-tracker.js'
import { OntologyValidator, parseTurtleOntology } from '../ontology/index.js'
import { OntologySelector } from '../extraction/ontology-selector.js'
import type { OntologyConfig } from '../ontology/index.js'
import type { GraphDB } from '../interface.js'
import type { ChunkExtraction } from '../extraction/merge-pipeline.js'
import type { CombinedExtraction } from '../types.js'
import { writeExtractionFacts } from '../rdf/fact-writer.js'
import { inferOntologyFacts } from '../rdf/reasoner.js'
import { TemporalConflictResolver } from '../algorithms/temporal-conflict-resolver.js'
import { chunkMarkdownBySections } from '../utils/markdown-section-chunker.js'

export type DocumentIngestType = 'markdown' | 'text' | 'tiptap'
export type IngestExtractionMode = 'llm' | 'fallback'

export interface DocumentIngestOptions {
  knowledgeBaseId: string
  documentId: string
  /** 内容类型，默认 markdown */
  type?: DocumentIngestType
  /** tiptap → markdown 转换器（缺省使用内置 prosemirror 序列化；可注入 LLM 增强版） */
  tiptapConverter?: (tiptapJson: unknown) => Promise<string> | string
  /** LLM 模型名（默认取 GRAPH_EXTRACT_MODEL 环境变量，缺省走 KNOWLEDGE_DEFAULT_CHAT_MODEL，即 openai/gpt-5.6） */
  model?: string
  /** 本体约束：写入前硬校验 + 抽取提示注入 */
  ontology?: OntologyConfig
  /** OWL/Turtle 本体文本；未同时提供 ontology 时自动转换为运行时配置 */
  ontologyTurtle?: string
  /** 本次摄入绑定的 ontology 快照标识，例如 support@3 */
  ontologyVersion?: string
  /** 实体嵌入函数 */
  embedFn?: (texts: string[]) => Promise<number[][]>
  /** chunk tracker（写前日志，生产传 PgEntityChunkTracker） */
  tracker?: EntityChunkTracker
  /** 抽取兜底：LLM 不可达/抽取为空时使用（如关键词规则抽取） */
  fallbackExtractor?: (text: string) => CombinedExtraction
  /** 确定性知识增强：与 LLM/兜底抽取结果合并（结构化文档的字段/引用等固定知识，不依赖 LLM 随机性） */
  augmentExtraction?: (text: string) => CombinedExtraction
  /** 单 chunk LLM 抽取超时，默认 90s */
  extractTimeoutMs?: number
  /** 单 chunk 抽取失败后的重试次数，批量导入建议设为 0 */
  extractMaxRetries?: number
  /** chunk 级检查点：resume 时跳过已持久化抽取结果的 chunk，避免长文档中断后整篇重跑 LLM */
  chunkCheckpoint?: boolean
  /** 分块配置（默认章节感知 2000/50，对齐 TrustGraph 图抽取分块策略） */
  chunkConfig?: { maxSize?: number; overlap?: number; separators?: string[] }
  /** chunk 抽取并发数，默认 4（对标 TrustGraph syncChunks 的 batchSize 并发） */
  concurrency?: number
  /** 抽取进度回调（每 chunk 完成触发） */
  onProgress?: (done: number, total: number) => void
}

export interface DocumentIngestResult {
  /** 抽取模式：llm（真实 LLM）/ fallback（兜底抽取器） */
  mode: IngestExtractionMode
  /** tiptap 场景实际使用的转换器 */
  converter?: 'llm' | 'injected' | 'builtin'
  chunkCount: number
  docIds: string[]
  nodeCount: number
  edgeCount: number
  violations: Array<{ kind: string; detail: string }>
  /** 没有抽取出实体/关系的非空 chunk 数，用于发现“处理成功但没有知识”的文档 */
  emptyExtractionChunkCount: number
}

// 模型是配置而非代码（对齐 agent 动态配置理念）：
// 环境变量 GRAPH_EXTRACT_MODEL 可覆盖；默认使用代理已配置的 GPT-5.6（structured output，无手动输出上限）。
const DEFAULT_EXTRACT_MODEL = process.env.GRAPH_EXTRACT_MODEL ?? getDefaultChatModel()

interface IngestChunk {
  text: string
  index: number
}

/** 默认 chunk tracker：内存记录（生产可注入 PgEntityChunkTracker） */
class InMemoryEntityChunkTracker implements Partial<EntityChunkTracker> {
  private links: Array<{ entityId: string; chunkId: string; knowledgeBaseId: string }> = []
  async addEntityChunk(entityId: string, chunkId: string, knowledgeBaseId: string) {
    this.links.push({ entityId, chunkId, knowledgeBaseId })
  }
  async addRelationChunk() {}
}

export class DocumentIngestPipeline {
  private graph: GraphDB
  private defaultOptions: Partial<DocumentIngestOptions>

  constructor(graph: GraphDB, defaultOptions: Partial<DocumentIngestOptions> = {}) {
    this.graph = graph
    this.defaultOptions = defaultOptions
  }

  /**
   * 文档删除 → 图清理（ingest 的逆操作）
   *
   * 语义（detach 保守策略）：
   * - 仅被该文档引用的节点：删除（graph_edges ON DELETE CASCADE 级联删边）
   * - 跨文档共享的节点（如产品名在多篇文档出现）：保留，避免误删其他文档的知识
   * - 清理该文档的节点关联记录
   *
   * 要求图适配器支持 getNodeIdsByDocument / getDocumentsByNodeIds（PgGraphAdapter 均支持）
   */
  async removeDocument(
    documentId: string
  ): Promise<{ removedNodes: number; keptSharedNodes: number }> {
    const g = this.graph as any
    if (typeof g.getNodeIdsByDocument !== 'function' || typeof g.getDocumentsByNodeIds !== 'function') {
      throw new Error('当前图适配器不支持按文档清理（缺少溯源查询能力）')
    }

    const nodeIds = await g.getNodeIdsByDocument(documentId)
    const rdfStore = g.rdfStore as import('../rdf/quad-store.js').RdfQuadStore | undefined
    if (nodeIds.length === 0) {
      await g.deleteDocumentLinks?.(documentId)
      await g.deleteDocumentChunks?.(documentId)
      await g.deleteDocumentChunkExtractions?.(documentId)
      await g.chunkTracker?.removeEntityChunksByDocument?.(documentId)
      await g.chunkTracker?.removeRelationChunksByDocument?.(documentId)
      await rdfStore?.deleteBySourceChunkPrefix?.(`${documentId}#`)
      return { removedNodes: 0, keptSharedNodes: 0 }
    }

    // detach 语义：引用计数 = 1 的节点为本文档独占，删除（边随 CASCADE 级联删除）
    const refs = await g.getDocumentsByNodeIds(nodeIds)
    const ownNodeIds = nodeIds.filter((id: string) => (refs.get(id) || []).length <= 1)
    if (ownNodeIds.length > 0) {
      await this.graph.deleteNodes(ownNodeIds)
    }

    await g.deleteDocumentLinks?.(documentId)
    await g.deleteDocumentChunks?.(documentId)
    await g.deleteDocumentChunkExtractions?.(documentId)
    await g.chunkTracker?.removeEntityChunksByDocument?.(documentId)
    // 仅被本文档支撑的关系边：来源 chunk 已随文档删除，若无剩余来源则删除边（共享节点保留）
    const removedRelations = await g.chunkTracker?.removeRelationChunksByDocument?.(documentId)
    for (const rel of removedRelations ?? []) {
      try {
        const remaining = await g.chunkTracker?.getRelationChunks?.(rel.sourceId, rel.targetId, rel.relationName)
        if (!remaining || remaining.length === 0) {
          await (this.graph as any).deleteEdge?.(rel.sourceId, rel.targetId, rel.relationName)
        }
      } catch { /* 边清理失败不阻断删除流程 */ }
    }
    await rdfStore?.deleteBySourceChunkPrefix?.(`${documentId}#`)
    return { removedNodes: ownNodeIds.length, keptSharedNodes: nodeIds.length - ownNodeIds.length }
  }

  async ingest(
    content: string | unknown,
    options: DocumentIngestOptions
  ): Promise<DocumentIngestResult> {
    const opts = { ...this.defaultOptions, ...options }
    const type = opts.type ?? 'markdown'
    const timeoutMs = opts.extractTimeoutMs ?? 90_000
    const ontology = opts.ontology || (opts.ontologyTurtle ? parseTurtleOntology(opts.ontologyTurtle) : undefined)

    // ── 1. 内容归一化：tiptap 需要转换器（应用层注入）──
    let markdown: string
    let converter: DocumentIngestResult['converter']
    if (type === 'tiptap') {
      // 默认内置 prosemirror 转换器；应用层可注入增强版（如 LLM 转换）
      const convert = opts.tiptapConverter ?? ((json: unknown) => tiptapToMarkdown(json as never))
      const converted = await convert(content)
      if (!converted || !converted.trim()) {
        throw new Error('tiptap 转换结果为空')
      }
      markdown = converted
      converter = opts.tiptapConverter ? 'injected' : 'builtin'
    } else {
      markdown = String(content)
    }

    // ── 2. 分块：Markdown 使用章节感知分块，纯文本使用 recursive ──
    // 图抽取分块与 RAG 检索分块目标不同（chunk 仅是抽取上下文窗口，上下文完整性优先），
    // 对齐 TrustGraph ingest 部署值 chunk_size=2000 / overlap=50（大块低重叠）。
    const chunkConfig = { maxSize: 2000, overlap: 50, separators: ['\n\n', '\n', ' '], ...opts.chunkConfig }
    const doc = type === 'text' ? MDocument.fromText(markdown) : MDocument.fromMarkdown(markdown)
    const chunks = (type === 'text'
      ? await doc.chunk({
          strategy: 'recursive',
          maxSize: chunkConfig.maxSize,
          overlap: chunkConfig.overlap,
          separators: chunkConfig.separators,
        })
      : await chunkMarkdownBySections(markdown, {
          maxSize: chunkConfig.maxSize,
          overlap: chunkConfig.overlap,
        })) as Array<{ text?: string; metadata?: Record<string, unknown> }>

    const validChunks: IngestChunk[] = chunks
      .map((c, index) => ({ text: (c.text || '').trim(), index }))
      .filter((c) => c.text.length > 0)
    if (validChunks.length === 0) {
      throw new Error('分块结果为空')
    }

    // PG 图适配器保存 chunk 原文，便于检索结果回链到可读内容。
    await this.graph.storeDocumentChunks?.(validChunks.map((chunk) => ({
      documentId: opts.documentId,
      chunkIndex: chunk.index,
      content: chunk.text,
    })))

    // ── 3. 并发批量抽取：真实 LLM，失败/为空降级兜底抽取器 ──
    const extractor = new EntityExtractor({
      model: opts.model ?? DEFAULT_EXTRACT_MODEL,
      maxRetries: opts.extractMaxRetries,
    })
    const ontologyValidator = ontology ? new OntologyValidator(ontology) : null
    // 按 chunk 选择相关本体子集，避免大本体整体注入每次抽取提示。
    // 选择器与实体 embedding 复用同一个 embedFn，保持召回空间一致。
    const embedFn = opts.embedFn ?? (await defaultEmbedFn())
    const ontologySelector = ontology
      ? new OntologySelector(ontology, { embedTexts: embedFn })
      : null
    const chunkExtractions: Array<ChunkExtraction & { chunkText?: string }> = []
    let llmHits = 0
    let emptyExtractionChunkCount = 0
    // chunk 级检查点：先加载该文档已成功抽取的 chunk，resume 时跳过其 LLM 调用。
    // 缓存命中以 chunk 内容 hash 一致为前提：同 documentId 重 ingest 变更后的内容必须重新抽取。
    const checkpoint = opts.chunkCheckpoint && typeof (this.graph as any).loadDocumentChunkExtractions === 'function'
      ? (this.graph as any) as {
          loadDocumentChunkExtractions: (documentId: string) => Promise<Array<{ chunkIndex: number; extraction: unknown; chunkHash?: string }>>
          saveDocumentChunkExtraction: (documentId: string, chunkIndex: number, extraction: unknown, chunkHash?: string) => Promise<void>
          deleteDocumentChunkExtractions: (documentId: string) => Promise<void>
        }
      : null
    const cachedByIndex = new Map<number, { extraction: CombinedExtraction; chunkHash?: string }>()
    if (checkpoint) {
      const cached = await checkpoint.loadDocumentChunkExtractions(opts.documentId)
      for (const c of cached) cachedByIndex.set(c.chunkIndex, { extraction: c.extraction as CombinedExtraction, chunkHash: c.chunkHash })
    }

    const extractOne = async (chunk: IngestChunk) => {
      const chunkHash = createHash('sha256').update(chunk.text).digest('hex')
      const cachedEntry = cachedByIndex.get(chunk.index)
      const cached = cachedEntry && cachedEntry.chunkHash === chunkHash ? cachedEntry.extraction : null
      if (cached) {
        return {
          item: {
            extraction: cached,
            chunkId: `${opts.documentId}#${chunk.index}`,
            chunkIndex: chunk.index,
            documentId: opts.documentId,
            chunkText: chunk.text,
          } as ChunkExtraction & { chunkText?: string },
          byLlm: false,
        }
      }
      let extraction: CombinedExtraction | null = null
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const result = await Promise.race([
          extractor.extract(chunk.text, {
            ontologyText: ontologySelector ? await ontologySelector.select(chunk.text) : undefined,
            model: opts.model,
            signal: controller.signal,
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ])
        if (result && result.entities.length > 0) extraction = result
      } catch { /* 降级 */ }
      finally { clearTimeout(timer) }

      const byLlm = extraction !== null
      if (!byLlm && opts.fallbackExtractor) {
        extraction = opts.fallbackExtractor(chunk.text)
      }
      if (opts.augmentExtraction) {
        const extra = opts.augmentExtraction(chunk.text)
        if (extra.entities.length > 0 || extra.triplets.length > 0) {
          const base = extraction ?? { entities: [], triplets: [] }
          const entityKey = (entity: CombinedExtraction['entities'][number]) => `${entity.name}|${entity.type}`
          const tripletKey = (triplet: CombinedExtraction['triplets'][number]) => `${triplet.source}|${triplet.relation}|${triplet.target}`
          const seenEntities = new Set(base.entities.map(entityKey))
          const seenTriplets = new Set(base.triplets.map(tripletKey))
          extraction = {
            entities: [...base.entities, ...extra.entities.filter((entity) => !seenEntities.has(entityKey(entity)))],
            triplets: [...base.triplets, ...extra.triplets.filter((triplet) => !seenTriplets.has(tripletKey(triplet)))],
          }
        }
      }
      if (!extraction || (extraction.entities.length === 0 && extraction.triplets.length === 0)) {
        emptyExtractionChunkCount++
        return null
      }
      // 抽取成功即持久化检查点：即便随后 merge 中断，resume 也只补未完成 chunk 的 LLM。
      if (checkpoint) {
        try { await checkpoint.saveDocumentChunkExtraction(opts.documentId, chunk.index, extraction, chunkHash) } catch (err: any) {
          console.warn(`[检查点] chunk ${chunk.index} 抽取结果持久化失败（不影响本次流程）: ${err.message}`)
        }
      }
      return {
        item: {
          extraction,
          chunkId: `${opts.documentId}#${chunk.index}`,
          chunkIndex: chunk.index,
          documentId: opts.documentId,
          chunkText: chunk.text,
        } as ChunkExtraction & { chunkText?: string },
        byLlm,
      }
    }

    // 分批并发（对标 TrustGraph syncChunks：batchSize + Promise.allSettled）
    const concurrency = Math.max(1, opts.concurrency ?? 4)
    let done = 0
    for (let i = 0; i < validChunks.length; i += concurrency) {
      const batch = validChunks.slice(i, i + concurrency)
      const settled = await Promise.allSettled(batch.map(extractOne))
      for (const s of settled) {
        done++
        if (s.status === 'fulfilled' && s.value) {
          chunkExtractions.push(s.value.item)
          if (s.value.byLlm) llmHits++
        }
      }
      opts.onProgress?.(done, validChunks.length)
    }
    const mode: IngestExtractionMode = llmHits > 0 ? 'llm' : 'fallback'

    // ── 4. merge 管线（本体传入 → 写入前硬校验）──
    const violations: DocumentIngestResult['violations'] = []
    if (ontologyValidator) {
      for (const c of chunkExtractions) {
        const r = ontologyValidator.validate(c.extraction)
        violations.push(...r.violations)
        c.extraction = r.filtered
      }
    }

    const tracker = opts.tracker ?? (new InMemoryEntityChunkTracker() as unknown as EntityChunkTracker)
    // 终端用户零配置：未注入 embedFn 时使用内置真实嵌入（openai embedding 走代理）
    const pipeline = new GraphMergePipeline(this.graph, tracker, embedFn)
    const mergeResult = await pipeline.merge(chunkExtractions, {
      knowledgeBaseId: opts.knowledgeBaseId,
      ontology,
      ontologyVersion: opts.ontologyVersion,
    })

    const functionalRelations = (ontology?.edges || []).filter((edge) => edge.functional).map((edge) => edge.name)
    if (functionalRelations.length > 0 && mergeResult.nodeIds.length > 0) {
      await new TemporalConflictResolver(this.graph, { functionalRelations }).resolve(opts.knowledgeBaseId, {
        touchedNodeIds: mergeResult.nodeIds,
      })
    }

    const rdfStore = (this.graph as any).rdfStore
    if (rdfStore && chunkExtractions.length > 0) {
      try {
        const facts = await writeExtractionFacts(rdfStore, chunkExtractions, {
          knowledgeBaseId: opts.knowledgeBaseId,
          ontology,
          ontologyVersion: opts.ontologyVersion,
          runId: opts.ontologyVersion ? `${opts.documentId}:${opts.ontologyVersion}` : `${opts.documentId}:${Date.now()}`,
        })
        if (ontology) {
          const knowledgeGraph = facts[0]?.graph
          const inferredGraph = knowledgeGraph?.replace(/^urn:graph:knowledge:/, 'urn:graph:inferred:') || `urn:graph:inferred:${opts.knowledgeBaseId}`
          const inferred = inferOntologyFacts(facts, ontology, inferredGraph)
          if (inferred.inferred.length > 0) await rdfStore.add(inferred.inferred)
          if (inferred.conflicts.length > 0) {
            console.warn(`[OWL 推理] 检测到 ${inferred.conflicts.length} 个事实冲突`)
          }
        }
      } catch (err: any) {
        // RDF 是与属性图同级的持久化目标；失败时撤销本次文档变更，避免成功假象。
        try {
          await this.removeDocument(opts.documentId)
        } catch (rollbackError: any) {
          throw new Error(`RDF 写入失败且图数据回滚失败: ${err.message}; ${rollbackError.message}`)
        }
        throw new Error(`RDF 写入失败，已回滚本次文档摄入: ${err.message}`)
      }
    }

    // 整篇成功合入图后清除 chunk 检查点，避免陈旧数据累积影响后续变更。
    if (checkpoint) {
      try { await checkpoint.deleteDocumentChunkExtractions(opts.documentId) } catch { /* 清理失败不阻断成功路径 */ }
    }

    return {
      mode,
      converter,
      chunkCount: validChunks.length,
      docIds: [opts.documentId],
      nodeCount: mergeResult.nodeIds.length,
      edgeCount: mergeResult.edgeCount,
      violations,
      emptyExtractionChunkCount,
    }
  }
}
