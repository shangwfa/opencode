import type { Triplet } from '../types.js'

/**
 * 边转文本工具（对标 cognee resolve_edges_to_text.py）
 *
 * 将检索到的三元组拼接为人类可读文本：
 * - 实体描述补充
 * - Top-N 高频词生成标题
 */

/**
 * 将三元组列表转为可读文本
 */
export function resolveTripletsToText(
  triplets: Triplet[],
  options?: { includeDescriptions?: boolean; maxTriplets?: number }
): string {
  const { includeDescriptions = true, maxTriplets = 20 } = options || {}

  const lines: string[] = []
  for (const t of triplets.slice(0, maxTriplets)) {
    const desc =
      includeDescriptions && t.source.properties?.description
        ? `（${t.source.properties.description}）`
        : ''
    lines.push(`${t.source.name}${desc} ${t.relation} ${t.target.name}`)
  }
  return lines.join('\n')
}

/**
 * 生成文本标题：取实体名中的 Top-N 高频词
 */
export function generateTitleFromTriplets(triplets: Triplet[], topN = 3): string {
  const freq = new Map<string, number>()
  for (const t of triplets) {
    freq.set(t.source.name, (freq.get(t.source.name) || 0) + 1)
    freq.set(t.target.name, (freq.get(t.target.name) || 0) + 1)
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([name]) => name)
    .join(' / ')
}

/**
 * 完整格式化：标题 + 正文
 */
export function formatTripletsAsContext(triplets: Triplet[], options?: {
  includeDescriptions?: boolean
  maxTriplets?: number
  withTitle?: boolean
}): string {
  const { withTitle = true } = options || {}
  const body = resolveTripletsToText(triplets, options)
  if (!withTitle || triplets.length === 0) return body
  const title = generateTitleFromTriplets(triplets)
  return `【${title}】\n${body}`
}