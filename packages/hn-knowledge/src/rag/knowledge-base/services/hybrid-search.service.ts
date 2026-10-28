import { VectorService } from "./vector.service";
import { KeywordSearchService } from "./keyword-search.service";
import { RerankService } from "./rerank.service";
import { HyDEService } from "./hyde.service";
import { embed } from "ai";
import { openaiChat, openaiEmbedding } from "../../../providers/llm.js";
import type {
  SearchResultItem,
  FusionMethod,
} from "../types/knowledge-base.types";
import {
  DEFAULT_SEMANTIC_WEIGHT,
  DEFAULT_KEYWORD_WEIGHT,
  MIN_WEIGHT,
  MAX_WEIGHT,
  WEIGHT_TOLERANCE,
  SEARCH_ERROR_MESSAGES,
  DEFAULT_FUSION_METHOD,
  DEFAULT_RRF_K,
  DEFAULT_RERANK_MODEL,
} from "../../../config/search.constants";
import {
  reciprocalRankFusion,
  weightedReciprocalRankFusion,
} from "../../../utils/rrf-fusion";
import { logger } from "../../../utils/logger.js";

export interface HybridSearchOptions {
  semanticWeight?: number; // 语义检索权重，默认 0.7
  keywordWeight?: number; // 关键词检索权重，默认 0.3
  topK?: number; // 最终返回的结果数量
  pgVectorConfig?: { minScore?: number; ef?: number; probes?: number }; // pgVector 特定配置
  embeddingModel?: string; // 嵌入模型名称
  fusionMethod?: FusionMethod; // 融合方法：weighted（加权）, rrf（推荐）, weighted-rrf, hybrid
  rrfK?: number; // RRF 参数 k，默认 60
  rerankConfig?: {
    enableRerank?: boolean; // 是否启用重排序，默认 false
    rerankTopK?: number; // 重排序前召回数量，默认 20
    rerankModel?: "llm" | "mastra" | "cohere" | "zeroentropy" | "simple"; // 重排序模型，默认 'llm'（LLM 相关性打分）
  };
  hydeConfig?: {
    enableHyDE?: boolean; // 是否启用 HyDE，默认 false
    llmModel?: string; // HyDE 使用的 LLM 模型，默认 'gpt-4o-mini'
  };
  debugCollector?: (event: HybridSearchDebugEvent) => void; // 检索观测回调，用于记录召回、融合、重排阶段
  filter?: Record<string, any>; // 元数据过滤条件（MongoDB 风格，透传至语义/关键词两分支）
}

export type HybridSearchDebugStage =
  | "semantic"
  | "keyword"
  | "fused"
  | "reranked"
  | "returned";

export interface HybridSearchDebugEvent {
  stage: HybridSearchDebugStage;
  query: string;
  topK: number;
  results: SearchResultItem[];
}

type EmbeddingCacheEntry = {
  embedding: number[];
  timestamp: number;
  hitCount: number;
};

/**
 * 根据嵌入模型名称创建嵌入模型实例
 */
function createEmbeddingModel(embeddingModel: string): any {
  if (embeddingModel.startsWith("openai/")) {
    const modelName = embeddingModel.replace("openai/", "");
    return openaiEmbedding(modelName);
  } else {
    return openaiEmbedding(embeddingModel);
  }
}

/**
 * 归一化并验证权重
 *
 * @param semanticWeight 语义权重
 * @param keywordWeight 关键词权重
 * @returns 归一化后的权重
 * @throws 如果权重配置无效
 */
function normalizeAndValidateWeights(
  semanticWeight: number,
  keywordWeight: number,
): { normalizedSemantic: number; normalizedKeyword: number } {
  // 验证权重范围
  if (
    semanticWeight < MIN_WEIGHT ||
    semanticWeight > MAX_WEIGHT ||
    keywordWeight < MIN_WEIGHT ||
    keywordWeight > MAX_WEIGHT
  ) {
    throw new Error(
      SEARCH_ERROR_MESSAGES.INVALID_WEIGHTS +
        ` Weights must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}. ` +
        `Got semantic=${semanticWeight}, keyword=${keywordWeight}`,
    );
  }

  const totalWeight = semanticWeight + keywordWeight;

  // 检查权重总和是否接近 1.0（允许小的浮点误差）
  if (Math.abs(totalWeight - 1.0) > WEIGHT_TOLERANCE) {
    // 如果偏差较大，进行归一化并记录警告
    logger.warn({
      type: "hybrid_search_warning",
      message: "Hybrid search weights do not sum to 1.0. Normalizing weights.",
      semanticWeight,
      keywordWeight,
      totalWeight,
    });
  }

  // 归一化权重
  const normalizedSemantic = semanticWeight / totalWeight;
  const normalizedKeyword = keywordWeight / totalWeight;

  return { normalizedSemantic, normalizedKeyword };
}

export class HybridSearchService {
  private vectorService: VectorService;
  private keywordSearchService: KeywordSearchService;
  private rerankService: RerankService;
  private hydeService: HyDEService;

  // Embedding 缓存：同一 query 的 embedding 在多知识库搜索时复用
  private embeddingCache = new Map<string, EmbeddingCacheEntry>();
  private readonly EMBEDDING_CACHE_TTL = 5 * 60 * 1000; // 5 分钟
  private readonly EMBEDDING_CACHE_MAX_SIZE = 1000;

  constructor(
    vectorService: VectorService,
    keywordSearchService: KeywordSearchService,
  ) {
    this.vectorService = vectorService;
    this.keywordSearchService = keywordSearchService;
    this.rerankService = new RerankService();
    this.hydeService = new HyDEService();
  }

  /**
   * 获取缓存的 embedding，未命中则生成并缓存
   */
  private async getEmbeddingWithCache(
    query: string,
    embeddingModelName?: string,
  ): Promise<number[]> {
    const cacheKey = `${query}::${embeddingModelName || "default"}`;
    const now = Date.now();
    const cached = this.embeddingCache.get(cacheKey);

    if (cached && now - cached.timestamp < this.EMBEDDING_CACHE_TTL) {
      const refreshedEntry: EmbeddingCacheEntry = {
        ...cached,
        hitCount: cached.hitCount + 1,
      };
      this.embeddingCache.delete(cacheKey);
      this.embeddingCache.set(cacheKey, refreshedEntry);
      return cached.embedding;
    }

    if (cached) {
      this.embeddingCache.delete(cacheKey);
    }

    const modelName = embeddingModelName || "openai/text-embedding-3-small";
    const embeddingModel = createEmbeddingModel(modelName);
    const { embedding } = await embed({
      value: query,
      model: embeddingModel,
    });

    this.embeddingCache.set(cacheKey, {
      embedding,
      timestamp: Date.now(),
      hitCount: 0,
    });

    const cacheSizeBeforeEvict = this.embeddingCache.size;
    let evictedCount = 0;
    while (this.embeddingCache.size > this.EMBEDDING_CACHE_MAX_SIZE) {
      const oldestKey = this.embeddingCache.keys().next().value;
      if (!oldestKey) break;
      this.embeddingCache.delete(oldestKey);
      evictedCount += 1;
    }

    return embedding;
  }

  /**
   * 混合检索：结合语义检索和关键词检索
   *
   * 优化点：
   * 1. 添加权重验证和归一化
   * 2. 改进分数融合算法
   * 3. 添加低质量结果过滤
   * 4. 支持多种融合方法（weighted, rrf, weighted-rrf, hybrid）
   *
   * 融合方法说明：
   * - 'weighted': 传统加权融合（保留向后兼容）
   * - 'rrf': Reciprocal Rank Fusion（2025年推荐，默认）
   * - 'weighted-rrf': 加权 RRF（结合两者优势）
   * - 'hybrid': 混合融合（等同于 weighted-rrf）
   */
  async search(
    knowledgeBaseId: string,
    query: string,
    options: HybridSearchOptions = {},
  ): Promise<SearchResultItem[]> {
    const {
      semanticWeight = DEFAULT_SEMANTIC_WEIGHT,
      keywordWeight = DEFAULT_KEYWORD_WEIGHT,
      topK = 10,
      pgVectorConfig,
      fusionMethod = DEFAULT_FUSION_METHOD,
      rrfK = DEFAULT_RRF_K,
      rerankConfig,
      hydeConfig,
      debugCollector,
      filter,
    } = options;

    // P0 优化：如果启用重排序，需要召回更多结果
    // 重排序前需要召回 rerankTopK 条结果，重排序后返回 topK 条
    const enableRerank = rerankConfig?.enableRerank === true;
    const recallTopK = enableRerank ? rerankConfig?.rerankTopK || 20 : topK;

    // P1 优化：如果启用 HyDE，使用假设文档嵌入进行语义检索
    // HyDE 通过 LLM 生成假设答案，然后基于假设答案进行向量检索
    // 对于概念查询可以提升 15-20% 召回率
    const enableHyDE = hydeConfig?.enableHyDE === true;
    const semanticQuery = enableHyDE ? query : query; // 如果启用 HyDE，在 semanticSearch 中处理

    // 并行执行语义检索和关键词检索
    const [semanticResults, keywordResults] = await Promise.all([
      this.semanticSearch(
        knowledgeBaseId,
        semanticQuery,
        recallTopK * 2,
        pgVectorConfig,
        options.embeddingModel,
        enableHyDE,
        hydeConfig?.llmModel,
        filter,
      ),
      this.keywordSearch(knowledgeBaseId, query, recallTopK * 2, filter),
    ]);

    this.collectDebug(debugCollector, {
      stage: "semantic",
      query,
      topK: recallTopK * 2,
      results: semanticResults,
    });
    this.collectDebug(debugCollector, {
      stage: "keyword",
      query,
      topK: recallTopK * 2,
      results: keywordResults,
    });

    // 根据融合方法选择不同的融合策略
    let mergedResults: SearchResultItem[];

    // 单路失效降级：任一路为空时跳过融合，直接返回另一路结果（分数保持原生绝对语义）。
    // 背景缺陷：keyword 分支对中文口语长句常 0 命中，旧行为下 RRF 单路排名分（≈1/61）
    // 会被下游质量阈值全部误杀，导致 hybrid 长句必返回空。
    if (semanticResults.length === 0 || keywordResults.length === 0) {
      const fallbackResults =
        semanticResults.length === 0 ? keywordResults : semanticResults;
      this.collectDebug(debugCollector, {
        stage: "fused",
        query,
        topK,
        results: fallbackResults,
      });
      console.warn(
        `[HybridSearchService] ${
          semanticResults.length === 0 ? "semantic" : "keyword"
        } branch returned 0 results, falling back to the other branch (absolute scores preserved)`,
      );
      mergedResults = fallbackResults;
    } else {
    // 根据融合方法选择不同的融合策略
    switch (fusionMethod) {
      case "weighted":
        // 传统加权融合（向后兼容）
        const { normalizedSemantic, normalizedKeyword } =
          normalizeAndValidateWeights(semanticWeight, keywordWeight);
        mergedResults = this.mergeResultsWeighted(
          semanticResults,
          keywordResults,
          normalizedSemantic,
          normalizedKeyword,
        );
        break;

      case "rrf":
        // RRF 融合（2025年推荐，默认）
        mergedResults = reciprocalRankFusion(
          [semanticResults, keywordResults],
          rrfK,
        );
        break;

      case "weighted-rrf":
      case "hybrid":
        // 加权 RRF 融合
        mergedResults = weightedReciprocalRankFusion(
          [
            { results: semanticResults, weight: semanticWeight },
            { results: keywordResults, weight: keywordWeight },
          ],
          rrfK,
        );
        break;

      default:
        // 默认使用 RRF
        mergedResults = reciprocalRankFusion(
          [semanticResults, keywordResults],
          rrfK,
        );
    }

    // 融合分只用于定序；对外 score 统一恢复为两路原生绝对分，
    // 保证与下游质量阈值（MIN_RELEVANCE_SCORE）单位一致
    mergedResults = this.restoreAbsoluteScores(
      mergedResults,
      semanticResults,
      keywordResults,
    );
    }

    this.collectDebug(debugCollector, {
      stage: "fused",
      query,
      topK,
      results: mergedResults,
    });

    // P0 优化：如果启用重排序，对融合后的结果进行重排序
    if (enableRerank) {
      const rerankModel = rerankConfig?.rerankModel || DEFAULT_RERANK_MODEL;
      const rerankedResults = await this.rerankService.rerank(
        query,
        mergedResults,
        {
          model: rerankModel,
          topK,
        },
      );
      this.collectDebug(debugCollector, {
        stage: "reranked",
        query,
        topK,
        results: rerankedResults,
      });
      this.collectDebug(debugCollector, {
        stage: "returned",
        query,
        topK,
        results: rerankedResults,
      });
      return rerankedResults;
    }

    // 按最终分数排序并返回 topK
    const returnedResults = mergedResults.slice(0, topK);
    this.collectDebug(debugCollector, {
      stage: "returned",
      query,
      topK,
      results: returnedResults,
    });
    return returnedResults;
  }

  private collectDebug(
    collector: HybridSearchOptions["debugCollector"] | undefined,
    event: HybridSearchDebugEvent,
  ): void {
    if (!collector) return;
    try {
      collector(event);
    } catch (error: any) {
      logger.warn({
        type: "hybrid_search_warning",
        message: "Hybrid search debug collector failed",
        errorMessage: error?.message || String(error),
      });
    }
  }

  /**
   * 语义检索
   * P1 优化：支持 HyDE（Hypothetical Document Embeddings）
   */
  private async semanticSearch(
    knowledgeBaseId: string,
    query: string,
    topK: number,
    pgVectorConfig?: { minScore?: number; ef?: number; probes?: number },
    embeddingModelName?: string,
    enableHyDE?: boolean,
    llmModel?: string,
    filter?: Record<string, any>,
  ): Promise<SearchResultItem[]> {
    // P1 优化：如果启用 HyDE，生成假设文档并使用其嵌入进行检索
    let searchQuery = query;

    if (enableHyDE) {
      try {
        // 使用 HyDE 服务生成假设文档
        const hypotheticalDoc =
          await this.hydeService.generateHypotheticalDocument(query);
        // 使用假设文档进行检索
        searchQuery = hypotheticalDoc;
      } catch (error: any) {
        logger.warn({
          type: "hybrid_search_warning",
          message: "HyDE generation failed, falling back to original query",
          errorMessage: error?.message || String(error),
        });
        // 如果 HyDE 失败，回退到原始查询
      }
    }

    // 生成查询向量（使用缓存避免重复 embedding）
    const embedding = await this.getEmbeddingWithCache(
      searchQuery,
      embeddingModelName,
    );

    // 查询向量数据库
    const results = await this.vectorService.query(
      knowledgeBaseId,
      embedding,
      topK,
      filter,
      pgVectorConfig,
    );

    // 格式化结果，确保 metadata.text 存在，并保留所有 metadata 字段（包括媒体资源）
    return results.map((result) => {
      const text = result.metadata?.text || "";
      return {
        id: result.id,
        text,
        score: result.score || 0,
        metadata: {
          ...result.metadata, // 保留所有原始 metadata，包括 images、videos 等媒体资源
          text, // 确保 metadata.text 存在，符合 Mastra 要求
        },
        documentId: result.metadata?.documentId || "",
        chunkIndex: result.metadata?.chunkIndex,
      };
    });
  }

  /**
   * 关键词检索
   */
  /**
   * 将融合结果的 score 恢复为两路召回的原生绝对分（取两路最大值）。
   * RRF/加权融合产生的是排名分（量级 1/(k+rank)），只反映相对名次、无绝对语义，
   * 直接外泄会与质量阈值单位错配（见 search.constants MIN_RELEVANCE_SCORE 注释）。
   */
  private restoreAbsoluteScores(
    mergedResults: SearchResultItem[],
    semanticResults: SearchResultItem[],
    keywordResults: SearchResultItem[],
  ): SearchResultItem[] {
    const semanticScore = new Map(semanticResults.map((r) => [r.id, r.score]));
    const keywordScore = new Map(keywordResults.map((r) => [r.id, r.score]));
    return mergedResults.map((r) => ({
      ...r,
      score: Math.max(semanticScore.get(r.id) ?? 0, keywordScore.get(r.id) ?? 0),
    }));
  }

  private async keywordSearch(
    knowledgeBaseId: string,
    query: string,
    topK: number,
    filter?: Record<string, any>,
  ): Promise<SearchResultItem[]> {
    return await this.keywordSearchService.search(knowledgeBaseId, query, topK, filter);
  }

  /**
   * 合并语义检索和关键词检索的结果（传统加权融合）
   *
   * @deprecated 保留用于向后兼容，推荐使用 RRF 融合
   */
  private mergeResultsWeighted(
    semanticResults: SearchResultItem[],
    keywordResults: SearchResultItem[],
    semanticWeight: number,
    keywordWeight: number,
  ): SearchResultItem[] {
    // 创建结果映射（按 ID）
    const resultMap = new Map<
      string,
      SearchResultItem & { semanticScore?: number; keywordScore?: number }
    >();

    // 添加语义检索结果
    for (const result of semanticResults) {
      const existing = resultMap.get(result.id) || {
        ...result,
        semanticScore: 0,
        keywordScore: 0,
      };
      existing.semanticScore = result.score;
      resultMap.set(result.id, existing);
    }

    // 添加关键词检索结果
    for (const result of keywordResults) {
      const existing = resultMap.get(result.id) || {
        ...result,
        semanticScore: 0,
        keywordScore: 0,
      };
      existing.keywordScore = result.score;
      resultMap.set(result.id, existing);
    }

    // 归一化分数（将分数缩放到 0-1 范围）
    const allSemanticScores = Array.from(resultMap.values())
      .map((r) => r.semanticScore || 0)
      .filter((s) => s > 0);
    const allKeywordScores = Array.from(resultMap.values())
      .map((r) => r.keywordScore || 0)
      .filter((s) => s > 0);

    const maxSemanticScore =
      allSemanticScores.length > 0 ? Math.max(...allSemanticScores) : 1;
    const maxKeywordScore =
      allKeywordScores.length > 0 ? Math.max(...allKeywordScores) : 1;

    // 计算加权分数
    const mergedResults: SearchResultItem[] = [];

    for (const result of resultMap.values()) {
      const normalizedSemanticScore =
        (result.semanticScore || 0) / maxSemanticScore;
      const normalizedKeywordScore =
        (result.keywordScore || 0) / maxKeywordScore;

      const finalScore =
        normalizedSemanticScore * semanticWeight +
        normalizedKeywordScore * keywordWeight;

      mergedResults.push({
        ...result,
        score: finalScore,
      });
    }

    return mergedResults;
  }
}
