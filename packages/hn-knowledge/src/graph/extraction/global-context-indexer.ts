import type { GraphDB } from '../interface.js'
import type { GraphNode } from '../types.js'
import { GraphCompletionRetriever, type GraphSearchOptions, type CompletionResult } from '../retrieval/graph-completion-retriever.js'

/**
 * 全局上下文索引器
 *
 * 对标 cognee 的「全局上下文」概念：在知识图谱中维护一个全局摘要节点，
 * 汇总所有文档的宏观信息。检索时全局上下文作为默认上下文候选，
 * 确保即使没有精确匹配也能提供有意义的信息。
 *
 * 用法：
 *   const indexer = new GlobalContextIndexer(adapter)
 *   await indexer.buildGlobalContext(kb, documentChunks)
 *   const retriever = new GlobalContextRetriever(adapter, base)
 *   const result = await retriever.search(queryEmb, options)
 */

const GLOBAL_CONTEXT_TYPE = 'global_context'

export class GlobalContextIndexer {
  private graph: GraphDB

  constructor(graph: GraphDB) {
    this.graph = graph
  }

  /**
   * 构建全局上下文摘要节点
   *
   * @param kb       知识库 ID
   * @param chunks   文档块列表（含文本和索引）
   * @param source   数据来源标识（如 pipelineRunId）
   */
  async buildGlobalContext(
    kb: string,
    chunks: Array<{ text: string; index: number }>,
    source?: string
  ): Promise<GraphNode> {
    // 汇总所有文档块文本
    const summary = chunks
      .sort((a, b) => a.index - b.index)
      .map((c) => c.text)
      .join('\n---\n')
    const truncated = summary.length > 10000 ? summary.slice(0, 10000) + '…' : summary

    // 按 knowledge_base_id + 固定名称 upsert 全局上下文节点
    const id = await this.graph.addNode({
      knowledgeBaseId: kb,
      name: '__global_context__',
      type: GLOBAL_CONTEXT_TYPE,
      properties: {
        summary: truncated,
        chunkCount: chunks.length,
        source: source ?? 'unknown',
        totalLength: summary.length,
      },
      frequency: 1,
    })

    const node = await this.graph.getNode(id)
    return node!
  }

  /**
   * 获取全局上下文节点
   */
  async getGlobalContext(kb: string): Promise<GraphNode | null> {
    return this.graph.findNodeByName('__global_context__', kb)
  }

  /**
   * 删除全局上下文
   */
  async deleteGlobalContext(kb: string): Promise<void> {
    const node = await this.getGlobalContext(kb)
    if (node) {
      await this.graph.deleteNode(node.id)
    }
  }
}

/**
 * 全局上下文检索器
 *
 * 包装任意基础检索器，在检索结果前附加全局上下文摘要文本。
 * 确保即使查询没有精确匹配，也能返回全局信息。
 */
export class GlobalContextRetriever {
  private base: GraphCompletionRetriever
  private graph: GraphDB

  constructor(graph: GraphDB, base?: GraphCompletionRetriever) {
    this.graph = graph
    this.base = base ?? new GraphCompletionRetriever(graph)
  }

  async search(
    queryEmbedding: number[],
    options: GraphSearchOptions
  ): Promise<CompletionResult> {
    const result = await this.base.search(queryEmbedding, options)

    // 附加全局上下文
    if (options.knowledgeBaseId) {
      const gc = await this.graph.findNodeByName('__global_context__', options.knowledgeBaseId)
      if (gc?.properties?.summary) {
        const summary = gc.properties.summary as string
        result.context = `[全局上下文]\n${summary}\n\n[检索结果]\n${result.context}`
      }
    }

    return result
  }
}