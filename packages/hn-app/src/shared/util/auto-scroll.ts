/**
 * 聊天时间线的「贴底」滚动策略。
 *
 * 直接对底部锚点调用 `scrollIntoView` 会在每次流式增量时强制贴底，
 * 用户想往上翻看历史会被立刻拉回（长回答时几乎无法阅读）。
 * 同类产品（ChatGPT / Claude / Slack）的通用做法是 stick-to-bottom：
 *  - 仅当用户本来就在底部附近时才自动跟随新内容；
 *  - 用户主动上滚后停止跟随，并提供一个「回到底部」入口。
 */

/** 距离底部多少像素以内仍视为「贴在底部」。 */
export const NEAR_BOTTOM_THRESHOLD = 64

export type ScrollMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** 用户当前是否贴着底部（含阈值容差）。 */
export function isNearBottom(metrics: ScrollMetrics, threshold = NEAR_BOTTOM_THRESHOLD): boolean {
  const { scrollTop, scrollHeight, clientHeight } = metrics
  if (!Number.isFinite(scrollTop) || !Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return true
  // 内容不足一屏时永远算贴底，否则会误判为「用户上滚了」。
  if (scrollHeight <= clientHeight) return true
  return scrollHeight - clientHeight - scrollTop <= threshold
}

/** 是否还有可滚动空间（决定要不要显示「回到底部」）。 */
export function hasOverflow(metrics: ScrollMetrics): boolean {
  return Number.isFinite(metrics.scrollHeight) && Number.isFinite(metrics.clientHeight)
    ? metrics.scrollHeight > metrics.clientHeight + 1
    : false
}

/** 需要跟随新内容时，目标 scrollTop 直接取最大值（不做平滑动画，避免流式抖动）。 */
export function bottomScrollTop(metrics: Pick<ScrollMetrics, "scrollHeight">): number {
  return Math.max(0, metrics.scrollHeight)
}
