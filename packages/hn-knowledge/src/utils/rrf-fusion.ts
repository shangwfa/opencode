import type { SearchResultItem } from '../rag/knowledge-base/index.js'

/**
 * Reciprocal Rank Fusion (RRF) 融合算法
 *
 * RRF 是 2025 年混合检索的业界标准融合方法
 * 参考: https://www.paradedb.com/learn/search-concepts/reciprocal-rank-fusion
 *
 * 优势:
 * 1. 只依赖排名，不依赖分数绝对值
 * 2. 对异常分数鲁棒
 * 3. 实现简单，只需一个参数 k
 * 4. 公平对待不同检索器的结果
 *
 * @param resultsList 多个检索器的结果列表
 * @param k RRF 参数，默认 60（来自原始论文）
 * @returns 融合后的结果列表
 */
export function reciprocalRankFusion(
  resultsList: SearchResultItem[][],
  k: number = 60
): SearchResultItem[] {
  // 用于存储每个文档的累加 RRF 分数和原始数据
  const scoreMap = new Map<string, { score: number; data: SearchResultItem }>()

  // 遍历每个检索器的结果列表
  for (const results of resultsList) {
    // 根据排名计算 RRF 分数（从 0 开始）
    for (let rank = 0; rank < results.length; rank++) {
      const doc = results[rank]

      // RRF 公式: score = 1 / (k + rank + 1)
      // rank=0 → 1/(k+1), rank=1 → 1/(k+2), ...
      const rrfScore = 1 / (k + rank + 1)

      // 累加该文档的 RRF 分数
      // 如果同一个文档出现在多个检索结果中，优先保留有 text 字段的版本
      // 同时优先保留有完整 metadata 的版本
      const existing = scoreMap.get(doc.id)
      if (existing) {
        existing.score += rrfScore
        // 如果新文档有 text 而旧文档没有，更新数据
        // 或者新文档有更完整的 metadata（包含 docUrl 等关键字段）
        const newHasBetterMetadata = doc.metadata && 
          (doc.metadata.docUrl || doc.metadata.docName) &&
          (!existing.data.metadata || (!existing.data.metadata.docUrl && !existing.data.metadata.docName))
        if ((!existing.data.text && doc.text) || newHasBetterMetadata) {
          existing.data = doc
        }
      } else {
        scoreMap.set(doc.id, { score: rrfScore, data: doc })
      }
    }
  }

  // 按 RRF 分数降序排序
  const mergedResults = Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map(item => ({
      ...item.data,
      score: item.score // 用 RRF 分数替换原始分数
    }))

  return mergedResults
}

/**
 * RRF 融合（支持自定义权重）
 *
 * 允许为不同检索器设置不同权重
 * 例如：语义检索权重 0.6，关键词检索权重 0.4
 *
 * @param resultsAndWeights 包含结果列表和权重的数组
 * @param k RRF 参数，默认 60
 * @returns 融合后的结果列表
 */
export function weightedReciprocalRankFusion(
  resultsAndWeights: Array<{ results: SearchResultItem[]; weight: number }>,
  k: number = 60
): SearchResultItem[] {
  const scoreMap = new Map<string, { score: number; data: SearchResultItem }>()

  // 遍历每个检索器的结果列表
  for (const { results, weight } of resultsAndWeights) {
    for (let rank = 0; rank < results.length; rank++) {
      const doc = results[rank]

      // 加权的 RRF 分数
      const rrfScore = weight / (k + rank + 1)

      // 如果同一个文档出现在多个检索结果中，优先保留有 text 字段的版本
      // 同时优先保留有完整 metadata 的版本
      const existing = scoreMap.get(doc.id)
      if (existing) {
        existing.score += rrfScore
        // 如果新文档有 text 而旧文档没有，更新数据
        // 或者新文档有更完整的 metadata（包含 docUrl 等关键字段）
        const newHasBetterMetadata = doc.metadata && 
          (doc.metadata.docUrl || doc.metadata.docName) &&
          (!existing.data.metadata || (!existing.data.metadata.docUrl && !existing.data.metadata.docName))
        if ((!existing.data.text && doc.text) || newHasBetterMetadata) {
          existing.data = doc
        }
      } else {
        scoreMap.set(doc.id, { score: rrfScore, data: doc })
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map(item => ({
      ...item.data,
      score: item.score
    }))
}

/**
 * RRF 融合（支持分数阈值过滤）
 *
 * 在融合前过滤低分结果，提升融合质量
 *
 * @param resultsList 多个检索器的结果列表
 * @param k RRF 参数
 * @param minScores 每个检索器的最低分数阈值
 * @returns 融合后的结果列表
 */
export function reciprocalRankFusionWithThreshold(
  resultsList: SearchResultItem[][],
  k: number = 60,
  minScores?: number[]
): SearchResultItem[] {
  // 应用分数阈值过滤
  const filteredResults = resultsList.map((results, index) => {
    const minScore = minScores?.[index]
    if (minScore === undefined) return results
    return results.filter(r => r.score >= minScore)
  })

  // 使用 RRF 融合
  return reciprocalRankFusion(filteredResults, k)
}

/**
 * 混合融合策略（RRF + 加权）
 *
 * 结合 RRF 和加权的优势：
 * 1. 使用 RRF 保证排名公平性
 * 2. 使用权重调整检索器重要性
 *
 * @param resultsAndWeights 包含结果列表和权重的数组
 * @param k RRF 参数，默认 60
 * @returns 融合后的结果列表
 */
export function hybridRankFusion(
  resultsAndWeights: Array<{ results: SearchResultItem[]; weight: number }>,
  k: number = 60
): SearchResultItem[] {
  // 使用加权 RRF
  return weightedReciprocalRankFusion(resultsAndWeights, k)
}
