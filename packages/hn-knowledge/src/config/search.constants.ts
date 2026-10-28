/**
 * 搜索相关常量配置
 */

// ============ 融合方法配置 ============

/**
 * 支持的融合方法类型
 */
export type FusionMethod = "weighted" | "rrf" | "weighted-rrf" | "hybrid";

/**
 * 默认融合方法（2025年推荐使用 RRF）
 */
export const DEFAULT_FUSION_METHOD: FusionMethod = "rrf";

/**
 * RRF 参数 k 的默认值
 * 来自原始论文，通常不需要调整
 */
export const DEFAULT_RRF_K = 60;

// ============ 召回配置 ============

/**
 * 召回倍数：实际召回数量 = topK * RECALL_MULTIPLIER
 * 为重排序留出空间
 */
export const RECALL_MULTIPLIER = 2;

/**
 * 粗召回默认数量
 */
export const DEFAULT_COARSE_TOP_K = 50;

/**
 * 细召回默认数量
 */
export const DEFAULT_FINE_TOP_K = 20;

/**
 * 最小召回数量
 */
export const MIN_RECALL_TOP_K = 10;

/**
 * 最大召回数量
 */
export const MAX_RECALL_TOP_K = 200;

// ============ 分数阈值配置 ============

/**
 * 最低召回分数阈值（低于此分数的结果会被过滤）
 */
export const MIN_RECALL_SCORE = 0.15;

/**
 * 统一质量分数阈值（绝对语义：相似度分 / LLM 相关性分共用）。
 *
 * 背景缺陷（2026-10 实测定位）：RRF 融合分是排名分（量级 1/(k+rank)≈0.016~0.033），
 * 与为相似度分（0~1）设计的阈值比较属于单位错配，导致 keyword 分支无命中的
 * 中文长句 hybrid 检索必返回空。修复原则：排名分只定序不外泄；质量阈值只对
 * 有绝对语义的分数（召回相似度分 / LLM 相关性分）生效，三种 searchType 共用本阈值。
 * 取 0.2 与旧 MIN_SEMANTIC_SCORE 对齐（实测 cosine 0.2x 的正确答案块不应被误杀）。
 */
export const MIN_RELEVANCE_SCORE = 0.2;

/**
 * 默认重排序打分器：LLM 相关性打分（绝对语义 1.0/0.5/0.0，见 LLMRelevanceScorer）。
 * simple 为启发式重排，只用于定序，不再改写对外分数。
 */
export const DEFAULT_RERANK_MODEL: 'llm' | 'simple' = 'llm';

/**
 * 最低语义检索分数阈值
 */
export const MIN_SEMANTIC_SCORE = 0.2;

/**
 * 最低关键词检索分数阈值
 */
export const MIN_KEYWORD_SCORE = 0.1;

/**
 * 最低混合检索分数阈值
 */
export const MIN_HYBRID_SCORE = 0.15;

/**
 * 重排序最低分数阈值
 */
export const MIN_RERANK_SCORE = 0.1;

// ============ 混合检索配置 ============

/**
 * 默认语义检索权重
 */
export const DEFAULT_SEMANTIC_WEIGHT = 0.7;

/**
 * 默认关键词检索权重
 */
export const DEFAULT_KEYWORD_WEIGHT = 0.3;

/**
 * 最小权重值
 */
export const MIN_WEIGHT = 0.0;

/**
 * 最大权重值
 */
export const MAX_WEIGHT = 1.0;

/**
 * 权重总和容差（允许的浮点数误差）
 */
export const WEIGHT_TOLERANCE = 0.01;

// ============ 关键词提取配置 ============

/**
 * 关键词提取最大数量
 */
export const MAX_KEYWORDS_TO_EXTRACT = 5;

/**
 * 关键词最小长度
 */
export const MIN_KEYWORD_LENGTH = 2;

/**
 * 关键词提取最小结果数（少于此时不提取关键词）
 */
export const MIN_RESULTS_FOR_KEYWORD_EXTRACTION = 3;

// ============ 查询扩展配置 ============

/**
 * 是否默认启用查询扩展
 */
export const DEFAULT_ENABLE_QUERY_EXPANSION = false;

/**
 * 是否默认启用多阶段召回
 */
export const DEFAULT_ENABLE_MULTI_STAGE = true;

/**
 * 查询扩展词数量限制
 */
export const MAX_EXPANDED_QUERY_LENGTH = 200;

// ============ HyDE 配置 ============

/**
 * 是否默认启用 HyDE
 */
export const DEFAULT_ENABLE_HYDE = false;

/**
 * HyDE 默认 LLM 模型
 */
export const DEFAULT_HYDE_LLM_MODEL = "gpt-4o-mini";

/**
 * HyDE 假设答案最小长度（词数）
 */
export const MIN_HYDE_ANSWER_LENGTH = 100;

/**
 * HyDE 假设答案最大长度（词数）
 */
export const MAX_HYDE_ANSWER_LENGTH = 250;

/**
 * HyDE 生成温度参数（较低温度保证稳定性）
 */
export const HYDE_TEMPERATURE = 0.3;

/**
 * HyDE 生成最大 token 数
 */
export const HYDE_MAX_TOKENS = 500;

// ============ 多查询检索配置 ============

/**
 * 是否默认启用多查询检索
 */
export const DEFAULT_ENABLE_MULTI_QUERY = false;

/**
 * 多查询检索默认变体数量
 */
export const DEFAULT_MULTI_QUERY_VARIATIONS = 3;

/**
 * 多查询检索最小变体数量
 */
export const MIN_MULTI_QUERY_VARIATIONS = 1;

/**
 * 多查询检索最大变体数量
 */
export const MAX_MULTI_QUERY_VARIATIONS = 10;

/**
 * 多查询检索推荐变体数量
 */
export const RECOMMENDED_MULTI_QUERY_VARIATIONS = 3;

/**
 * 多查询生成温度参数（中等温度保证多样性）
 */
export const MULTI_QUERY_TEMPERATURE = 0.4;

/**
 * 多查询生成最大 token 数
 */
export const MULTI_QUERY_MAX_TOKENS = 300;

/**
 * 多查询检索默认 LLM 模型
 */
export const DEFAULT_MULTI_QUERY_LLM_MODEL = "gpt-4o-mini";

// ============ 重排序配置 ============

/**
 * 是否默认启用重排序
 */
export const DEFAULT_ENABLE_RERANK = true;

/**
 * 默认重排序 topK
 */
export const DEFAULT_RERANK_TOP_K = 20;

/**
 * 重排序模型类型
 */
export type RerankModel = "mastra" | "cohere" | "zeroentropy" | "simple";

// ============ 搜索类型 ============

/**
 * 支持的搜索类型
 */
export type SearchType = "semantic" | "keyword" | "hybrid";

/**
 * 默认搜索类型
 */
export const DEFAULT_SEARCH_TYPE: SearchType = "hybrid";

// ============ 错误消息 ============

/**
 * 搜索相关错误消息
 */
export const SEARCH_ERROR_MESSAGES = {
  KNOWLEDGE_BASE_NOT_FOUND: "Knowledge base not found",
  SEARCH_FAILED: "Failed to search",
  INVALID_SEARCH_TYPE: "Invalid search type",
  INVALID_RECALL_CONFIG: "Invalid recall configuration",
  MULTI_STAGE_SEMANTIC_ONLY:
    "Multi-stage recall only supports semantic search type",
  INVALID_WEIGHTS: "Invalid hybrid search weights",
  TOP_K_TOO_SMALL: "topK must be at least 1",
  TOP_K_TOO_LARGE: `topK must not exceed ${MAX_RECALL_TOP_K / RECALL_MULTIPLIER}`,
  RECALL_TOP_K_INVALID: `recallTopK must be between ${MIN_RECALL_TOP_K} and ${MAX_RECALL_TOP_K}`,
  NO_RESULTS_FOUND: "No results found matching your query",
  LOW_QUALITY_RESULTS: "Low quality results, please try a different query",
} as const;

// ============ 性能配置 ============

/**
 * 慢查询阈值（毫秒）
 */
export const SLOW_QUERY_THRESHOLD = 100;

/**
 * 关键词回退查询最大数量
 */
export const FALLBACK_QUERY_LIMIT = 1000;

/**
 * 批量操作大小
 */
export const BATCH_SIZE = 100;
